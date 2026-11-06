// placeid.js — 從 Google 地圖網址裡的「地點編號」推測大概位置。
//
// Google 地圖網址裡常有 0x6000e7bbc67c0001:0xa7f51dfe4d001f82 這種兩段編號（data=!1s… 或 ftid=…）。
// 這是 Google 沒有公開說明的內部編號。我的觀察是：第一段看起來是 S2 格網的格子編號（S2 是一種把地球表面
// 切成階層格子的編碼），解碼後會得到一個經緯度。用 8 個實際地點試過，其中 3 個和已知位置幾乎重合
// （差幾十公尺），3 個在合理的區域，1 個偏差約 5 公里，1 個無法確認。
// 所以這個位置只能當「提示」：用來縮小搜尋範圍、挑出同名地點裡最近的那一個，
// 或在搜尋不到時當作「推測的位置」讓使用者確認，絕對不要直接當成正確座標。
//
// 第二段是這個地點自己的識別碼，同一個地點在不同網址裡都一樣，可以用來辨認「是不是同一個地點」。

import { isValidLatLng } from './geo.js';

// S2 希爾伯特曲線的查表（位置 → 格內 i/j 位元；位置 → 方向變化）
const POS_TO_IJ = [
  [0, 1, 3, 2],
  [0, 2, 3, 1],
  [3, 2, 0, 1],
  [3, 1, 0, 2],
];
const POS_TO_ORIENTATION = [1, 0, 0, 3];

/** 找出網址或文字裡的兩段編號，回傳 { cell: BigInt, fprint: BigInt, key } 或 null。 */
export function parsePlaceId(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/0x([0-9a-f]{1,16})(?::|%3A)0x([0-9a-f]{1,16})/i);
  if (!m) return null;
  return { cell: BigInt(`0x${m[1]}`), fprint: BigInt(`0x${m[2]}`), key: m[2].toLowerCase() };
}

/** S2 格子編號 → 格子中心的 { lat, lng }。編號不合法回傳 null。 */
export function s2CellToLatLng(cellId) {
  const id = BigInt.asUintN(64, cellId);
  if (id === 0n) return null;
  const face = Number(id >> 61n);
  if (face > 5) return null;

  // 最後一個 1 位元是「結束標記」，它的位置決定這是第幾層的格子
  let lowBit = 0;
  while (((id >> BigInt(lowBit)) & 1n) === 0n) lowBit += 1;
  const level = 30 - lowBit / 2;
  if (!Number.isInteger(level) || level < 0 || level > 30) return null;

  let orientation = face & 1;
  let i = 0;
  let j = 0;
  for (let k = 0; k < 30; k++) {
    const pos = Number((id >> BigInt(2 * (29 - k) + 1)) & 3n);
    const ij = POS_TO_IJ[orientation][pos];
    orientation ^= POS_TO_ORIENTATION[pos];
    i = i * 2 + (ij >> 1);
    j = j * 2 + (ij & 1);
  }
  // 沒有細到第 30 層的格子，把沒用到的低位補成格子正中間
  const half = 2 ** (30 - level - 1);
  const s = (i + half) / 2 ** 30;
  const t = (j + half) / 2 ** 30;

  const stToUv = (x) => (x >= 0.5 ? (4 * x * x - 1) / 3 : (1 - 4 * (1 - x) * (1 - x)) / 3);
  const u = stToUv(s);
  const v = stToUv(t);
  const [x, y, z] = [
    [1, u, v],
    [-u, 1, v],
    [-u, -v, 1],
    [-1, -v, -u],
    [v, -1, -u],
    [v, u, -1],
  ][face];
  const lat = (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI;
  const lng = (Math.atan2(y, x) * 180) / Math.PI;
  return isValidLatLng(lat, lng) ? { lat, lng } : null;
}

/** 網址或文字 → 推測位置 { lat, lng }，沒有編號或解不出來回傳 null。 */
export function placeHint(text) {
  const id = parsePlaceId(text);
  return id ? s2CellToLatLng(id.cell) : null;
}

/** 網址或文字 → 這個地點的識別碼（第二段，小寫十六進位字串），沒有回傳 null。 */
export const placeKey = (text) => parsePlaceId(text)?.key ?? null;
