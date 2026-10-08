/* Cubey Scanner service worker: works offline after the first visit. */
const CACHE = 'cubey-scanner-v1.1.1';
const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'remote.js',
  'vendor/mqtt.min.js',
  'manifest.webmanifest',
  'vendor/zxing-reader.js',
  'vendor/zxing_reader.wasm',
  'vendor/xlsx.mini.min.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' – always take the files from the server, never from the browser's HTTP cache
  event.waitUntil(caches.open(CACHE)
    .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (always the newest version when online), cache when offline.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // no-cache: ask the server every time (GitHub Pages lets browsers keep files for 10 minutes,
  // which could mix old and new files right after an update)
  event.respondWith(
    fetch(req.url, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
  );
});
