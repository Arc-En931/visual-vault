// sw.js — offline app shell. Caches the app's own files so VisualVault opens with no network.
// It never touches IndexedDB (your catalog) and never caches anything outside PRECACHE.
//
// VERSION is stamped from the files' contents by `python3 tools/stamp-sw.py`. Run it before every deploy:
// if any listed file changes and VERSION does not, phones would keep serving the old copy.
const VERSION = 'vv-3ec06a265ae5';
const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/backup.js',
  'js/db.js',
  'js/dom.js',
  'js/image-service.js',
  'js/models.js',
  'js/pwa.js',
  'js/repository.js',
  'js/search-service.js',
  'js/zip.js',
  'js/views/backup.js',
  'js/views/catalog.js',
  'js/views/image-editor.js',
  'js/views/manage.js',
  'js/views/product-form.js',
  'js/views/shared.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

const scopeUrl = (p) => new URL(p, self.registration.scope).href;

self.addEventListener('install', (event) => {
  // Fetch every file fresh (bypassing the HTTP cache) so a half-old/half-new mix can never be stored.
  // All-or-nothing: if any file fails, the install fails and the previous version stays in charge.
  event.waitUntil((async () => {
    const existed = await caches.has(VERSION);
    try {
      const cache = await caches.open(VERSION);
      await Promise.all(PRECACHE.map(async (p) => {
        const res = await fetch(new Request(scopeUrl(p), { cache: 'reload' }));
        if (!res.ok) throw new Error(`precache failed: ${p} (${res.status})`);
        await cache.put(scopeUrl(p), res);
      }));
    } catch (e) {
      if (!existed) await caches.delete(VERSION);   // drop the half-filled cache, but never one that was already live
      throw e;
    }
    // No skipWaiting() here: the page asks for it (see pwa.js) so an open screen is never swapped mid-edit.
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('vv-') && key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    // Query strings are ignored for the shell (e.g. index.html?utm=…); fragments never reach the worker.
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      // Only the app's own entry points fall back to the shell. Other pages (e.g. /tests/) go to the network.
      const entry = [scopeUrl('./'), scopeUrl('index.html')];
      if (entry.includes(url.origin + url.pathname)) { const shell = await cache.match(scopeUrl('index.html')); if (shell) return shell; }
    }
    return fetch(req);
  })());
});
