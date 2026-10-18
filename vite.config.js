import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * ChromaStripe PWA Plugin
 * Generates an optimized production Service Worker (dist/sw.js)
 * caching all emitted assets, pages, styles, scripts, and Web Workers.
 */
function chromaStripePwaPlugin() {
  let resolvedConfig;
  return {
    name: 'chromastripe-pwa',
    configResolved(config) {
      resolvedConfig = config;
    },
    closeBundle() {
      if (resolvedConfig.command !== 'build') return;

      const outDir = resolvedConfig.build.outDir;
      if (!fs.existsSync(outDir)) return;

      // Collect all emitted production files
      function collectFiles(dir, baseDir = dir) {
        let results = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            results = results.concat(collectFiles(fullPath, baseDir));
          } else if (entry.isFile()) {
            const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
            if (rel !== 'sw.js' && !rel.endsWith('.map')) {
              results.push(rel);
            }
          }
        }
        return results;
      }

      const files = collectFiles(outDir);
      const precacheSet = new Set(['./', ...files]);
      for (const file of files) {
        if (file.endsWith('.html')) {
          const cleanRoute = file.slice(0, -5);
          if (cleanRoute !== 'index') {
            precacheSet.add(cleanRoute);
          }
        }
      }
      const precacheList = Array.from(precacheSet).sort();

      // Compute hash of file contents for cache busting
      const hash = crypto.createHash('sha256');
      for (const file of precacheList) {
        if (file === './') continue;
        const filePath = path.join(outDir, file);
        if (fs.existsSync(filePath)) {
          hash.update(file);
          hash.update(fs.readFileSync(filePath));
        }
      }
      const versionTag = hash.digest('hex').slice(0, 10);
      const cacheName = `chromastripe-v${versionTag}`;

      const swContent = `/**
 * ChromaStripe-JS Production Service Worker
 * Generated automatically by Vite build pipeline.
 * Offline Air-Gapped Optical Modem PWA.
 */

const CACHE_NAME = ${JSON.stringify(cacheName)};
const PRECACHE_ASSETS = ${JSON.stringify(precacheList, null, 2)};

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
                } else {
                  await cache.put(cleanRoute, clean.clone());
                }
              } else if (!url.includes('.') && url !== './') {
                await cache.put(url + '.html', clean.clone());
              }
            }
          } catch (e) {
            // Silently ignore individual optional asset failure
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
  const cleanPath = url.pathname.replace(/\\/$/, '');
  const lastSegment = cleanPath.split('/').pop() || '';

  const candidates = [];
  if (cleanPath.endsWith('.html')) {
    candidates.push(cleanPath);
    candidates.push(lastSegment);
    candidates.push(lastSegment.replace(/\\.html$/, ''));
  } else if (lastSegment) {
    candidates.push(cleanPath);
    candidates.push(lastSegment);
    candidates.push(lastSegment + '.html');
    candidates.push(\`\${cleanPath}.html\`);
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
        // Hashed assets in assets/ are immutable; only revalidate HTML navigations & non-hashed files
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
`;

      const swDest = path.join(outDir, 'sw.js');
      fs.writeFileSync(swDest, swContent, 'utf-8');
      console.log(`\n✓ [PWA] Service worker generated in dist/sw.js (${cacheName}) with ${precacheList.length} precached assets.`);
    }
  };
}

export default defineConfig({
  base: './',
  root: 'web',
  publicDir: resolve(__dirname, 'web/public'),
  plugins: [
    chromaStripePwaPlugin()
  ],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'web/index.html'),
        send: resolve(__dirname, 'web/send.html'),
        receive: resolve(__dirname, 'web/receive.html'),
        sim: resolve(__dirname, 'web/sim.html')
      }
    }
  },
  server: {
    fs: {
      allow: [resolve(__dirname)]
    }
  },
  worker: {
    format: 'es'
  }
});
