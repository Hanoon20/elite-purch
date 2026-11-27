// Elite Ledger service worker — makes the dashboard installable and quick to open.
// Only this site's own files are cached. Google sign-in, Sheets data and fonts are
// never touched here, so ledger data always comes live from Google and is never
// stored by the service worker.
const CACHE = "elite-ledger-v65";
const SHELL = ["./", "./index.html", "./app.js", "./theme.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png", "./icons/icon-32.png"];
const NETWORK_TIMEOUT_MS = 3000;   // slow network? open from the cached copy instead

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so updates arrive straight away), but fall back to the cache
// when offline or when the network is slower than NETWORK_TIMEOUT_MS.
function networkFirst(req, cacheKey){
  return new Promise(resolve => {
    let settled = false;
    const fromCache = () => caches.match(cacheKey || req).then(hit => hit || fetch(req));
    const timer = setTimeout(() => { settled = true; resolve(fromCache()); }, NETWORK_TIMEOUT_MS);
    fetch(req).then(res => {
      if(res.ok){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(cacheKey || req, copy)); }
      if(!settled){ settled = true; clearTimeout(timer); resolve(res); }
    }).catch(() => {
      if(!settled){ settled = true; clearTimeout(timer); resolve(fromCache()); }
    });
  });
}

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  if(req.method !== "GET" || url.origin !== self.location.origin) return; // Google APIs etc. go straight to the network

  if(req.mode === "navigate"){ e.respondWith(networkFirst(req, "./index.html")); return; }
  if(url.pathname.endsWith("/app.js")){ e.respondWith(networkFirst(req)); return; }

  // Icons / manifest: cache first, refresh in the background
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => { if(res.ok){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; });
      return hit || net;
    })
  );
});

// ---- Morning cheque alert ----
// Google's server pings this phone around 7 am when cheques are due. The ping carries no text, so we ask
// the script for today's summary, proving who we are with this phone's own subscription secret.
const PUSH_INFO_URL = "https://script.google.com/macros/s/AKfycbxOqxaO86nlWEvHxBvUdoSHe79rDbRU6dzoowjlp78Sn3DdcyYiENx-vTqNk1EfqcpW/exec";
self.addEventListener("push", e => {
  e.waitUntil((async () => {
    let title = "Cheques due today", body = "Open the app to see them.";
    try{
      const sub = await self.registration.pushManager.getSubscription();
      const auth = sub && sub.toJSON().keys && sub.toJSON().keys.auth;
      if(auth && PUSH_INFO_URL){
        const r = await fetch(PUSH_INFO_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ action: "push_info", auth }), redirect: "follow", credentials: "omit", cache: "no-store" });
        const d = await r.json();
        if(d && d.ok && d.count){ title = d.title; body = d.body; }
      }
    }catch(err){}
    await self.registration.showNotification(title, { body, icon: "./icons/icon-192.png", badge: "./icons/icon-32.png", tag: "cheques-today", renotify: true, data: { url: "./#cheques" } });
  })());
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for(const c of list){ if("focus" in c){ await c.focus(); if("navigate" in c) try{ await c.navigate("./#cheques"); }catch(x){} return; } }
    if(self.clients.openWindow) await self.clients.openWindow("./#cheques");
  })());
});
