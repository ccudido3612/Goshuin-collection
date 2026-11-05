// 在 node:vm 裡執行 sw.js，用假的 caches / fetch 驗證它的行為。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { FakeCacheStorage } from './helpers/fake-caches.mjs';

const source = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://me.github.io';
const SCOPE = `${ORIGIN}/goshuin-map/`;

class FakeRequest {
  constructor(input, init = {}) {
    this.url = new URL(typeof input === 'string' ? input : input.url, SCOPE).href;
    this.method = init.method ?? 'GET';
    this.mode = init.mode ?? 'cors';
    this.cache = init.cache;
  }
}

function boot({ online = true, corsTiles = true, failPath = null } = {}) {
  const log = [];
  const state = { online, corsTiles };
  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    log.push({ url, mode: init.mode ?? input.mode });
    if (!state.online) throw new TypeError('Failed to fetch');
    if (failPath && url.includes(failPath)) return new Response('nope', { status: 404 });
    if (url.includes('tile') || url.includes('gsi.go.jp')) {
      if (init.mode === 'cors' && !state.corsTiles) throw new TypeError('CORS');
      return Object.assign(new Response('tile'), {});
    }
    return new Response(`file:${url}`, { status: 200 });
  };
  const caches = new FakeCacheStorage(fetchImpl);
  const handlers = {};
  const self = {
    addEventListener: (type, fn) => (handlers[type] = fn),
    location: new URL(`${SCOPE}sw.js`),
    registration: { scope: SCOPE },
    skipWaiting: async () => (state.skipped = true),
    clients: { claim: async () => (state.claimed = true) },
  };
  const ctx = vm.createContext({ self, caches, fetch: fetchImpl, Request: FakeRequest, Response, URL, Promise, console });
  vm.runInContext(source, ctx);
  const run = async (type, request) => {
    let responded, waits = [];
    const event = { request, waitUntil: (p) => waits.push(p), respondWith: (p) => (responded = p) };
    handlers[type](event);
    await Promise.all(waits);
    const response = responded ? await responded.catch((e) => ({ error: e })) : undefined;
    await Promise.all(waits);
    return response;
  };
  return { caches, state, log, run, ctx };
}

const req = (path, init) => new FakeRequest(path, init);

test('install：預先快取全部程式檔、skipWaiting', async () => {
  const { caches, state, run } = boot();
  await run('install');
  const names = await caches.keys();
  const shell = names.find((n) => n.startsWith('shell-'));
  assert.ok(shell);
  const keys = (await (await caches.open(shell)).keys()).map((k) => k.url);
  for (const f of ['index.html', 'js/main.js', 'js/offline.js', 'vendor/leaflet/leaflet.js', 'manifest.webmanifest', 'icons/icon-192.png']) {
    assert.ok(keys.includes(`${SCOPE}${f}`), `缺 ${f}`);
  }
  assert.equal(state.skipped, true);
});

test('install：SHELL_FILES 裡列的檔案都真的存在於專案', () => {
  const m = source.match(/const SHELL_FILES = \[([\s\S]*?)\];/);
  const files = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).filter((f) => f !== './');
  const root = new URL('../', import.meta.url);
  for (const f of files) assert.ok(fs.existsSync(new URL(f, root)), `${f} 不存在`);
});

test('install：任何一個檔案抓失敗，整個安裝失敗（全有或全無）', async () => {
  const { caches, run } = boot({ failPath: 'style.css' });
  await assert.rejects(run('install'));
  const shell = (await caches.keys()).find((n) => n.startsWith('shell-'));
  assert.equal((await (await caches.open(shell)).keys()).length, 0);
});

test('activate：刪掉舊版程式快取、保留圖磚快取、claim', async () => {
  const { caches, state, run } = boot();
  await caches.open('shell-old');
  await caches.open('tiles-v1');
  await run('install');
  await run('activate');
  const names = await caches.keys();
  assert.ok(!names.includes('shell-old'));
  assert.ok(names.includes('tiles-v1'));
  assert.equal(state.claimed, true);
});

test('程式檔：快取優先，離線也拿得到；忽略網址的 ?query', async () => {
  const { state, run, log } = boot();
  await run('install');
  state.online = false;
  log.length = 0;
  const res = await run('fetch', req('js/main.js?v=123'));
  assert.equal(await res.text(), `file:${SCOPE}js/main.js`);
  assert.equal(log.length, 0, '命中快取時不該發網路請求');
});

test('離線開啟頁面（navigate 到沒快取的路徑）會退回 index.html', async () => {
  const { state, run } = boot();
  await run('install');
  state.online = false;
  const res = await run('fetch', req('some/deep/link', { mode: 'navigate' }));
  assert.equal(await res.text(), `file:${SCOPE}index.html`);
});

test('非 GET、其他網站的請求不處理', async () => {
  const { run } = boot();
  assert.equal(await run('fetch', req('x', { method: 'POST' })), undefined);
  assert.equal(await run('fetch', req('https://example.com/a.js')), undefined);
});

test('圖磚：第一次走網路並以 CORS 模式抓、存起來；第二次離線也有', async () => {
  const { caches, state, run, log } = boot();
  const url = 'https://cyberjapandata.gsi.go.jp/xyz/std/15/29100/12900.png';
  const first = await run('fetch', req(url, { mode: 'no-cors' }));
  assert.equal(await first.text(), 'tile');
  assert.equal(log[0].mode, 'cors');
  assert.equal((await (await caches.open('tiles-v1')).keys()).length, 1);

  state.online = false;
  log.length = 0;
  const second = await run('fetch', req(url, { mode: 'no-cors' }));
  assert.equal(await second.text(), 'tile');
  assert.equal(log.length, 0);
});

test('圖磚：伺服器不支援 CORS 時，仍然顯示但不存快取', async () => {
  const { caches, run } = boot({ corsTiles: false });
  const url = 'https://tile.openstreetmap.org/12/1/1.png';
  const res = await run('fetch', req(url, { mode: 'no-cors' }));
  assert.equal(await res.text(), 'tile');
  assert.equal((await (await caches.open('tiles-v1')).keys()).length, 0);
});

test('圖磚：離線且沒快取 → 回傳網路錯誤（地圖上是空白格，不是整頁壞掉）', async () => {
  const { run } = boot({ online: false });
  const res = await run('fetch', req('https://tile.openstreetmap.org/12/1/1.png', { mode: 'no-cors' }));
  assert.equal(res.type, 'error');
});

test('圖磚：超過上限（4000）會刪最舊的', async () => {
  const { caches, run } = boot();
  const cache = await caches.open('tiles-v1');
  for (let i = 0; i < 3950; i++) await cache.put(`https://tile.openstreetmap.org/old/${i}.png`, new Response('x'));
  for (let i = 0; i < 100; i++) await run('fetch', req(`https://tile.openstreetmap.org/new/${i}.png`, { mode: 'no-cors' }));
  const keys = (await cache.keys()).map((k) => k.url);
  assert.equal(keys.length, 4000);
  assert.ok(!keys.includes('https://tile.openstreetmap.org/old/0.png'), '最舊的應該被刪掉');
  assert.ok(keys.includes('https://tile.openstreetmap.org/new/99.png'), '最新的要留著');
});
