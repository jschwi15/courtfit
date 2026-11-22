/* CourtFit service worker: keeps the app usable with no signal.
   Data requests to Supabase are never cached here; the app keeps its own
   saved copy of the data. */
const CACHE = 'courtfit-shell-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './config.js',
  './library.js',
  './manifest.webmanifest',
  './logo-64.png',
  './logo-180.png',
  './logo-192.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return; // live data: never from cache
  const sameOrigin = url.origin === self.location.origin;
  const isAsset = sameOrigin || url.hostname === 'cdn.jsdelivr.net' || url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com');
  if (!isAsset) return;
  // Network first (so updates arrive), falling back to the saved copy offline.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: sameOrigin });
      if (hit) return hit;
      if (req.mode === 'navigate') { const page = await cache.match('./index.html'); if (page) return page; }
      throw err;
    }
  })());
});
