// pwa.js — registers the service worker and reports two events to the UI:
//   onOfflineReady: first install finished; the app can now open without a connection.
//   onUpdateReady(apply): a newer version is downloaded and waiting; call apply() to switch (reloads the page).
// A failure here must never stop the app, so everything is wrapped and reported through onError.
export function registerServiceWorker({ onOfflineReady, onUpdateReady, onError } = /** @type {{ onOfflineReady?: () => void, onUpdateReady?: (apply: () => void) => void, onError?: (e: any) => void }} */ ({})) {
  // Check the value, not just the property: some browsers/modes expose navigator.serviceWorker as undefined.
  if (!navigator.serviceWorker) return Promise.resolve(null);
  let applying = false;
  // Remember whether a worker already controlled this page BEFORE we register. After the first activation
  // clients.claim() sets a controller, so checking it later cannot tell "first install" from "update".
  let hadController = !!navigator.serviceWorker.controller;

  const watch = (reg) => {
    const worker = reg.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && hadController) announceUpdate(reg);
      if (worker.state === 'activated') { if (!hadController && onOfflineReady) onOfflineReady(); hadController = true; }   // later updates in this same visit must be announced too
    });
  };
  const announceUpdate = (reg) => {
    if (!onUpdateReady) return;
    onUpdateReady(() => { applying = true; if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' }); else location.reload(); });
  };

  // Reload only when the user asked for the update; the first-ever claim must not reload the page.
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (applying) location.reload(); });

  const go = async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' });
      if (reg.waiting && hadController) announceUpdate(reg);   // an update arrived during an earlier visit
      watch(reg);
      reg.addEventListener('updatefound', () => watch(reg));
      // An installed app can stay open for days: look for a new version whenever it comes back to the foreground.
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
      return reg;
    } catch (e) { if (onError) onError(e); return null; }
  };
  return document.readyState === 'complete' ? go() : new Promise((res) => window.addEventListener('load', () => res(go()), { once: true }));
}
