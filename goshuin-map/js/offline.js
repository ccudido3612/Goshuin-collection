// offline.js — 離線相關：註冊 service worker、網路狀態、離線地圖的用量與預先下載。
//
// 為了能在 node 測試，會碰到瀏覽器 API 的地方（caches、fetch）都可以從參數傳入替代品。

import { fillTemplate } from './tiles.js';

/** 必須和 sw.js 裡的 TILE_CACHE 同名。 */
export const TILE_CACHE = 'tiles-v1';
export const MAX_CACHED_TILES = 4000; // 和 sw.js 的 MAX_TILES 一致
export const MAX_FAILURES_IN_A_ROW = 20;

/* ---------- service worker ---------- */

/**
 * 註冊 service worker。回傳 Promise<registration | null>。
 * - 只有 https（或 localhost）才能用；其他情況回傳 null。
 * - 在 localhost 開發時預設不註冊（避免快取舊檔讓你以為程式沒更新）；網址加上 ?sw=1 才會註冊。
 * - onUpdate：頁面本來就有 service worker 在控制、而且換成新版時呼叫（第一次安裝不會呼叫）。
 */
export async function registerServiceWorker({ onUpdate } = {}) {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (isLocal && !new URLSearchParams(location.search).has('sw')) return null;

  const hadController = Boolean(navigator.serviceWorker.controller);
  if (hadController && onUpdate) {
    let fired = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (fired) return;
      fired = true;
      onUpdate();
    });
  }
  try {
    return await navigator.serviceWorker.register('sw.js');
  } catch (err) {
    console.warn('service worker 註冊失敗：', err);
    return null;
  }
}

/** 網路狀態變化時呼叫 callback(isOnline)，並且立刻呼叫一次。 */
export function watchOnline(callback) {
  const notify = () => callback(navigator.onLine !== false);
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  notify();
}

/** 請瀏覽器「盡量不要」自動清掉這個網站的資料。瀏覽器可以拒絕，所以只回報結果。 */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch (err) {
    /* 忽略 */
  }
  return false;
}

/* ---------- 離線地圖的用量 ---------- */

/** 回傳 { tiles, usageMB, quotaMB, persisted }；取不到的欄位是 null。 */
export async function cacheStats({ cacheStorage = globalThis.caches, storage = globalThis.navigator?.storage } = {}) {
  const stats = { tiles: 0, usageMB: null, quotaMB: null, persisted: null };
  try {
    if (cacheStorage) stats.tiles = (await (await cacheStorage.open(TILE_CACHE)).keys()).length;
  } catch (err) {
    /* 忽略 */
  }
  try {
    if (storage?.estimate) {
      const { usage, quota } = await storage.estimate();
      if (Number.isFinite(usage)) stats.usageMB = usage / 1024 / 1024;
      if (Number.isFinite(quota)) stats.quotaMB = quota / 1024 / 1024;
    }
    if (storage?.persisted) stats.persisted = await storage.persisted();
  } catch (err) {
    /* 忽略 */
  }
  return stats;
}

/** 刪掉所有離線圖磚。程式本身的快取不動。 */
export async function clearTiles({ cacheStorage = globalThis.caches } = {}) {
  return cacheStorage.delete(TILE_CACHE);
}

/* ---------- 預先下載圖磚 ---------- */

/**
 * 把一批圖磚抓下來放進圖磚快取。
 *   template     'https://…/{z}/{x}/{y}.png'
 *   tiles        可迭代的 { z, x, y }（通常來自 tiles.js 的 iterateTiles）
 *   total        總數（只用來算進度）
 *   signal       AbortSignal，使用者按「取消」時中止
 *   onProgress   每處理一張就呼叫 onProgress({ done, total, fetched, skipped, failed })
 *   concurrency  同時進行幾個請求。刻意設小（預設 4），不要對圖磚伺服器造成負擔。
 *
 * 已經在快取裡的會跳過。連續失敗 MAX_FAILURES_IN_A_ROW 次就中止（通常是沒網路或被擋）。
 * 失敗的圖磚不會存進快取。回傳最後的計數，另外有 aborted / stoppedEarly 標記。
 */
export async function prefetchTiles({
  template,
  tiles,
  total,
  signal,
  onProgress = () => {},
  concurrency = 4,
  cacheStorage = globalThis.caches,
  fetchImpl = globalThis.fetch,
}) {
  const cache = await cacheStorage.open(TILE_CACHE);
  const iterator = tiles[Symbol.iterator]();
  const result = { done: 0, total, fetched: 0, skipped: 0, failed: 0, aborted: false, stoppedEarly: false };
  let failuresInARow = 0;

  const shouldStop = () => {
    if (signal?.aborted) {
      result.aborted = true;
      return true;
    }
    if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
      result.stoppedEarly = true;
      return true;
    }
    return false;
  };

  const worker = async () => {
    while (!shouldStop()) {
      const next = iterator.next();
      if (next.done) return;
      const { z, x, y } = next.value;
      const url = fillTemplate(template, z, x, y);

      try {
        if (await cache.match(url)) {
          result.skipped += 1;
          failuresInARow = 0;
        } else {
          const response = await fetchImpl(url, { mode: 'cors', credentials: 'omit', signal });
          if (!response.ok || response.type === 'opaque') throw new Error(`HTTP ${response.status}`);
          await cache.put(url, response);
          result.fetched += 1;
          failuresInARow = 0;
        }
      } catch (err) {
        if (signal?.aborted) {
          result.aborted = true;
          return;
        }
        result.failed += 1;
        failuresInARow += 1;
      }
      result.done += 1;
      onProgress({ ...result });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  // 下載完順便檢查一次上限，超過就刪最舊的。
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_CACHED_TILES; i++) await cache.delete(keys[i]);

  return result;
}
