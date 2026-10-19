/* 划课 Service Worker：静态资源缓存 + 离线可用
   策略：预缓存应用外壳；运行时对同源 GET 请求走「缓存优先、后台更新」；
   导航请求离线时回退 index.html；/api/ 局域网同步接口与跨域请求一律不走缓存。 */
var CACHE = "huake-v1";
var SHELL = [
  "./",
  "index.html",
  "cards.html",
  "history.html",
  "settings.html",
  "sell.html",
  "manifest.webmanifest",
  "css/style.css",
  "js/app.js",
  "js/cloud-config.js",
  "favicon.svg",
  "favicon-32.png",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          if (k !== CACHE) return caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function isApi(url) {
  return url.pathname.indexOf("/api/") === 0;
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 云同步等跨域请求不拦截
  if (isApi(url)) return;                             // 局域网 /api/state 直连

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match("index.html").then(function (r) { return r || caches.match("./"); });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
