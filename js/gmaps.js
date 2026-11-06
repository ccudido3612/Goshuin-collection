// gmaps.js — 讀取從 Google 地圖匯出的「想去」清單（純函式，不碰瀏覽器）。
//
// Google 沒有開放讀取「已儲存清單」的官方介面，所以只能讀匯出的檔案：
//   · CSV     Google Takeout 的已儲存清單（通常只有名稱、備註、連結，沒有座標）
//   · GeoJSON Takeout 的「已加星號的地點／Saved Places.json」，或其他工具匯出的（有座標）
//   · KML     My Maps 圖層匯出的（有座標）
// 讀出來的東西統一成 { name, note, link, lat, lng }；沒有座標的 lat / lng 是 null。
// 我手上沒有真實的 Takeout 檔，欄位名稱是依公開說明推測，所以對欄位名稱放寬比對。

import { isValidLatLng } from './geo.js';
import { makeEntry, hasLocation } from './model.js';
import { placeHint, placeKey } from './placeid.js';

/* ---------- CSV ---------- */

/** 簡單的 CSV 解析：支援雙引號、引號內的逗號與換行、"" 代表一個引號、開頭的 BOM。 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') (field += '"'), i++;
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') (row.push(field), (field = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) (row.push(field), rows.push(row));
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const HEADER_ALIASES = {
  name: ['title', 'name', '名稱', '標題', '地點名稱'],
  note: ['note', 'notes', 'comment', 'comments', '備註', '附註', '說明', '註解'],
  link: ['url', 'link', '連結', '網址'],
};

function columnIndex(header, aliases) {
  const norm = header.map((h) => h.trim().toLowerCase());
  return norm.findIndex((h) => aliases.includes(h));
}

export function parseCsvList(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0];
  const iName = columnIndex(header, HEADER_ALIASES.name);
  const iLink = columnIndex(header, HEADER_ALIASES.link);
  if (iName < 0 && iLink < 0) return [];
  // 有些匯出同時有 Note 與 Comment 欄，兩個都收進備註
  const noteCols = header
    .map((h, i) => (HEADER_ALIASES.note.includes(h.trim().toLowerCase()) ? i : -1))
    .filter((i) => i >= 0);

  return rows.slice(1).map((r) => {
    const link = (iLink >= 0 ? r[iLink] : '').trim();
    const coords = coordsFromUrl(link);
    return {
      name: (iName >= 0 ? r[iName] : '').trim(),
      note: noteCols.map((i) => (r[i] ?? '').trim()).filter(Boolean).join('\n'),
      link,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      hint: placeHint(link),
    };
  });
}

/* ---------- 網址裡的座標 ---------- */

/** 從 Google 地圖網址找座標：@緯度,經度 ／ !3d緯度!4d經度 ／ ?q=緯度,經度。找不到回傳 null。 */
export function coordsFromUrl(url) {
  if (typeof url !== 'string') return null;
  const patterns = [/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/, /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/, /[?&](?:q|ll|query)=(-?\d+(?:\.\d+)?)(?:,|%2C)(-?\d+(?:\.\d+)?)/i];
  for (const re of patterns) {
    const m = url.match(re);
    if (m && isValidLatLng(Number(m[1]), Number(m[2]))) return { lat: Number(m[1]), lng: Number(m[2]) };
  }
  return null;
}

/* ---------- GeoJSON ---------- */

export function parseGeoJson(obj) {
  const features = Array.isArray(obj?.features) ? obj.features : [];
  const out = [];
  for (const f of features) {
    const p = f?.properties ?? {};
    const loc = p.Location ?? p.location ?? {};
    // Takeout 的「已加星號的地點」用小寫欄位（location.name / location.address / google_maps_url），舊版或其他工具用大寫
    const name = String(p.Title ?? p.title ?? p.name ?? p.Name ?? loc['Business Name'] ?? loc.name ?? '').trim();
    const address = String(loc.Address ?? loc.address ?? '').trim();
    const link = String(p['Google Maps URL'] ?? p.google_maps_url ?? p.url ?? p.URL ?? '').trim();
    const note = String(p.Comment ?? p.comment ?? p.Note ?? p.note ?? p.description ?? '').trim();
    const c = f?.geometry?.type === 'Point' ? f.geometry.coordinates : null; // GeoJSON 順序是 [經度, 緯度]
    let lat = null;
    let lng = null;
    if (Array.isArray(c) && isValidLatLng(Number(c[1]), Number(c[0]))) (lat = Number(c[1])), (lng = Number(c[0]));
    else {
      const fromUrl = coordsFromUrl(link);
      if (fromUrl) (lat = fromUrl.lat), (lng = fromUrl.lng);
    }
    if (name || link) out.push({ name, note, link, lat, lng, address, hint: placeHint(link) });
  }
  return out;
}

