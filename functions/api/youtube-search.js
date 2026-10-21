// Cloudflare Pages Function: GET /api/youtube-search?q=...
//
// Optional fallback search via YouTube Data API v3. The key never reaches
// the browser. Quota note: search.list costs 100 units and the free daily
// quota is 10,000 units (~100 searches/day), so responses are cached at the
// edge for 24h and guests only hit this when they press "Search YouTube".
//
// Configure: Cloudflare Pages → Settings → Environment variables →
//   YOUTUBE_API_KEY (type: Secret). Locally: put it in .dev.vars.

const CACHE_TTL_SECONDS = 60 * 60 * 24;

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

  // Normalised cache key so "Queen", "queen " share one cached response.
  const cacheKey = new Request(
    `https://cache.internal/yt-search?q=${encodeURIComponent(query.toLowerCase())}`,
  );
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

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
    const status = res.status === 403 ? 503 : 502;   // 403 = quota exhausted / bad key
    return json({ error: 'youtube_unavailable', items: [] }, status);
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

  const response = json({ items }, 200, { 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` });
  waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

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
