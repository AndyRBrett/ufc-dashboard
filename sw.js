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
  e.waitUntil(
    self.registration.showNotification(data.title || 'UFC Picks', {
      body: data.body || '',
      icon: './icon-192.png',
      badge: './icon-192.png',
      data: { url: data.url || './' }
    })
  );
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var targetUrl = './';
  try {
    var raw = e.notification.data && e.notification.data.url;
    if (raw) {
      var parsed = new URL(raw, self.location.origin);
      if (parsed.origin === self.location.origin) targetUrl = parsed.href;
    }
  } catch(err) {}
  e.waitUntil(clients.matchAll({ type: 'window' }).then(function(cs) {
    for (var i = 0; i < cs.length; i++) {
      if (cs[i].url && 'focus' in cs[i]) return cs[i].focus();
    }
    if (clients.openWindow) return clients.openWindow(targetUrl);
  }));
});
