// sw.js — Service Worker
// 讓 App 可以「加入主畫面」並在離線時開啟。
// 策略：App 外殼（HTML/CSS/JS/圖示）預先快取，離線也能開；
// 你的旅程資料不在這裡，是存在瀏覽器的 IndexedDB（見 db.js）。
//
// 改版須知：每次更新 App 外殼檔案後，把下面的 CACHE 版本號 +1（例如 v1 → v2），
// 使用者下次連線開啟時就會自動更新到新版。

const CACHE = 'tour-v3';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './sync.js',
  './supabase-config.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  // 導覽請求（開啟頁面）：先試網路，離線時退回快取的首頁
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }

  // 其餘：快取優先，沒有再打網路並順手存起來
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => hit)
    )
  );
});
