/**
 * Progressive Web App (PWA) manager and Service Worker lifecycle handler.
 */

let swRegistration = null;
let deferredInstallPrompt = null;

/**
 * Calculates resilient swUrl and scope regardless of whether the current
 * URL has a trailing slash or is hosted in a nested subdirectory.
 */
export function getServiceWorkerScopeAndUrl() {
  if (typeof window === 'undefined') {
    return { swUrl: './sw.js', scope: './' };
  }

  const loc = window.location;
  const pathParts = loc.pathname.split('/');
  const lastPart = pathParts[pathParts.length - 1];
  const knownRoutes = new Set(['send', 'receive', 'sim', 'app']);

  let baseHref;
  if (knownRoutes.has(lastPart) || lastPart.includes('.')) {
    // Current page is a route file (e.g. /send, /receive.html)
    baseHref = new URL('./', loc.href).href;
  } else if (lastPart.length > 0) {
    // Bare directory without trailing slash (e.g. /subpath or /modem)
    baseHref = `${loc.origin}${loc.pathname}/`;
  } else {
    // Already has trailing slash (e.g. / or /subpath/)
    baseHref = loc.href;
  }

  return {
    swUrl: new URL('sw.js', baseHref).href,
    scope: new URL('./', baseHref).href
  };
}

/**
 * Registers the ChromaStripe service worker.
 */
export async function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  try {
    const { swUrl, scope } = getServiceWorkerScopeAndUrl();
    const reg = await navigator.serviceWorker.register(swUrl, { scope });
    swRegistration = reg;

    // Check for service worker updates
    reg.addEventListener('updatefound', () => {
      const installingWorker = reg.installing;
      if (installingWorker) {
        installingWorker.addEventListener('statechange', () => {
          if (installingWorker.state === 'installed') {
            if (navigator.serviceWorker.controller) {
              console.log('[ChromaStripe PWA] New update available. Reloading or ready.');
              dispatchPWAEvent('swUpdateAvailable', { registration: reg });
            } else {
              console.log('[ChromaStripe PWA] App cached for offline use.');
              dispatchPWAEvent('swOfflineReady', { registration: reg });
            }
          }
        });
      }
    });

    // When new service worker takes over, optionally reload
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        console.log('[ChromaStripe PWA] Service worker activated. Controller changed.');
      }
    });

    return reg;
  } catch (err) {
    console.warn('[ChromaStripe PWA] Service worker registration failed:', err);
    return null;
  }
}

/**
 * Dispatches custom DOM events for PWA lifecycle hooks.
 */
function dispatchPWAEvent(name, detail = {}) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }
}

/**
 * Returns true if the app is currently running in standalone PWA mode.
 */
export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

/**
 * Manually trigger service worker update check.
 */
export async function checkForUpdate() {
  if (swRegistration) {
    try {
      await swRegistration.update();
    } catch (e) {
      console.warn('[ChromaStripe PWA] Update check failed:', e);
    }
  }
}

/**
 * Triggers native PWA install prompt if captured.
 */
export async function promptInstall() {
  if (deferredInstallPrompt) {
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    return choice;
  }
  return { outcome: 'dismissed' };
}

/**
 * Returns true if native install prompt is available to trigger.
 */
export function canPromptInstall() {
  return !!deferredInstallPrompt;
}

// Capture install prompts & install events
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    dispatchPWAEvent('pwaInstallPrompt', { prompt: e });
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    dispatchPWAEvent('pwaInstalled');
  });

  // Auto-register on page load
  if (document.readyState === 'complete') {
    registerServiceWorker();
  } else {
    window.addEventListener('load', () => {
      registerServiceWorker();
    });
  }
}
