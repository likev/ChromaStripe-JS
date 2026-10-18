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
        // Hashed assets in assets/ are immutable; only revalidate HTML navigations & non-hashed files
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
          const cleanPath = url.pathname.replace(/\\/$/, '');
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
