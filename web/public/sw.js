/**
 * ChromaStripe-JS Service Worker
 * Provides 100% offline support for air-gapped optical file transmission.
 */

const CACHE_NAME = 'chromastripe-cache-v1';

// Essential assets to cache on install (dev baseline)
const PRECACHE_ASSETS = [
  './',
  'index.html',
  'send.html',
  'receive.html',
  'sim.html',
  'manifest.webmanifest',
  'manifest.json',
  'favicon.ico',
  'favicon.svg',
  'apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'icons/icon.svg',
  'css/app.css',
  'js/pwa.js',
  'js/ui.js',
  'js/tx-render.js',
  'js/send-app.js',
  'js/receive-app.js',
  'js/rx-worker.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.all(
        PRECACHE_ASSETS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: 'reload' });
            if (res && res.status === 200) {
              await cache.put(url, res);
            }
          } catch (e) {
            // Silently ignore individual missing dev assets
          }
        })
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key.startsWith('chromastripe-')) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // 1. Check cache ignoring search params (handles ?source=file, ?debug=1, etc.)
      const cached = await cache.match(event.request, { ignoreSearch: true });

      if (cached) {
        // Stale-While-Revalidate: fetch in background to refresh cache if online
        if (event.request.mode === 'navigate' || !url.pathname.includes('/assets/')) {
          event.waitUntil(
            fetch(event.request)
              .then((networkRes) => {
                if (networkRes && networkRes.status === 200) {
                  cache.put(event.request, networkRes.clone());
                }
              })
              .catch(() => {})
          );
        }
        return cached;
      }

      // 2. Not in cache: fetch from network and store successful response
      try {
        const response = await fetch(event.request);
        if (response && response.status === 200) {
          cache.put(event.request, response.clone());
        }
        return response;
      } catch (err) {
        // Network failed (offline / air-gapped)
        // For HTML navigation requests, support clean URLs and fallback to index
        if (event.request.mode === 'navigate') {
          const cleanPath = url.pathname.replace(/\/$/, '');
          const htmlCandidate = cleanPath.endsWith('.html') ? cleanPath : cleanPath + '.html';
          const fileOnly = htmlCandidate.split('/').pop();

          const fallback = await cache.match(event.request, { ignoreSearch: true }) ||
                           await cache.match(htmlCandidate, { ignoreSearch: true }) ||
                           await cache.match(fileOnly, { ignoreSearch: true }) ||
                           await cache.match('index.html', { ignoreSearch: true }) ||
                           await cache.match('./', { ignoreSearch: true });
          if (fallback) return fallback;
        }
        throw err;
      }
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
