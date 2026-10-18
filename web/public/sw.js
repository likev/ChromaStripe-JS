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
  '404.html',
  'send',
  'receive',
  'sim',
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

/**
 * Strips redirected flag from response to satisfy Service Worker Fetch spec
 * which prohibits returning redirected responses to 'navigate' mode requests.
 */
async function cleanResponse(response) {
  if (!response || !response.redirected) {
    return response;
  }
  const body = await response.blob();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers)
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.all(
        PRECACHE_ASSETS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: 'reload' });
            if (res && res.status === 200) {
              const clean = await cleanResponse(res);
              await cache.put(url, clean.clone());

              // Alias HTML routes to clean routes and vice versa
              if (url.endsWith('.html')) {
                const cleanRoute = url.slice(0, -5);
                if (cleanRoute === 'index') {
                  await cache.put('./', clean.clone());
                } else if (cleanRoute !== '404') {
                  await cache.put(cleanRoute, clean.clone());
                }
              } else if (!url.includes('.') && url !== './') {
                await cache.put(url + '.html', clean.clone());
              }
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

async function matchCandidate(cache, request, url) {
  // 1. Direct match with ignoreSearch
  let cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cleanResponse(cached);

  // 2. Candidate variations for clean URLs, subpaths, and .html extensions
  const cleanPath = url.pathname.replace(/\/$/, '');
  const lastSegment = cleanPath.split('/').pop() || '';

  const candidates = [];
  if (cleanPath.endsWith('.html')) {
    candidates.push(cleanPath);
    candidates.push(lastSegment);
    candidates.push(lastSegment.replace(/\.html$/, ''));
  } else if (lastSegment) {
    candidates.push(cleanPath);
    candidates.push(lastSegment);
    candidates.push(lastSegment + '.html');
    candidates.push(`${cleanPath}.html`);
  }

  candidates.push('./');
  candidates.push('index.html');

  for (const candidate of candidates) {
    if (!candidate) continue;
    cached = await cache.match(candidate, { ignoreSearch: true });
    if (cached) return cleanResponse(cached);
  }

  return null;
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // 1. Check cache ignoring search params & matching clean URL candidates
      const cached = await matchCandidate(cache, event.request, url);

      if (cached) {
        // Stale-While-Revalidate: fetch in background to refresh cache if online
        if (event.request.mode === 'navigate' || !url.pathname.includes('/assets/')) {
          event.waitUntil(
            fetch(event.request)
              .then(async (networkRes) => {
                if (networkRes && networkRes.status === 200) {
                  const cleanRes = await cleanResponse(networkRes);
                  await cache.put(event.request, cleanRes);
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
          const cleanRes = await cleanResponse(response);
          await cache.put(event.request, cleanRes.clone());
          return cleanRes;
        }
        return response;
      } catch (err) {
        // Network failed (offline / air-gapped)
        // For HTML navigation requests, support clean URLs and fallback to index
        if (event.request.mode === 'navigate') {
          const fallback = await matchCandidate(cache, event.request, url);
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
