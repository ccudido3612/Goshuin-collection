// geocode.js — 「名稱 → 座標」與解析 Google 地圖網址。
//
// 為什麼需要：Google 地圖分享出來的網址只有「地點名稱與地址」，沒有座標。
// 所以要拿名稱去地名資料庫查座標，列出候選地點讓使用者確認（同名神社很多，不能全自動）。
// 會碰網路的部分（fetch、等待）都可以從參數傳入，方便在 node 測試。
//
// 使用的服務（都沒有在實機上驗證過能從網頁直接呼叫，見 README）：
//   · OpenStreetMap Nominatim  能用名稱找地點。使用規範：每秒最多 1 次，所以這裡會排隊等待。
//   · 国土地理院 地址搜尋       用日文地名／地址找，當作備援。

import { isValidLatLng } from './geo.js';
import { coordsFromUrl } from './gmaps.js';

/* ---------- 解析 Google 地圖網址或分享文字 ---------- */

/** 從一段文字裡找出第一個網址。 */
export const extractUrl = (text) => (typeof text === 'string' ? text.match(/https?:\/\/[^\s<>"']+/)?.[0] ?? null : null);

const isShortLink = (u) => u.hostname === 'maps.app.goo.gl' || (u.hostname === 'goo.gl' && u.pathname.startsWith('/maps'));
const isGoogleMaps = (u) => /(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname.startsWith('/maps');

/**
 * 解析 Google 地圖網址。回傳 { kind, name, address, query, lat, lng, link }，不是 Google 地圖網址回傳 null。
 *   kind  'short'（短連結，無法在網頁內展開）或 'full'
 *   query 拿去查座標用的字串（優先用名稱）
 *   link  整理過的短網址，存進紀錄用（原網址常常有上千字的追蹤參數）
 */
export function parseMapsLink(input) {
  const raw = extractUrl(input) ?? (typeof input === 'string' ? input.trim() : '');
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (isShortLink(u)) {
    return { kind: 'short', name: '', address: '', query: '', lat: null, lng: null, link: `${u.origin}${u.pathname}` };
  }
  if (!isGoogleMaps(u)) return null;

  const coords = coordsFromUrl(u.href);
  const q = u.searchParams.get('q') ?? '';
  const placeMatch = u.pathname.match(/^\/maps\/place\/([^/]+)/);
  const placeName = placeMatch ? decodeURIComponent(placeMatch[1].replace(/\+/g, ' ')).trim() : '';

  let name = '';
  let address = '';
  if (q && !coordsFromUrl(`?q=${q}`)) {
    // q 通常是「名稱 地址」，名稱和地址之間是空白，地址從數字開頭（門牌、郵遞區號）
    const m = q.match(/^(.*?)\s+(\d.*)$/);
    if (m && m[1]) (name = m[1].trim()), (address = m[2].trim());
    else if (/^\d/.test(q)) address = q.trim();
    else name = q.trim();
  }
  if (!name) name = placeName;

  const ftid = u.searchParams.get('ftid');
  const link = placeMatch
    ? `${u.origin}${u.pathname}`
    : `${u.origin}/maps?q=${encodeURIComponent(q)}${ftid ? `&ftid=${encodeURIComponent(ftid)}` : ''}`.slice(0, 900);

  return { kind: 'full', name, address, query: name || address, lat: coords?.lat ?? null, lng: coords?.lng ?? null, link };
}

/* ---------- 查座標 ---------- */

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const GSI = 'https://msearch.gsi.go.jp/address-search/AddressSearch';

export function parseNominatim(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => ({
      title: String(r.name || r.display_name?.split(',')[0] || '').trim(),
      detail: String(r.display_name ?? '').trim(),
      lat: Number(r.lat),
      lng: Number(r.lon),
      source: 'OpenStreetMap',
    }))
    .filter((r) => isValidLatLng(r.lat, r.lng));
}

export function parseGsi(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => ({
      title: String(r.properties?.title ?? '').trim(),
      detail: String(r.properties?.title ?? '').trim(),
      lat: Number(r.geometry?.coordinates?.[1]),
      lng: Number(r.geometry?.coordinates?.[0]),
      source: '地理院',
    }))
    .filter((r) => isValidLatLng(r.lat, r.lng));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 建立查詢器。search(query) 回傳候選地點陣列（最多 maxResults 筆，去掉彼此幾乎重疊的）。
 * Nominatim 規範每秒最多 1 次，所以兩次請求之間至少間隔 minIntervalMs。
 * 任何一個服務失敗（網路、被擋）都不會丟錯，只是少一個來源；兩個都失敗才回報 error。
 */
export function createGeocoder({ fetchImpl = globalThis.fetch, wait = sleep, minIntervalMs = 1100, maxResults = 5 } = {}) {
  let last = 0;
  const throttled = async (url) => {
    const gap = last + minIntervalMs - Date.now();
    if (last && gap > 0) await wait(gap);
    last = Date.now();
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  return {
    async search(query) {
      const q = String(query ?? '').trim();
      if (!q) return { results: [], error: null };
      const out = [];
      let failures = 0;

      try {
        const params = new URLSearchParams({ q, format: 'jsonv2', limit: String(maxResults), countrycodes: 'jp', 'accept-language': 'ja' });
        out.push(...parseNominatim(await throttled(`${NOMINATIM}?${params}`)));
      } catch {
        failures += 1;
      }
      if (out.length < 2) {
        try {
          out.push(...parseGsi(await throttled(`${GSI}?${new URLSearchParams({ q })}`)));
        } catch {
          failures += 1;
        }
      }

      // 去掉幾乎同一個位置（約 50 公尺內）的重複候選
      const unique = [];
      for (const r of out) {
        if (!unique.some((u) => Math.abs(u.lat - r.lat) < 0.0005 && Math.abs(u.lng - r.lng) < 0.0005)) unique.push(r);
      }
      return { results: unique.slice(0, maxResults), error: failures === 2 ? '無法連線到地名搜尋服務' : null };
    },
  };
}
