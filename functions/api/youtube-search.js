// Cloudflare Pages Function: GET /api/youtube-search?q=...&karaoke=1
//
// Song search via YouTube Data API v3. The key never reaches the browser.
//
// Quota: search.list costs 100 units of the free 10,000/day (~100 searches/
// day for everyone), so results are cached for 7 days in Workers KV
// (binding SEARCH_CACHE, shared worldwide, expires on its own). YouTube's
// Developer Policies allow storing API data for up to 30 days. If the KV
// binding is missing, falls back to Cloudflare's per-location edge cache.
//
// Configure: Cloudflare Pages → Settings → Variables and Secrets →
//   YOUTUBE_API_KEY (type: Secret). Locally: put it in .dev.vars.
//   KV binding is declared in wrangler.toml.

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;

export async function onRequestGet({ request, env, waitUntil }) {
  if (!env.YOUTUBE_API_KEY) {
    return json({ error: 'not_configured', items: [] }, 501);
  }

  const params = new URL(request.url).searchParams;
  const q = (params.get('q') ?? '').trim().slice(0, 100);
  if (q.length < 2) return json({ items: [] });
  // "Prioritize karaoke versions" switch (default on).
  const karaoke = params.get('karaoke') !== '0';
  const query = karaoke && !/karaoke/i.test(q) ? `${q} karaoke` : q;

  // Normalised key so "Queen", " queen  " share one cached response.
  const key = `yt-search:${query.toLowerCase().replace(/\s+/g, ' ')}`;
  const cached = await cacheGet(env, key);
  if (cached) return json(cached, 200, { 'X-Cache': 'HIT' });

  const api = new URL('https://www.googleapis.com/youtube/v3/search');
  api.search = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',   // only videos the IFrame player can actually play
    maxResults: '10',
    safeSearch: 'moderate',
    q: query,
    key: env.YOUTUBE_API_KEY,
  });

  const res = await fetch(api);
  if (!res.ok) {
    // 403 + quotaExceeded = today's searches are used up (resets at midnight PT).
    const body = await res.json().catch(() => ({}));
    const reason = body?.error?.errors?.[0]?.reason ?? '';
    if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/i.test(reason)) {
      return json({ error: 'quota_exceeded', items: [] }, 429);
    }
    return json({ error: 'youtube_unavailable', items: [] }, 502);
  }

  const data = await res.json();
  const items = (data.items ?? [])
    .filter((it) => it.id?.videoId)
    .map((it) => ({
      videoId: it.id.videoId,
      title: decodeEntities(it.snippet.title),
      channel: decodeEntities(it.snippet.channelTitle),
      thumbnail: it.snippet.thumbnails?.default?.url ?? null,
    }));

  waitUntil(cachePut(env, key, { items }));
  return json({ items }, 200, { 'X-Cache': 'MISS' });
}

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
