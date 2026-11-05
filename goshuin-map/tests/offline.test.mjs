import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefetchTiles, cacheStats, clearTiles, TILE_CACHE, MAX_FAILURES_IN_A_ROW } from '../js/offline.js';
import { iterateTiles } from '../js/tiles.js';
import { FakeCacheStorage } from './helpers/fake-caches.mjs';

const TEMPLATE = 'https://tiles.test/{z}/{x}/{y}.png';
const BOUNDS = { west: 139.69, east: 139.72, south: 35.67, north: 35.7 };
const okResponse = () => new Response('png', { status: 200 });

const setup = (fetchImpl, bounds = BOUNDS) => {
  const caches = new FakeCacheStorage();
  const tiles = [...iterateTiles(bounds, 14, 15)];
  return { caches, tiles, run: (extra = {}) => prefetchTiles({ template: TEMPLATE, tiles, total: tiles.length, cacheStorage: caches, fetchImpl, ...extra }) };
};

test('prefetch：全部抓成功並存進圖磚快取，進度逐張回報', async () => {
  const calls = [];
  const { caches, tiles, run } = setup(async (url, init) => {
    calls.push({ url, init });
    return okResponse();
  });
  const seen = [];
  const r = await run({ onProgress: (p) => seen.push(p.done) });
  assert.equal(r.fetched, tiles.length);
  assert.equal(r.failed, 0);
  assert.equal(r.done, tiles.length);
  assert.equal(seen.length, tiles.length);
  assert.equal((await (await caches.open(TILE_CACHE)).keys()).length, tiles.length);
  assert.ok(calls.every((c) => c.init.mode === 'cors' && c.init.credentials === 'omit'));
});

test('prefetch：已經在快取裡的會跳過，不再發請求', async () => {
  let n = 0;
  const { run } = setup(async () => (n++, okResponse()));
  await run();
  const first = n;
  const again = await run();
  assert.equal(n, first); // 第二次沒有任何新請求
  assert.equal(again.skipped, first);
  assert.equal(again.fetched, 0);
});

test('prefetch：失敗的圖磚不存進快取，但不影響其他', async () => {
  let i = 0;
  const { caches, tiles, run } = setup(async () => (i++ % 5 === 0 ? new Response('', { status: 500 }) : okResponse()));
  const r = await run();
  assert.ok(r.failed > 0);
  assert.equal(r.fetched + r.failed, tiles.length);
  assert.equal((await (await caches.open(TILE_CACHE)).keys()).length, r.fetched);
  assert.equal(r.stoppedEarly, false);
});

test('prefetch：連續失敗太多次就提早中止', async () => {
  let n = 0;
  const { tiles, run } = setup(async () => (n++, Promise.reject(new TypeError('offline'))), { west: 139.5, east: 139.9, south: 35.5, north: 35.8 });
  assert.ok(tiles.length > MAX_FAILURES_IN_A_ROW + 10, '測試資料要夠多');
  const r = await run();
  assert.equal(r.stoppedEarly, true);
  assert.ok(n < tiles.length, '中止後不該把全部都試完');
  assert.ok(r.failed >= MAX_FAILURES_IN_A_ROW);
});

test('prefetch：opaque 回應視為失敗（不存）', async () => {
  const opaque = () => ({ ok: false, status: 0, type: 'opaque' });
  const { caches, run } = setup(async () => opaque());
  const r = await run();
  assert.equal(r.fetched, 0);
  assert.equal((await (await caches.open(TILE_CACHE)).keys()).length, 0);
});

test('prefetch：AbortSignal 可以中止', async () => {
  const ac = new AbortController();
  let n = 0;
  const { run } = setup(async () => {
    if (++n === 5) ac.abort();
    return okResponse();
  });
  const r = await run({ signal: ac.signal });
  assert.equal(r.aborted, true);
  assert.ok(r.done < 40);
});

test('cacheStats / clearTiles', async () => {
  const { caches, run } = setup(async () => okResponse());
  await run();
  const storage = { estimate: async () => ({ usage: 5 * 1024 * 1024, quota: 100 * 1024 * 1024 }), persisted: async () => true };
  const s = await cacheStats({ cacheStorage: caches, storage });
  assert.ok(s.tiles > 0);
  assert.equal(Math.round(s.usageMB), 5);
  assert.equal(Math.round(s.quotaMB), 100);
  assert.equal(s.persisted, true);

  await clearTiles({ cacheStorage: caches });
  assert.equal((await cacheStats({ cacheStorage: caches, storage })).tiles, 0);
});

test('cacheStats：瀏覽器沒有 storage API 時不會丟錯', async () => {
  const s = await cacheStats({ cacheStorage: new FakeCacheStorage(), storage: undefined });
  assert.deepEqual(s, { tiles: 0, usageMB: null, quotaMB: null, persisted: null });
});
