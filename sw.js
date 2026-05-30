// Minimal service worker — installability + push notifications only, no caching.

self.addEventListener('install', function() { self.skipWaiting(); });

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys()
      .then(function(keys) { return Promise.all(keys.map(function(k) { return caches.delete(k); })); })
      .then(function() { return self.clients.claim(); })
  );
});

// No fetch handler — all requests go straight to the network.

self.addEventListener('push', function(e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) {}

  // Body may contain full message after \n---\n separator (trash talk feature).
  // OS shows only displayBody; full message is stored in notification data.
  var rawBody = data.body || '';
  var sep = rawBody.indexOf('\n---\n');
  var displayBody = sep >= 0 ? rawBody.slice(0, sep) : rawBody;
  var fullMessage = sep >= 0 ? rawBody.slice(sep + 5) : '';

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
