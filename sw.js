var CACHE='ufc-v3';

self.addEventListener('install',function(e){
  // Only pre-cache static assets — never index.html (it updates constantly)
  e.waitUntil(
    caches.open(CACHE).then(function(c){
      return c.addAll(['./manifest.json','./icon-192.png','./icon-512.png']);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate',function(e){
  // Wipe every old cache version
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));
  }));
  self.clients.claim();
});

self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET')return;
  // Do NOT intercept navigation requests (index.html).
  // The page already has Cache-Control: no-cache headers — the browser
  // will always fetch a fresh copy from GitHub Pages on its own.
  if(e.request.mode==='navigate')return;
  // Cache-first for icons, manifest, and fonts
  e.respondWith(
    caches.match(e.request).then(function(cached){
      if(cached)return cached;
      return fetch(e.request).then(function(res){
        var clone=res.clone();
        caches.open(CACHE).then(function(c){c.put(e.request,clone);});
        return res;
      }).catch(function(){return cached;});
    })
  );
});
