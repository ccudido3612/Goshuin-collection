// sw.js — Service Worker：讓 app 沒有網路也能開，並且記住看過的地圖圖磚。
//
// 兩個快取：
//   shell-<VERSION>  程式本身（HTML / CSS / JS / 圖示 / Leaflet）。安裝時一次全部抓好，之後優先用快取。
//   tiles-v1         地圖圖磚。看過的、或在「離線地圖」裡預先下載的，都放這裡。
//
// ⚠ 改了任何程式檔（html / css / js / 圖示）之後，要把下面的 VERSION 改一個新的值，
//   手機才會抓到新版。忘記改的話，手機會一直用舊的快取。
//
// 這是「classic」service worker，不能用 import，所以 TILE_CACHE 的名稱要和 js/offline.js 的一致。

const VERSION = '2026-11-06-6';
const SHELL_CACHE = `shell-${VERSION}`;
const TILE_CACHE = 'tiles-v1';
const MAX_TILES = 4000; // 圖磚快取上限，超過就刪最舊的
const TRIM_EVERY = 100; // 每存幾張檢查一次上限

const TILE_HOSTS = ['cyberjapandata.gsi.go.jp', 'tile.openstreetmap.org'];

// 相對於 sw.js 所在的資料夾，所以放在 GitHub Pages 的子路徑底下也能用。
const SHELL_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/main.js',
  'js/map.js',
  'js/model.js',
  'js/geo.js',
  'js/store.js',
  'js/photo.js',
  'js/samples.js',
  'js/tiles.js',
  'js/offline.js',
  'js/gmaps.js',
  'js/geocode.js',
  'js/placeid.js',
  'js/icons.js',
  'fonts/aoyagi-subset.woff2',
  'fonts/masa-subset.woff2',
  'fonts/yuji-boku-subset.woff2',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/exifr/full.esm.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

/* ---------- 安裝：一次把程式全部抓進快取 ---------- */

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // cache: 'reload' 跳過瀏覽器自己的 HTTP 快取，確保抓到的是伺服器上最新的檔案。
      // addAll 是「全有或全無」：只要有一個檔案抓失敗，這次安裝就作廢，舊版繼續使用。
      await cache.addAll(SHELL_FILES.map((file) => new Request(file, { cache: 'reload' })));
      await self.skipWaiting();
    })(),
  );
});

/* ---------- 啟用：刪掉舊版程式快取（圖磚快取保留） ---------- */

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('shell-') && n !== SHELL_CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/* ---------- 攔截請求 ---------- */

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(tileResponse(request, event));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(shellResponse(request));
  }
  // 其他來源的請求不處理，交給瀏覽器照常去網路抓。
});

/** 程式檔：快取優先；沒有的話才去網路。開頁面（navigate）失敗時退回快取裡的 index.html。 */
async function shellResponse(request) {
  const cached = await caches.match(request, { cacheName: SHELL_CACHE, ignoreSearch: true });
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch (err) {
    if (request.mode === 'navigate') {
      const fallback = await caches.match('index.html', { cacheName: SHELL_CACHE });
      if (fallback) return fallback;
    }
    throw err;
  }
}

let storedSinceTrim = 0;

/**
 * 圖磚：快取優先。沒有的話去網路抓，成功就存起來。
 * 刻意用 CORS 模式去抓：這樣拿到的是「看得到內容」的回應，才能放心計算與限制快取大小。
 * （沒有 CORS 標頭的回應是 opaque，瀏覽器會把每張算成好幾 MB 的配額，很快塞滿。）
 * 如果伺服器不支援 CORS，就退回一般請求照常顯示，但不存快取。
 */
async function tileResponse(request, event) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request.url);
  if (cached) return cached;

  let response = null;
  try {
    response = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
  } catch (err) {
    response = null;
  }

  if (response && response.ok && response.type !== 'opaque') {
    event.waitUntil(store(cache, request.url, response.clone()));
    return response;
  }

  // CORS 失敗（沒網路，或伺服器不支援）：用原本的請求再試一次，讓圖還是能顯示。
  try {
    return await fetch(request);
  } catch (err) {
    return Response.error();
  }
}

async function store(cache, key, response) {
  await cache.put(key, response);
  storedSinceTrim += 1;
  if (storedSinceTrim >= TRIM_EVERY) {
    storedSinceTrim = 0;
    await trim(cache);
  }
}

/** 超過上限就刪最舊的（keys() 的順序是加入的順序）。 */
async function trim(cache) {
  const keys = await cache.keys();
  const extra = keys.length - MAX_TILES;
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}
