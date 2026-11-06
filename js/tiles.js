// tiles.js — 地圖圖磚的計算（純函式）。
//
// 網路地圖把世界切成很多 256×256 的小方塊（圖磚），每個縮放層級 z 切成 2^z × 2^z 塊。
// 要「預先下載某個範圍」，就是算出這個範圍涵蓋哪些 (z, x, y)，再一張張抓回來。
// 這裡只做算術，不碰網路，所以可以在 node 直接測試。
// 注意：沒有處理跨越國際換日線的範圍（日本用不到）。

const MAX_LAT = 85.0511287798; // Web Mercator 能表示的最大緯度

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 經度 → 該層級的圖磚 x 編號。 */
export function lngToTileX(lng, z) {
  const n = 2 ** z;
  return clamp(Math.floor(((lng + 180) / 360) * n), 0, n - 1);
}

/** 緯度 → 該層級的圖磚 y 編號（北邊的 y 比較小）。 */
export function latToTileY(lat, z) {
  const n = 2 ** z;
  const rad = (clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n);
  return clamp(y, 0, n - 1);
}

/** 一塊圖磚涵蓋的經緯度範圍（用來驗算與測試）。 */
export function tileBounds(x, y, z) {
  const n = 2 ** z;
  const lat = (row) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return {
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
    north: lat(y),
    south: lat(y + 1),
  };
}

/** 範圍 bounds = { west, south, east, north } 在層級 z 涵蓋的圖磚編號區間。 */
export function tileRange(bounds, z) {
  return {
    x0: lngToTileX(bounds.west, z),
    x1: lngToTileX(bounds.east, z),
    y0: latToTileY(bounds.north, z),
    y1: latToTileY(bounds.south, z),
  };
}

export function countTiles(bounds, z) {
  const r = tileRange(bounds, z);
  return (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
}

/**
 * 規劃要下載哪些層級。層級越細，圖磚數量成長越快（每放大一級約 4 倍），
 * 所以從 maxZoom 開始，超過上限 cap 就降一級，直到放得下為止。
 * 回傳 { minZoom, maxZoom, count, reduced, tooLarge }：
 *   reduced  = 最細層級被降低了
 *   tooLarge = 連最粗的層級都超過上限（範圍太大，應該請使用者先放大地圖）
 */
export function planTiles(bounds, { minZoom, maxZoom, cap }) {
  const lo = Math.min(minZoom, maxZoom);
  const total = (hi) => {
    let sum = 0;
    for (let z = lo; z <= hi; z++) sum += countTiles(bounds, z);
    return sum;
  };
  let top = maxZoom;
  while (top > lo && total(top) > cap) top--;
  const count = total(top);
  return { minZoom: lo, maxZoom: top, count, reduced: top < maxZoom, tooLarge: count > cap };
}

/** 依序產生每一塊圖磚 { z, x, y }。 */
export function* iterateTiles(bounds, minZoom, maxZoom) {
  for (let z = minZoom; z <= maxZoom; z++) {
    const r = tileRange(bounds, z);
    for (let x = r.x0; x <= r.x1; x++) {
      for (let y = r.y0; y <= r.y1; y++) yield { z, x, y };
    }
  }
}

/** 把 'https://…/{z}/{x}/{y}.png' 填成實際網址。必須和 Leaflet 請求的網址一模一樣，快取才找得到。 */
export const fillTemplate = (template, z, x, y) =>
  template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

/** 每張圖磚大約幾 KB。這只是粗估，實際大小依地區和底圖而不同。 */
export const ESTIMATED_KB_PER_TILE = 15;
export const estimateMB = (count) => (count * ESTIMATED_KB_PER_TILE) / 1024;
