// Service worker: rende l'app installabile e disponibile offline (solo l'interfaccia; i dati voli richiedono rete).
const CACHE = 'voli-v25';
const SHELL = ['./', 'index.html', 'style.css', 'icon.svg', 'manifest.webmanifest', 'vendor/leaflet.js', 'vendor/leaflet.css',
  'js/app.js', 'js/api.js', 'js/store.js', 'js/demo.js', 'js/airports.js'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // API e mappe: sempre dalla rete
  // network-first (senza cache HTTP del browser) per l'interfaccia, così gli aggiornamenti arrivano subito; cache se offline
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request)));
});
