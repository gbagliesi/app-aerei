// Service worker: rende l'app installabile e disponibile offline (solo l'interfaccia; i dati voli richiedono rete).
const CACHE = 'voli-v60';
const SHELL = ['./', 'index.html', 'style.css', 'icon.svg', 'manifest.webmanifest', 'vendor/leaflet.js', 'vendor/leaflet.css',
  'js/app.js', 'js/api.js', 'js/store.js', 'js/demo.js', 'js/airports.js', 'js/tabs.js', 'js/notify.js', 'js/rotation.js'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // API e mappe: sempre dalla rete
  // network-first (senza cache HTTP del browser) per l'interfaccia, così gli aggiornamenti arrivano subito; cache se offline
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request)));
});

// Notifiche dei voli seguiti, mandate dal Worker (anche ad app chiusa)
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Tabellone Voli', {
    body: m.body || '', tag: m.tag, renotify: !!m.tag, icon: 'icon.svg', badge: 'icon.svg', data: { url: m.url || './' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => x.url.startsWith(self.registration.scope));
    if (c) return c.focus().then(() => c.navigate ? c.navigate(url) : null).catch(() => self.clients.openWindow(url));
    return self.clients.openWindow(url);
  }));
});