/* ---------- KML ---------- */

const decodeXml = (s) =>
  s
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeXml(m[1]) : '';
};

export function parseKml(text) {
  const out = [];
  for (const m of text.matchAll(/<Placemark[\s>][\s\S]*?<\/Placemark>/gi)) {
    const block = m[0];
    const point = block.match(/<Point[\s>][\s\S]*?<\/Point>/i)?.[0];
    let lat = null;
    let lng = null;
    if (point) {
      const [x, y] = tag(point, 'coordinates').split(/[,\s]+/).map(Number); // KML 順序是 經度,緯度,高度
      if (isValidLatLng(y, x)) (lat = y), (lng = x);
    }
    const name = tag(block, 'name');
    // My Maps 匯入 Takeout CSV 後再匯出的 KML：筆記與網址放在 ExtendedData，description 只是它們的合併文字
    const data = (label) => {
      const m = block.match(new RegExp(`<Data\\s+name="${label}"[^>]*>\\s*<value>([\\s\\S]*?)</value>`, 'i'));
      return m ? decodeXml(m[1]) : '';
    };
    const link = data('網址') || data('URL') || data('url');
    const note = [data('筆記') || data('Note'), data('留言') || data('Comment')].filter(Boolean).join('\n')
      || (link ? '' : tag(block, 'description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (name || point) out.push({ name, note, link, lat, lng, hint: placeHint(link) });
  }
  return out;
}

/* ---------- 入口 ---------- */

/** 依內容判斷格式並解析。回傳 { items } 或 { error }。 */
export function parseGoogleList(text) {
  const t = text.replace(/^﻿/, '').trim();
  if (!t) return { error: '檔案是空的' };
  let items;
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const obj = JSON.parse(t);
      items = parseGeoJson(Array.isArray(obj) ? { features: obj } : obj);
    } catch {
      return { error: '看起來是 JSON，但格式不正確' };
    }
  } else if (t.startsWith('<')) items = parseKml(t);
  else items = parseCsvList(t);
  if (items.length === 0) return { error: '找不到可匯入的地點。支援 Google Takeout 的 CSV／GeoJSON，或 My Maps 匯出的 KML。' };
  return { items };
}

/* ---------- 轉成紀錄 ---------- */

const hash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

/** 名稱裡有「寺」「院」就當寺院，其他當神社（這份清單的用途是神社）。 */
export const guessKind = (name) => (/[寺院]/.test(name) && !/神社|神宮|八幡|稲荷|稻荷/.test(name) ? 'temple' : 'shrine');

/**
 * 轉成「想去」紀錄。id 優先由 Google 的地點識別碼算出（同一個地點，不論是從 CSV、KML 或網址來的，id 都一樣），
 * 沒有的話由名稱與連結算出。同一份清單再匯入一次不會重複。
 */
export function itemsToEntries(items) {
  const seen = new Set();
  const entries = [];
  for (const item of items) {
    const key = placeKey(item.link);
    const id = key ? `gm_${key}` : `gm_${hash(`${item.name}|${item.link}|${item.lat}|${item.lng}`)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(
      makeEntry({
        id,
        name: item.name || '（未命名）',
        kind: guessKind(item.name),
        status: 'want',
        lat: item.lat,
        lng: item.lng,
        note: item.note,
        link: item.link,
        address: item.address ?? '',
        hint: item.hint ?? null,
      }),
    );
  }
  return entries;
}

const normName = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

/**
 * 把匯入的紀錄併進現有清單。已經有的（同 id、同一個 Google 地點、或同名稱）不新增，
 * 但會把缺的資料補進去：沒有位置就補位置、沒有推測位置就補推測位置、沒有地址就補地址。
 * 已經有位置的紀錄，位置絕不覆蓋。回傳 { entries, added, updated, skipped }。
 */
export function mergeGoogleImport(existing, incoming) {
  const entries = existing.map((e) => ({ ...e }));
  const result = { entries, added: 0, updated: 0, skipped: 0 };
  for (const item of incoming) {
    const key = placeKey(item.link);
    const match = entries.find((e) => e.id === item.id || (key && placeKey(e.link) === key) || (normName(e.name) && normName(e.name) === normName(item.name)));
    if (!match) {
      entries.push(item);
      result.added += 1;
      continue;
    }
    let changed = false;
    if (!hasLocation(match) && hasLocation(item)) ((match.lat = item.lat), (match.lng = item.lng), (changed = true));
    if (!match.hint && item.hint) ((match.hint = item.hint), (changed = true));
    if (!match.address && item.address) ((match.address = item.address), (changed = true));
    if (!match.link && item.link) ((match.link = item.link), (changed = true));
    if (!match.note && item.note) ((match.note = item.note), (changed = true));
    if (changed) result.updated += 1;
    else result.skipped += 1;
  }
  return result;
}
