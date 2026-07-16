// Service worker — installability, push notifications, offline fallback.
// Bump SW_VERSION on every deploy: changing this file's bytes makes browsers
// detect a SW update, which (via the controllerchange listener in index.html)
// auto-reloads open clients onto the latest code.
const SW_VERSION = '2026-07-16-1';
const CACHE = 'ufc-' + SW_VERSION;

self.addEventListener('install', function(e) {
  self.skipWaiting();
  // Precache the app shell so the PWA opens offline. Each URL is cached
  // independently — one miss must not block install.
  e.waitUntil(caches.open(CACHE).then(function(c) {
    return Promise.all(['./', './data.js', './manifest.json', './icon-192-v2.png', './sounds/eagle-1.mp3', './sounds/eagle-2.mp3'].map(function(u) {
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


// Single source of truth for the app version: the page asks the controlling SW
// for SW_VERSION and renders it in the footer, so the footer can't drift from the
// real running version (and surfaces stale-cache situations at a glance).
self.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'getVersion' && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ type: 'version', version: SW_VERSION });
  }
});

// Base64url <-> bytes, mirroring the page helpers, so the SW can re-subscribe
// and re-register without the page being open.
function urlB64ToUint8(b64) {
  var pad = '='.repeat((4 - b64.length % 4) % 4);
  var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function bufToB64Url(buf) {
  var bytes = new Uint8Array(buf), s = '';
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Browsers (notably Chrome/FCM) periodically rotate push subscriptions. Without
// this handler the old endpoint just dies and the user silently stops receiving
// pushes while the app is closed. Re-subscribe and re-register using the identity
// the page stashed in the 'ufc-push-id' cache.
self.addEventListener('pushsubscriptionchange', function(e) {
  e.waitUntil(
    caches.open('ufc-push-id')
      .then(function(c) { return c.match('/__push_id'); })
      .then(function(res) { return res ? res.json() : null; })
      .then(function(id) {
        if (!id || !id.vapid || !id.url) return;
        return self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8(id.vapid)
        }).then(function(sub) {
          var p256dh = sub.getKey('p256dh'), auth = sub.getKey('auth');
          if (!p256dh || !auth) return;
          return fetch(id.url + '/functions/v1/send-push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + id.anon },
            body: JSON.stringify({
              type: 'register', user_id: id.user_id, nickname: id.nickname,
              endpoint: sub.endpoint, p256dh: bufToB64Url(p256dh), auth: bufToB64Url(auth),
              live_results: !!id.live_results
            })
          });
        });
      })
      .catch(function() {})
  );
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
  // The trash-talk title is "🎤 Persona (via Sender)" — recover the sender so
  // the in-app sheet can credit who hired the voice (only the body is otherwise
  // forwarded). Best-effort: blank if the title isn't in that shape.
  var senderMatch = (e.notification.title || '').match(/\(via\s+(.+?)\)\s*$/);
  var sender = senderMatch ? senderMatch[1] : '';

  e.waitUntil(clients.matchAll({ type: 'window' }).then(function(cs) {
    // App is already open — focus it and route the tap by kind
    for (var i = 0; i < cs.length; i++) {
      if (cs[i].url && 'focus' in cs[i]) {
        cs[i].focus();
        if (kind) cs[i].postMessage({ type: kind, fullMessage: fullMessage });
        else if (fullMessage) cs[i].postMessage({ type: 'trash-talk', fullMessage: fullMessage, sender: sender });
        return;
      }
    }
    // App is closed — the routed URL (e.g. ./?inbox=1) carries the destination;
    // legacy trash talk encodes the full message in a URL param instead
    var url = baseUrl;
    if (!kind && fullMessage) {
      url += (url.indexOf('?') >= 0 ? '&' : '?') + 'trash=' + encodeURIComponent(fullMessage);
      if (sender) url += '&from=' + encodeURIComponent(sender);
    }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
