// Cloudflare Pages Function: GET /api/youtube-search?q=...&karaoke=1
//
// Song search:
//  - q is a YouTube link → looked up with YouTube's public oEmbed endpoint
//    (no API key, no quota).
//  - Otherwise the official YouTube Data API v3 search.list (100 quota units
//    of the free 10,000/day).
//  - Once the API says today's quota is used up, a flag in KV switches
//    everyone to backup search until the quota resets (midnight Pacific).
//    The flag expires at that moment, so the API is used again by itself.
//    Backup search asks youtube.com's own web search (the request its search
//    page makes) and keeps only videos that allow embedding. It is not an
//    official API — YouTube can change or block it at any time, and using it
//    is against YouTube's Terms of Service — so it is only a fallback.
//    (mode=scrape forces it, for testing.)
//
// Results are cached 7 days in Workers KV (binding SEARCH_CACHE), shared
// worldwide, so repeat searches are free either way.
//
// Configure: YOUTUBE_API_KEY as a Pages secret; KV binding in wrangler.toml.

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;
const QUOTA_FLAG_KEY = 'quota-exhausted-until';
const WEB_CLIENT_VERSION = '2.20241010.00.00';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

export async function onRequestGet({ request, env, waitUntil }) {
  const params = new URL(request.url).searchParams;
  const q = (params.get('q') ?? '').trim().slice(0, 200);
  if (q.length < 2) return json({ items: [] });

  // Pasted link → single result, free.
  const linkedId = videoIdFromText(q);
  if (linkedId) {
    const item = await oembedLookup(linkedId);
    return item
      ? json({ items: [item], source: 'link' })
      : json({ items: [], source: 'link', error: 'not_embeddable' });
  }

  const forceBackup = params.get('mode') === 'scrape';   // testing only
  // "Prioritize karaoke versions" switch (default on).
  const karaoke = params.get('karaoke') !== '0';
  const query = karaoke && !/karaoke/i.test(q) ? `${q} karaoke` : q;
  // Normalised so "Queen", " queen  " share one cached response.
  const normalized = query.toLowerCase().replace(/\s+/g, ' ');

  // 1. Official API (unless today's quota is known to be used up).
  if (!forceBackup) {
    const apiKey = `yt-search:${normalized}`;
    const cached = await cacheGet(env, apiKey);
    if (cached) return json({ ...cached, source: 'api' }, 200, { 'X-Cache': 'HIT' });
    if (!env.YOUTUBE_API_KEY) return json({ error: 'not_configured', items: [] }, 501);
    if (!(await quotaExhausted(env))) {
      const result = await apiSearch(query, env.YOUTUBE_API_KEY);
      if (!result.error) {
        if (result.items.length) waitUntil(cachePut(env, apiKey, { items: result.items }));
        return json({ items: result.items, source: 'api' }, 200, { 'X-Cache': 'MISS' });
      }
      if (result.error !== 'quota_exceeded') return json({ error: result.error, items: [] }, result.status);
      waitUntil(markQuotaExhausted(env));
    }
  }

  // 2. Backup search (quota used up, or forced for testing).
  const fallback = !forceBackup;
  const backupKey = `yt-scrape:${normalized}`;
  const cachedBackup = await cacheGet(env, backupKey);
  if (cachedBackup) {
    return json({ ...cachedBackup, source: 'scrape', fallback }, 200, { 'X-Cache': 'HIT' });
  }
  let items;
  try {
    items = await scrapeSearch(query);
  } catch (err) {
    return json({ error: 'backup_failed', detail: String(err.message ?? err), items: [] }, 502);
  }
  if (items.length) waitUntil(cachePut(env, backupKey, { items }));
  return json({ items, source: 'scrape', fallback }, 200, { 'X-Cache': 'MISS' });
}

// ------------------------------------------------------------- quota flag

/** True while the API's daily quota is known to be used up. */
async function quotaExhausted(env) {
  if (!env.SEARCH_CACHE) return false;
  const until = Number(await env.SEARCH_CACHE.get(QUOTA_FLAG_KEY));
  return until > Date.now();
}

/** Remember "quota used up" until it resets at the next midnight Pacific. */
function markQuotaExhausted(env) {
  if (!env.SEARCH_CACHE) return null;
  const seconds = secondsUntilPacificMidnight();
  return env.SEARCH_CACHE.put(QUOTA_FLAG_KEY, String(Date.now() + seconds * 1000), {
    expirationTtl: Math.max(60, seconds),   // KV minimum TTL is 60s
  });
}

function secondsUntilPacificMidnight() {
  const [h, m, s] = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  })
    .format(new Date())
    .split(':')
    .map(Number);
  return (24 - h) * 3600 - m * 60 - s;
}

// ------------------------------------------------------------- official API

