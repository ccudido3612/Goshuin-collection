// 測試用的假 CacheStorage：只實作這個專案會用到的部分。
// 鍵一律用網址字串（真正的 Cache 會存 Request，行為對這裡的用途等價）。

// 真正的 Cache 會把相對網址字串依「目前的 service worker 位置」解析成完整網址；這裡用固定的基底模擬。
const BASE = 'https://me.github.io/goshuin-map/';
const urlOf = (x) => new URL(typeof x === 'string' ? x : x.url, BASE).href;

export class FakeCache {
  constructor(fetchImpl) {
    this.map = new Map();
    this.fetchImpl = fetchImpl;
  }
  async match(req, opts = {}) {
    const want = urlOf(req);
    const strip = (u) => (opts.ignoreSearch ? u.split('?')[0] : u);
    for (const [key, res] of this.map) if (strip(key) === strip(want)) return res;
    return undefined;
  }
  async put(req, res) {
    this.map.set(urlOf(req), res);
  }
  async delete(req) {
    return this.map.delete(urlOf(req));
  }
  async keys() {
    return [...this.map.keys()].map((url) => ({ url }));
  }
  async addAll(requests) {
    // 全有或全無：先全部抓成功，才一次寫入
    const fetched = [];
    for (const r of requests) {
      const res = await this.fetchImpl(r);
      if (!res.ok) throw new TypeError(`addAll: ${urlOf(r)} -> ${res.status}`);
      fetched.push([urlOf(r), res]);
    }
    for (const [k, v] of fetched) this.map.set(k, v);
  }
}

export class FakeCacheStorage {
  constructor(fetchImpl) {
    this.caches = new Map();
    this.fetchImpl = fetchImpl;
  }
  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache(this.fetchImpl));
    return this.caches.get(name);
  }
  async keys() {
    return [...this.caches.keys()];
  }
  async delete(name) {
    return this.caches.delete(name);
  }
  async has(name) {
    return this.caches.has(name);
  }
  async match(req, opts = {}) {
    const names = opts.cacheName ? [opts.cacheName] : [...this.caches.keys()];
    for (const n of names) {
      const hit = await this.caches.get(n)?.match(req, opts);
      if (hit) return hit;
    }
    return undefined;
  }
}
