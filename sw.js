// Minimal service worker — required for PWA installability, no caching.
// index.html updates every 15 minutes via scraper; caching it causes stale UI.
// All requests go straight to the network. Cache-Control headers on the page handle freshness.

self.addEventListener('install', function() { self.skipWaiting(); });

self.addEventListener('activate', function(e) {
  // Wipe every cache from every previous version
  e.waitUntil(
    caches.keys()
      .then(function(keys) { return Promise.all(keys.map(function(k) { return caches.delete(k); })); })
      .then(function() { return self.clients.claim(); })
  );
});

// No fetch handler — every request hits the network directly.
