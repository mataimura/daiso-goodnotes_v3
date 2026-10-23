const CACHE='daiso-ink-offline-v04';
const FILES=['./','./index.html','./app.js','./pipeline.js','./rasterfit.js','./goodnotes.js','./vendor/jszip.min.js',
  './manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install',evt=>{
  evt.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',evt=>{
  evt.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('daiso-ink-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',evt=>{
  if(evt.request.method!=='GET'||new URL(evt.request.url).origin!==self.location.origin)return;
  evt.respondWith(fetch(evt.request).then(res=>{
    if(res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put(evt.request,copy));}return res;
  }).catch(()=>caches.match(evt.request)));
});
