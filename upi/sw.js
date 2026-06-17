// UPI Budget Boss — Service Worker
// Handles offline caching and app-shell precaching for installability.

const CACHE_VERSION = 'ubb-v1';
const CACHE_NAME = `upi-budget-boss-${CACHE_VERSION}`;

// App-shell files to precache so the app works fully offline.
// Adjust paths if you deploy index.html and /pwa/ at different locations.
const PRECACHE_URLS = [
  './index.html',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg',
  './icon-maskable-192.svg',
  './icon-maskable-512.svg'
];

/* ---------- Install: precache the app shell ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

/* ---------- Activate: clean up old cache versions ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('upi-budget-boss-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/* ---------- Fetch: cache-first for app shell, network-first fallback ----------
   Strategy:
   - Same-origin GET requests: try cache first (fast, works offline),
     fall back to network, and opportunistically update the cache.
   - Navigation requests that fail offline fall back to the cached index.html
     so deep links / refreshes still load the app shell.
*/
self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin requests pass through normally

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // Revalidate in the background so the cache stays fresh.
        fetch(request).then((fresh) => {
          if (fresh && fresh.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, fresh));
          }
        }).catch(() => { /* offline: ignore, cached version already served */ });
        return cached;
      }

      return fetch(request)
        .then((fresh) => {
          if (fresh && fresh.ok) {
            const copy = fresh.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return fresh;
        })
        .catch(() => {
          // Offline and not cached: for page navigations, fall back to the app shell.
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('', { status: 503, statusText: 'Offline' });
        });
    })
  );
});
