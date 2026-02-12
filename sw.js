/* ======================================================
   VocabSnap Service Worker
   - 静的アセットのキャッシュ
   - オフライン対応
   - CDNリソースのネットワークファースト戦略
   ====================================================== */

const CACHE_NAME = 'vocabsnap-v3';
const STATIC_ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/db.js',
  './js/ocr.js',
  './js/srs.js',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg'
];

// インストール: 静的アセットをキャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// アクティベート: 古いキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// フェッチ: キャッシュ戦略
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // CDNリソース: ネットワークファースト (取得後キャッシュ)
  if (url.hostname.includes('cdn') || url.hostname.includes('unpkg') || url.hostname.includes('jsdelivr')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // アプリアセット: キャッシュファースト
  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request))
      .catch(() => {
        // オフラインフォールバック
        if (event.request.destination === 'document') {
          return caches.match('./index.html');
        }
      })
  );
});
