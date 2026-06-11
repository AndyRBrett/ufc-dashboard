// Service worker — installability, push notifications, offline fallback.
// Bump SW_VERSION on every deploy: changing this file's bytes makes browsers
// detect a SW update, which (via the controllerchange listener in index.html)
// auto-reloads open clients onto the latest code.
const SW_VERSION = '2026-06-11-8';
const CACHE = 'ufc-' + SW_VERSION;

self.addEventListener('install', function(e) {
  self.skipWaiting();
  // Precache the app shell so the PWA opens offline. Each URL is cached
  // independently — one miss must not block install.
  e.waitUntil(caches.open(CACHE).then(function(c) {
    return Promise.all(['./', './data.js', './manifest.json', './icon-192-v2.png'].map(function(u) {
      return c.add(u).catch(function() {});
    }));
  }));
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys()
      .then(function(keys) {
        return Promise.all(keys.filter(function(k) { return k !== CACHE; })
          .map(function(k) { return caches.delete(k); }));
      })
      .then(function() { return self.clients.claim(); })
  );
});

// The page and data.js are pulled fresh from the network so code/result updates
// land immediately, bypassing any stale HTTP cache (iOS PWAs cache stubbornly).
// Successful responses refresh the offline copy; when the network is down, the
// last-good copy is served instead of a white screen. Everything else
// (fonts, icons) is cache-first.
self.addEventListener('fetch', function(e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var isNavigate = req.mode === 'navigate';
  var isData = !isNavigate && new URL(req.url).pathname.slice(-8) === '/data.js';
  if (isNavigate || isData) {
    var cacheKey = isNavigate ? './' : './data.js';
    e.respondWith(
      fetch(req, { cache: 'reload' })
        .catch(function() { return fetch(req); })
        .then(function(res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(CACHE).then(function(c) { c.put(cacheKey, copy); });
          }
          return res;
        })
        .catch(function() {
          return caches.match(cacheKey).then(function(hit) {
            if (hit) return hit;
            throw new Error('offline and no cached copy');
          });
        })
    );
    return;
  }
  if (req.url.indexOf(self.location.origin + '/') === 0) {
    e.respondWith(
      caches.match(req).then(function(hit) {
        if (hit) return hit;
        return fetch(req).then(function(res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(CACHE).then(function(c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
  }
});


self.addEventListener('push', function(e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) {}

  // Full body text shown in notification — iOS collapses to ~2 lines, long-press to expand.
  // Separator \n---\n is legacy; fullMessage falls back to rawBody so in-app tap always works.
  var rawBody = data.body || '';
  var sep = rawBody.indexOf('\n---\n');
  var displayBody = sep >= 0 ? rawBody.slice(0, sep) : rawBody;
  var fullMessage = sep >= 0 ? rawBody.slice(sep + 5) : rawBody;

  e.waitUntil(
    self.registration.showNotification(data.title || 'UFC Picks', {
      body: displayBody,
      icon: './icon-192-v2.png',
      badge: './icon-192-v2.png',
      data: { url: data.url || './', kind: data.kind || '', fullMessage: fullMessage }
    })
  );
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var fullMessage = e.notification.data && e.notification.data.fullMessage;
  var kind = (e.notification.data && e.notification.data.kind) || '';
  var baseUrl = (e.notification.data && e.notification.data.url) || './';

  e.waitUntil(clients.matchAll({ type: 'window' }).then(function(cs) {
    // App is already open — focus it and route the tap by kind
    for (var i = 0; i < cs.length; i++) {
      if (cs[i].url && 'focus' in cs[i]) {
        cs[i].focus();
        if (kind) cs[i].postMessage({ type: kind, fullMessage: fullMessage });
        else if (fullMessage) cs[i].postMessage({ type: 'trash-talk', fullMessage: fullMessage });
        return;
      }
    }
    // App is closed — the routed URL (e.g. ./?inbox=1) carries the destination;
    // legacy trash talk encodes the full message in a URL param instead
    var url = baseUrl;
    if (!kind && fullMessage) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'trash=' + encodeURIComponent(fullMessage);
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
