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
  e.waitUntil(clients.matchAll({ type: 'window' }).then(function(cs) {
    for (var i = 0; i < cs.length; i++) {
      if (cs[i].url && 'focus' in cs[i]) return cs[i].focus();
    }
    if (clients.openWindow) return clients.openWindow(e.notification.data.url || './');
  }));
});
