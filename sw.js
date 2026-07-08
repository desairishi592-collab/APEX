// Bump this on any deploy that changes precached assets (icons, manifest.json) — it's the only
// thing that forces already-installed users to drop a stale cache. Relying on this alone is
// fragile (easy to forget, as happened here: the icon rebrand shipped without bumping it, so
// already-installed users kept the old cached icons indefinitely even after the server-side
// files changed). The fetch handler below now also uses stale-while-revalidate for static
// assets specifically so future asset changes self-heal within a reload or two without
// depending on anyone remembering to bump this string.
const CACHE_NAME = 'apex-cache-v2';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls — a cached stock quote or scan result would be actively
  // misleading. Also skip cross-origin requests (Finnhub isn't called from the client,
  // but this keeps the SW scoped to same-origin concerns only).
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }

  // App shell (HTML navigations): network-first, so logged-in users always get the
  // latest deployed index.html when online; falls back to the cached shell offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  // Same-origin static assets (icons, manifest): stale-while-revalidate, not pure cache-first.
  // Serves the cached copy immediately if there is one (fast, works offline), but always kicks
  // off a background fetch to refresh the cache for next time. Pure cache-first would mean an
  // asset that changes on the server (e.g. a new icon) never reaches an already-installed user
  // unless the service worker's own script bytes also happen to change on that same deploy — the
  // exact bug that let stale icons sit cached indefinitely. This makes asset updates self-heal
  // within a reload or two regardless of whether sw.js itself changed.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const refresh = fetch(event.request)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || refresh;
    })
  );
});