async function apiSearch(query, apiKey) {
  const api = new URL('https://www.googleapis.com/youtube/v3/search');
  api.search = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',   // only videos the IFrame player can actually play
    maxResults: '10',
    safeSearch: 'moderate',
    q: query,
    key: apiKey,
  });
  const res = await fetch(api);
  if (!res.ok) {
    // 403 + quotaExceeded = today's searches are used up (resets at midnight PT).
    const body = await res.json().catch(() => ({}));
    const reason = body?.error?.errors?.[0]?.reason ?? '';
    if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/i.test(reason)) {
      return { error: 'quota_exceeded', status: 429 };
    }
    return { error: 'youtube_unavailable', status: 502 };
  }
  const data = await res.json();
  return {
    items: (data.items ?? [])
      .filter((it) => it.id?.videoId)
      .map((it) => ({
        videoId: it.id.videoId,
        title: decodeEntities(it.snippet.title),
        channel: decodeEntities(it.snippet.channelTitle),
        thumbnail: it.snippet.thumbnails?.default?.url ?? null,
      })),
  };
}

// ------------------------------------------------------------- backup search

/** youtube.com's own web search → up to 10 embeddable videos. */
async function scrapeSearch(query) {
  let found;
  try {
    found = await innertubeSearch(query);
  } catch {
    found = [];
  }
  if (!found.length) found = await resultsPageSearch(query);   // second route
  if (!found.length) throw new Error('no results parsed');
  return filterEmbeddable(found.slice(0, 15), 10);
}

/** The JSON request youtube.com's search page makes. */
async function innertubeSearch(query) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://www.youtube.com',
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': WEB_CLIENT_VERSION,
    },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: WEB_CLIENT_VERSION, hl: 'en', gl: 'US' } },
      query,
      params: 'EgIQAQ%3D%3D',   // filter: videos only
    }),
  });
  if (!res.ok) throw new Error(`innertube ${res.status}`);
  return collectVideos(await res.json());
}

/** Fallback: the search results HTML page, which embeds the same JSON. */
async function resultsPageSearch(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D&hl=en&gl=US`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: 'CONSENT=YES+1; SOCS=CAI',   // skip the EU cookie-consent interstitial
    },
  });
  if (!res.ok) throw new Error(`results page ${res.status}`);
  const html = await res.text();
  const match = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
  if (!match) throw new Error('results page: no data');
  return collectVideos(JSON.parse(match[1]));
}

/** Walk YouTube's response JSON and pull out every videoRenderer. */
function collectVideos(root) {
  const out = [];
  const seen = new Set();
  const stack = [root];
  while (stack.length && out.length < 25) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const vr = node.videoRenderer;
    if (vr?.videoId && !seen.has(vr.videoId)) {
      seen.add(vr.videoId);
      out.push({
        videoId: vr.videoId,
        title: textOf(vr.title),
        channel: textOf(vr.ownerText) || textOf(vr.longBylineText) || textOf(vr.shortBylineText),
        thumbnail: `https://i.ytimg.com/vi/${vr.videoId}/default.jpg`,
        order: out.length,
      });
    }
    // Push children in reverse so results come out in page order.
    const children = Array.isArray(node) ? node : Object.values(node);
    for (let i = children.length - 1; i >= 0; i--) {
      if (children[i] && typeof children[i] === 'object') stack.push(children[i]);
    }
  }
  return out.sort((a, b) => a.order - b.order).map(({ order, ...v }) => v);
}

const textOf = (t) => (t?.simpleText ?? t?.runs?.map((r) => r.text).join('') ?? '').trim();

/**
 * Keep only videos whose owners allow embedding (others would just fail on
 * the TV). Checked with oEmbed, which refuses non-embeddable videos. If
 * oEmbed itself is unreachable, don't filter rather than return nothing.
 */
async function filterEmbeddable(videos, limit) {
  const checks = await Promise.all(
    videos.map(async (v) => {
      try {
        const res = await fetch(oembedUrl(v.videoId));
        return res.ok ? 'ok' : res.status === 401 || res.status === 403 ? 'blocked' : 'unknown';
      } catch {
        return 'unknown';
      }
    }),
  );
  if (checks.every((c) => c === 'unknown')) return videos.slice(0, limit);
  return videos.filter((_, i) => checks[i] !== 'blocked').slice(0, limit);
}

// ------------------------------------------------------------- pasted links

const oembedUrl = (id) =>
  `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;

/** Title/channel for one video via oEmbed (null if missing or not embeddable). */
async function oembedLookup(id) {
  const res = await fetch(oembedUrl(id));
  if (!res.ok) return null;
  const data = await res.json();
  return {
    videoId: id,
    title: data.title ?? 'YouTube video',
    channel: data.author_name ?? '',
    thumbnail: `https://i.ytimg.com/vi/${id}/default.jpg`,
  };
}

/** Video ID from a pasted YouTube link (watch, youtu.be, shorts, embed, music). */
function videoIdFromText(text) {
  const m = text.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/,
  );
  return m ? m[1] : null;
}

// ------------------------------------------------------------- cache

async function cacheGet(env, key) {
  if (env.SEARCH_CACHE) return env.SEARCH_CACHE.get(key, 'json');
  const hit = await caches.default.match(edgeKey(key));
  return hit ? hit.json() : null;
}

async function cachePut(env, key, value) {
  if (env.SEARCH_CACHE) {
    return env.SEARCH_CACHE.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_SECONDS });
  }
  return caches.default.put(
    edgeKey(key),
    json(value, 200, { 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` }),
  );
}

const edgeKey = (key) => new Request(`https://cache.internal/${encodeURIComponent(key)}`);

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

// The Data API returns HTML-escaped titles ("Don&#39;t Stop Me Now").
function decodeEntities(s = '') {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
