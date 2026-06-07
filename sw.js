// Minimal service worker — installability + push notifications, network-first.
// Bump SW_VERSION on every deploy: changing this file's bytes makes browsers
// detect a SW update, which (via the controllerchange listener in index.html)
// auto-reloads open clients onto the latest code.
const SW_VERSION = '2026-06-07-7';

self.addEventListener('install', function() { self.skipWaiting(); });

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys()
      .then(function(keys) { return Promise.all(keys.map(function(k) { return caches.delete(k); })); })
      .then(function() { return self.clients.claim(); })
  );
});

// Always pull the page itself fresh from the network so code updates land
// immediately, bypassing any stale HTTP cache (iOS PWAs cache HTML stubbornly).
// Falls back to a normal fetch if the forced revalidation fails.
self.addEventListener('fetch', function(e) {
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request, { cache: 'reload' }).catch(function() { return fetch(e.request); })
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
      data: { url: data.url || './', fullMessage: fullMessage }
    })
  );
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var fullMessage = e.notification.data && e.notification.data.fullMessage;
  var baseUrl = (e.notification.data && e.notification.data.url) || './';

  e.waitUntil(clients.matchAll({ type: 'window' }).then(function(cs) {
    // App is already open — focus it and postMessage the full trash talk
    for (var i = 0; i < cs.length; i++) {
      if (cs[i].url && 'focus' in cs[i]) {
        cs[i].focus();
        if (fullMessage) cs[i].postMessage({ type: 'trash-talk', fullMessage: fullMessage });
        return;
      }
    }
    // App is closed — encode full message in URL param so the app reads it on load
    var url = baseUrl;
    if (fullMessage) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'trash=' + encodeURIComponent(fullMessage);
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
