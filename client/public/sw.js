// Service worker for AudioServer.
//
// Two recurring failure modes drove the rewrite of this file:
//   1. Stale-shell whiteouts. The old SW cached '/' on install. After a
//      deploy the asset filenames changed (Vite hashes them), so the cached
//      HTML referenced JS chunks that no longer existed → blank page.
//   2. Cover cache grew forever. Cache keys included the full request URL,
//      including the ?t=<stream-token> query param. The token refreshes
//      hourly, so every cover was re-cached every hour, never evicted.
//
// Fixes:
//   - Bump CACHE_VERSION on every SW-relevant change. Activation deletes
//     any caches that don't match the current version.
//   - Don't pre-cache '/'. Network-first, with offline fallback only if the
//     network call actually rejects (= we're offline).
//   - Normalise cover URLs by stripping ?t= before using them as cache keys.

const CACHE_VERSION = 'v2';
const CACHE_NAME = `audioserver-${CACHE_VERSION}`;
const COVER_CACHE = `audioserver-covers-${CACHE_VERSION}`;

self.addEventListener('install', () => {
  // No pre-cache: we rely on network-first below. skipWaiting takes the new
  // SW live on the next reload (and clients.claim() in activate covers the
  // currently-open tabs).
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME && k !== COVER_CACHE).map((k) => caches.delete(k)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Cover/artist-image cache. Drop the stream-token before keying so that
  // hourly token refreshes don't fragment the cache.
  if (url.pathname.match(/\/api\/library\/(albums|artists|tracks)\/[^/]+\/(cover|image)/)) {
    const cacheKey = new URL(url);
    cacheKey.searchParams.delete('t');
    const keyStr = cacheKey.toString();

    event.respondWith(
      caches.open(COVER_CACHE).then(async (cache) => {
        const cached = await cache.match(keyStr);
        if (cached) return cached;
        try {
          const response = await fetch(event.request);
          if (response.ok) cache.put(keyStr, response.clone());
          return response;
        } catch {
          return new Response('', { status: 404 });
        }
      }),
    );
    return;
  }

  // Everything else: prefer fresh from network. Fall back to cache only if
  // the network is unreachable. This is what prevents stale-shell whiteouts
  // — when the browser is online, it always sees the latest HTML and JS.
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
