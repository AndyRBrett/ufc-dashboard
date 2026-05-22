var CACHE='ufc-v2';

self.addEventListener('install',function(e){
  self.skipWaiting();
});

self.addEventListener('activate',function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));
  }));
  self.clients.claim();
});

self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET')return;
  // Navigation requests (the HTML page) always go network-first so live data
  // is never stale. Cache is only used when the device is offline.
  if(e.request.mode==='navigate'){
    e.respondWith(
      fetch(e.request).then(function(res){
        var clone=res.clone();
        caches.open(CACHE).then(function(c){c.put(e.request,clone);});
        return res;
      }).catch(function(){
        return caches.match(e.request);
      })
    );
    return;
  }
  // Static assets (fonts, manifest, icons) — cache-first for speed
  e.respondWith(
    caches.match(e.request).then(function(cached){
      if(cached)return cached;
      return fetch(e.request).then(function(res){
        var clone=res.clone();
        caches.open(CACHE).then(function(c){c.put(e.request,clone);});
        return res;
      });
    })
  );
});
