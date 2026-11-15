// Offline cache for the app itself. Song data lives in IndexedDB, never here.
const CACHE = 'campfire-v1.0.1';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'css/app.css', 'js/app.js', 'js/db.js', 'js/docx.js', 'js/chords.js', 'js/audio.js', 'js/icons.js', 'js/metrics.js',
  'fonts/LiberationMono-Regular.woff', 'fonts/LiberationMono-Bold.woff', 'img/splash.jpg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/favicon-48.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request).then(resp => {
    if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return resp;
  })).catch(() => caches.match('index.html')));
});
