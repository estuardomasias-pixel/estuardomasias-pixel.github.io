// Emberwild service worker: caches the whole game so it starts without internet after the first launch.
const CACHE = 'emberwild-v15';
const FILES = ['./', 'index.html', 'game.js', 'manifest.webmanifest', 'lib/three.module.js', 'icons/icon-192.png', 'icons/icon-512.png', 'fonts/Arimo-latin.woff2'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
// Network first (so updates arrive when online), cache as fallback (so it works offline).
// Only good same-origin responses are cached, so a Wi-Fi login page or a 404 can't overwrite the game,
// and a slow "connected but no internet" network falls back to the cache after a few seconds.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 3500);
    try {
      const r = await fetch(e.request, { signal: ctl.signal });
      clearTimeout(timer);
      if (r.ok && r.type === 'basic' && !r.redirected) { const copy = r.clone(); e.waitUntil(caches.open(CACHE).then(c => c.put(e.request, copy))); return r; }
      return (await caches.match(e.request, { ignoreSearch: true })) || r; // bad answer: prefer the cached copy
    } catch (err) {
      clearTimeout(timer);
      const hit = await caches.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
