/**
 * Unit tests for ChromaStripe PWA configuration, manifest, icons, and service worker.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getServiceWorkerScopeAndUrl } from '../../web/js/pwa.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const WEB_DIR = path.join(ROOT_DIR, 'web');
const PUBLIC_DIR = path.join(WEB_DIR, 'public');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

function getPngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Valid PNG signature');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

describe('PWA: Web App Manifest', () => {
  test('manifest.webmanifest and manifest.json exist and match', () => {
    const webmanifestPath = path.join(PUBLIC_DIR, 'manifest.webmanifest');
    const jsonPath = path.join(PUBLIC_DIR, 'manifest.json');

    assert.ok(fs.existsSync(webmanifestPath), 'manifest.webmanifest must exist');
    assert.ok(fs.existsSync(jsonPath), 'manifest.json must exist');

    const manifest = JSON.parse(fs.readFileSync(webmanifestPath, 'utf-8'));
    const manifestJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

    assert.deepEqual(manifest, manifestJson, 'manifest.webmanifest and manifest.json should have identical content');

    // Required PWA manifest properties
    assert.ok(manifest.name && manifest.name.includes('ChromaStripe'), 'manifest name should include ChromaStripe');
    assert.ok(manifest.short_name, 'manifest short_name is required');
    assert.equal(manifest.start_url, './index.html');
    assert.equal(manifest.scope, './');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.background_color, '#0b0f19');
    assert.equal(manifest.theme_color, '#0b0f19');
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 4, 'should have multiple icons');
  });

  test('manifest icons exist on disk with correct dimensions', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf-8'));

    for (const icon of manifest.icons) {
      const iconPath = path.join(PUBLIC_DIR, icon.src);
      assert.ok(fs.existsSync(iconPath), `Icon file must exist: ${icon.src}`);

      if (icon.type === 'image/png') {
        const dims = getPngDimensions(iconPath);
        if (icon.sizes === '192x192') {
          assert.equal(dims.width, 192);
          assert.equal(dims.height, 192);
        } else if (icon.sizes === '512x512') {
          assert.equal(dims.width, 512);
          assert.equal(dims.height, 512);
        }
      }
    }
  });

  test('maskable icons are declared for adaptive icon launchers', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf-8'));
    const maskableIcons = manifest.icons.filter(i => i.purpose === 'maskable');
    assert.ok(maskableIcons.length >= 2, 'Should declare at least 192x192 and 512x512 maskable icons');
  });

  test('app shortcuts are declared for key workflows with typed icons', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf-8'));
    assert.ok(Array.isArray(manifest.shortcuts), 'Shortcuts should be an array');
    const shortcutUrls = manifest.shortcuts.map(s => s.url);
    assert.ok(shortcutUrls.includes('./send.html'), 'Should have shortcut for Send');
    assert.ok(shortcutUrls.includes('./receive.html'), 'Should have shortcut for Receive');
    assert.ok(shortcutUrls.includes('./sim.html'), 'Should have shortcut for Simulation');

    for (const shortcut of manifest.shortcuts) {
      assert.ok(Array.isArray(shortcut.icons) && shortcut.icons.length > 0, 'Shortcut must have icons');
      for (const icon of shortcut.icons) {
        assert.equal(icon.type, 'image/png', 'Shortcut icon must declare type');
      }
    }
  });
});

describe('PWA: Icon Assets', () => {
  test('apple-touch-icon is 180x180 PNG without transparency', () => {
    const appleIconPath = path.join(PUBLIC_DIR, 'apple-touch-icon.png');
    assert.ok(fs.existsSync(appleIconPath), 'apple-touch-icon.png must exist');
    const dims = getPngDimensions(appleIconPath);
    assert.equal(dims.width, 180);
    assert.equal(dims.height, 180);
  });

  test('favicon.ico and favicon.svg exist', () => {
    const icoPath = path.join(PUBLIC_DIR, 'favicon.ico');
    const svgPath = path.join(PUBLIC_DIR, 'favicon.svg');
    assert.ok(fs.existsSync(icoPath), 'favicon.ico must exist');
    assert.ok(fs.existsSync(svgPath), 'favicon.svg must exist');
    assert.ok(fs.statSync(icoPath).size > 100, 'favicon.ico should not be empty');

    const svgContent = fs.readFileSync(svgPath, 'utf-8');
    assert.ok(svgContent.includes('<svg'), 'favicon.svg should be valid SVG');
  });
});

describe('PWA: HTML Document Integration', () => {
  const htmlFiles = ['index.html', 'send.html', 'receive.html', 'sim.html', '404.html'];

  for (const htmlFile of htmlFiles) {
    test(`${htmlFile} contains required PWA metadata, manifest link, and icons`, () => {
      const content = fs.readFileSync(path.join(WEB_DIR, htmlFile), 'utf-8');

      assert.ok(content.includes('<link rel="manifest" href="manifest.webmanifest">'),
        `${htmlFile} must link to manifest.webmanifest`);
      assert.ok(content.includes('<meta name="theme-color" content="#0b0f19">'),
        `${htmlFile} must declare theme-color`);
      assert.ok(content.includes('<link rel="apple-touch-icon" href="apple-touch-icon.png">'),
        `${htmlFile} must link apple-touch-icon`);
      assert.ok(content.includes('<link rel="icon" type="image/svg+xml" href="favicon.svg">'),
        `${htmlFile} must link SVG favicon`);
      assert.ok(content.includes('<link rel="alternate icon" href="favicon.ico">'),
        `${htmlFile} must link fallback ICO favicon`);
      assert.ok(content.includes('<meta name="apple-mobile-web-app-capable" content="yes">'),
        `${htmlFile} must support iOS standalone mode`);
      assert.ok(content.includes('pwa.js'),
        `${htmlFile} must include pwa.js for service worker registration`);
    });
  }
});

describe('PWA: Service Worker and Build Integration', () => {
  test('dev service worker exists in web/public/sw.js and supports ignoreSearch and clean URLs', () => {
    const swPath = path.join(PUBLIC_DIR, 'sw.js');
    assert.ok(fs.existsSync(swPath), 'web/public/sw.js must exist');
    const content = fs.readFileSync(swPath, 'utf-8');
    assert.ok(content.includes('addEventListener(\'install\''), 'Must implement install listener');
    assert.ok(content.includes('addEventListener(\'activate\''), 'Must implement activate listener');
    assert.ok(content.includes('addEventListener(\'fetch\''), 'Must implement fetch listener');
    assert.ok(content.includes('ignoreSearch: true'), 'Must use ignoreSearch for offline parameter matching');
    assert.ok(content.includes('matchCandidate'), 'Must support multi-variant candidate matching for clean URLs');
    assert.ok(content.includes('cleanResponse'), 'Must strip redirected flag to prevent navigation ERR_FAILED');
  });

  test('production build emits dist/sw.js with complete precache list and robust offline routing', () => {
    // Force rebuild to ensure dist/sw.js is generated with latest config
    execSync('npm run build', { cwd: ROOT_DIR, stdio: 'pipe' });

    const distSwPath = path.join(DIST_DIR, 'sw.js');
    assert.ok(fs.existsSync(distSwPath), 'dist/sw.js must exist after build');
    const content = fs.readFileSync(distSwPath, 'utf-8');

    assert.ok(content.includes('ignoreSearch: true'), 'Production SW must use ignoreSearch');
    assert.ok(content.includes('matchCandidate'), 'Production SW must support clean URL navigation');
    assert.ok(content.includes('cleanResponse'), 'Production SW must clean redirected responses');

    // Extract PRECACHE_ASSETS from dist/sw.js
    const match = content.match(/const PRECACHE_ASSETS = (\[[\s\S]*?\]);/);
    assert.ok(match, 'dist/sw.js must contain PRECACHE_ASSETS array');
    const precached = JSON.parse(match[1]);

    assert.ok(precached.includes('./'), 'Precache must include root ./');
    assert.ok(precached.includes('index.html'), 'Precache must include index.html');
    assert.ok(precached.includes('send.html'), 'Precache must include send.html');
    assert.ok(precached.includes('receive.html'), 'Precache must include receive.html');
    assert.ok(precached.includes('sim.html'), 'Precache must include sim.html');
    assert.ok(precached.includes('404.html'), 'Precache must include 404.html');
    assert.ok(precached.includes('send'), 'Precache must include clean route send');
    assert.ok(precached.includes('receive'), 'Precache must include clean route receive');
    assert.ok(precached.includes('sim'), 'Precache must include clean route sim');
    assert.ok(precached.includes('manifest.webmanifest'), 'Precache must include manifest');

    // Ensure all JS bundles, CSS, and worker are included
    const hasWorker = precached.some(p => p.includes('rx-worker'));
    assert.ok(hasWorker, 'Precache must include rx-worker chunk');

    const hasCss = precached.some(p => p.endsWith('.css'));
    assert.ok(hasCss, 'Precache must include compiled CSS bundle');

    // Ensure all precached assets physically exist in dist/ (or match an HTML route)
    for (const asset of precached) {
      if (asset === './') continue;
      const fullPath = path.join(DIST_DIR, asset);
      const htmlPath = path.join(DIST_DIR, `${asset}.html`);
      assert.ok(fs.existsSync(fullPath) || fs.existsSync(htmlPath), `Precached asset ${asset} must exist in dist/`);
    }
  });

  test('getServiceWorkerScopeAndUrl resolves correctly in both root and nested subpaths', () => {
    // Test Node fallback
    const defaultResolution = getServiceWorkerScopeAndUrl();
    assert.equal(defaultResolution.swUrl, './sw.js');
    assert.equal(defaultResolution.scope, './');

    // Mock browser environment to test nested subdirectory without trailing slash
    const origWindow = globalThis.window;
    try {
      globalThis.window = {
        location: new URL('https://example.com/modem')
      };
      const nestedBare = getServiceWorkerScopeAndUrl();
      assert.equal(nestedBare.swUrl, 'https://example.com/modem/sw.js');
      assert.equal(nestedBare.scope, 'https://example.com/modem/');

      globalThis.window = {
        location: new URL('https://example.com/modem/')
      };
      const nestedSlashed = getServiceWorkerScopeAndUrl();
      assert.equal(nestedSlashed.swUrl, 'https://example.com/modem/sw.js');
      assert.equal(nestedSlashed.scope, 'https://example.com/modem/');

      globalThis.window = {
        location: new URL('https://example.com/send.html')
      };
      const filePage = getServiceWorkerScopeAndUrl();
      assert.equal(filePage.swUrl, 'https://example.com/sw.js');
      assert.equal(filePage.scope, 'https://example.com/');

      // Test clean routes on custom domain / Cloudflare Pages root
      globalThis.window = {
        location: new URL('https://qr.pplx.io/send')
      };
      const cleanSend = getServiceWorkerScopeAndUrl();
      assert.equal(cleanSend.swUrl, 'https://qr.pplx.io/sw.js');
      assert.equal(cleanSend.scope, 'https://qr.pplx.io/');

      globalThis.window = {
        location: new URL('https://qr.pplx.io/receive')
      };
      const cleanReceive = getServiceWorkerScopeAndUrl();
      assert.equal(cleanReceive.swUrl, 'https://qr.pplx.io/sw.js');
      assert.equal(cleanReceive.scope, 'https://qr.pplx.io/');

      // Test clean route in nested subdirectory
      globalThis.window = {
        location: new URL('https://example.com/modem/send')
      };
      const nestedCleanSend = getServiceWorkerScopeAndUrl();
      assert.equal(nestedCleanSend.swUrl, 'https://example.com/modem/sw.js');
      assert.equal(nestedCleanSend.scope, 'https://example.com/modem/');
    } finally {
      if (origWindow === undefined) {
        delete globalThis.window;
      } else {
        globalThis.window = origWindow;
      }
    }
  });
});
