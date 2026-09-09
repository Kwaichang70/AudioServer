// AudioServer service worker (V08.1). Generated at build time from
// client/sw/sw.template.js: the Vite plugin fills in BUILD_ID and the exact
// list of hashed assets of this build. A developer build serves the plain
// network-only worker from client/public/sw.js instead.
//
// Rules this file keeps:
//   - The shell cache is pinned to one build. Its index.html only ever
//     references the assets that are cached next to it, so a new release
//     can never produce the old-HTML/new-assets white page.
//   - A new worker waits until the app says so (SKIP_WAITING); the page shows
//     "update ready" and reloads once, on controllerchange.
//   - Only caches named audioserver-* are ever deleted.
//   - API responses are never cached; the cover cache is capped.
//   - Offline navigation gets the cached shell, or offline.html. Neither
//     promises offline music: streams are not cached.

const BUILD_ID = '__BUILD_ID__';
const PRECACHE = __PRECACHE__;
const SHELL_CACHE = `audioserver-shell-${BUILD_ID}`;
const COVER_CACHE = 'audioserver-covers-v3';
const OWN_PREFIX = 'audioserver-';
const MAX_COVERS = 400;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        Promise.allSettled(
          PRECACHE.map((path) => cache.add(new Request(path, { cache: 'reload' }))),
        ),
      ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith(OWN_PREFIX) && k !== SHELL_CACHE && k !== COVER_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ buildId: BUILD_ID });
  }
});

async function coverResponse(request, url) {
  const cache = await caches.open(COVER_CACHE);
  const key = new URL(url);
  key.searchParams.delete('t'); // stream token rotates; the picture does not
  const keyStr = key.toString();
  const cached = await cache.match(keyStr);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(keyStr, response.clone());
      const keys = await cache.keys();
      if (keys.length > MAX_COVERS) {
        // Oldest first: Cache API keeps insertion order.
        await Promise.all(keys.slice(0, keys.length - MAX_COVERS).map((k) => cache.delete(k)));
      }
    }
    return response;
  } catch {
    return new Response('', { status: 503, statusText: 'offline' });
  }
}

async function navigationResponse(request) {
  try {
    return await fetch(request);
  } catch {
    const shell = await caches.match('/index.html');
    if (shell) return shell;
    const offline = await caches.match('/offline.html');
    if (offline) return offline;
    return new Response('AudioServer is offline and no app shell is cached yet.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

async function assetResponse(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(SHELL_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.match(/\/api\/library\/(albums|artists|tracks)\/[^/]+\/(cover|image)/)) {
    event.respondWith(coverResponse(request, url));
    return;
  }
  // Every other API call, streams included, goes straight to the network.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }
  if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(assetResponse(request));
  }
});
