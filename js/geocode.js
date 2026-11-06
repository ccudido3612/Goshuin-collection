// geocode.js — 「名稱 → 座標」與解析 Google 地圖網址。
//
// 為什麼需要：Google 地圖分享出來的網址只有「地點名稱與地址」，沒有座標。
// 所以要拿名稱去地名資料庫查座標，列出候選地點讓使用者確認（同名神社很多，不能全自動）。
// 會碰網路的部分（fetch、等待）都可以從參數傳入，方便在 node 測試。
//
// 使用的服務（都沒有在實機上驗證過能從網頁直接呼叫，見 README）：
//   · OpenStreetMap Nominatim  能用名稱找地點，也能「座標 → 地址」。使用規範：每秒最多 1 次，所以這裡會排隊等待。
//   · 国土地理院 地址搜尋       只在輸入看起來像「地址」時使用。它比對的是地址不是店名／寺社名，
//                               拿名稱去問會配到毫不相干的町名（例如「玉」→ 岐阜縣關原町玉），所以不拿來找名稱。
//
// 如果知道大概位置（hint，來自 placeid.js），搜尋會先在那附近找，並依距離排序，
// 同名的神社（各地都有稻荷神社）才不會跑到別的縣。

import { isValidLatLng, distanceMeters } from './geo.js';
import { coordsFromUrl } from './gmaps.js';
import { placeHint, placeKey } from './placeid.js';

/* ---------- 解析 Google 地圖網址或分享文字 ---------- */

/** 從一段文字裡找出第一個網址。 */
export const extractUrl = (text) => (typeof text === 'string' ? text.match(/https?:\/\/[^\s<>"']+/)?.[0] ?? null : null);

const isShortLink = (u) => u.hostname === 'maps.app.goo.gl' || (u.hostname === 'goo.gl' && u.pathname.startsWith('/maps'));
const isGoogleMaps = (u) => /(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname.startsWith('/maps');

/**
 * 解析 Google 地圖網址。回傳 { kind, name, address, query, lat, lng, link }，不是 Google 地圖網址回傳 null。
 *   kind  'short'（短連結，無法在網頁內展開）或 'full'
 *   query 拿去查座標用的字串（優先用名稱）
 *   hint  依網址裡的地點編號推測的大概位置（可能偏差數公里）；key 是這個地點的識別碼
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
    return { kind: 'short', name: '', address: '', query: '', lat: null, lng: null, hint: null, key: null, link: `${u.origin}${u.pathname}` };
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

  return {
    kind: 'full',
    name,
    address,
    query: name || address,
    lat: coords?.lat ?? null,
    lng: coords?.lng ?? null,
    hint: placeHint(u.href),
    key: placeKey(u.href),
    link,
  };
}

/* ---------- 搜尋用的寫法變化 ---------- */

// 常見的「台灣／舊字體 ↔ 日本新字體」。Google 清單常是前者，OpenStreetMap 的日本地名多半是後者（反之亦然）。
// 刻意不含「龍／竜」：兩種寫法在寺社名稱裡都常見，不能亂換。
const KANJI_PAIRS = ['淺浅', '稻稲', '滿満', '藏蔵', '虛虚', '澤沢', '國国', '櫻桜', '齋斎', '邊辺', '榮栄', '莊荘', '藥薬', '寶宝', '關関', '廣広', '圓円', '驛駅', '隱隠', '歷歴', '靈霊', '體体', '樂楽', '德徳', '眞真', '實実', '兒児', '來来', '鐵鉄', '壽寿', '觀観', '戀恋', '傳伝', '會会', '變変', '讓譲', '嚴厳', '應応', '豐豊', '禮礼', '靜静', '縣県', '條条', '區区', '號号', '學学', '氣気', '淨浄'].map((p) => [...p]);
const swap = (text, from) => [...text].map((c) => KANJI_PAIRS.find((p) => p[from] === c)?.[1 - from] ?? c).join('');
export const toShinjitai = (text) => swap(text, 0);
export const toKyujitai = (text) => swap(text, 1);

/** 輸入看起來像地址（有縣市區町、番地、郵遞區號）嗎？ */
export const looksLikeAddress = (q) => /[都道府県].*[市区町村郡]|\d+\s*(丁目|番地?|号)|〒?\d{3}-?\d{4}/.test(q);

/**
 * 一個名稱可能的幾種寫法，依優先順序，最多 5 個：
 *   「玉龍山 浄光寺」→ 原樣、去空白、只留寺名「浄光寺」、新舊字體互換
 *   「Ryuonji Temple」→ 原樣、去掉 Temple、「Ryuon-ji」（OpenStreetMap 的羅馬拼音常帶連字號）
 */
export function searchVariants(query) {
  const base = String(query ?? '').replace(/[\s　]+/g, ' ').trim();
  if (!base) return [];
  const list = [base];
  if (/^[\x20-\x7e]+$/.test(base)) {
    const bare = base.replace(/\b(Temple|Shrine|Jinja|Taisha|Jingu|Dera|Tera)\b/gi, '').replace(/\s+/g, ' ').trim();
    if (bare) {
      list.push(bare);
      const hyphen = bare.replace(/^([A-Za-z]+?)(ji|in|gu|dera|jinja|taisha|jingu)$/i, '$1-$2');
      if (hyphen !== bare) list.push(hyphen);
    }
  } else {
    const tokens = base.split(' ');
    if (tokens.length > 1) {
      const last = tokens.at(-1);
      if (/(寺|院|神社|大社|宮|社|堂|稲荷|稻荷)$/.test(last)) list.push(last);
      list.push(tokens.join(''));
    }
    for (const v of [...list]) {
      list.push(toShinjitai(v), toKyujitai(v));
    }
  }
  return [...new Set(list.filter(Boolean))].slice(0, 5);
}

/* ---------- 查座標 ---------- */

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const GSI = 'https://msearch.gsi.go.jp/address-search/AddressSearch';

/** Nominatim 的 address 物件 → 日文地址（〒郵遞區號 都道府縣市區町）。欄位不齊時盡量拼。 */
export function formatJpAddress(addr) {
  if (!addr || typeof addr !== 'object') return '';
  const parts = [addr.province ?? addr.state, addr.county, addr.city ?? addr.town ?? addr.village, addr.city_district ?? addr.borough, addr.suburb, addr.quarter, addr.neighbourhood, addr.road, addr.house_number];
  const body = parts.filter((p, i) => p && parts.indexOf(p) === i).join('');
  return `${addr.postcode ? `〒${addr.postcode} ` : ''}${body}`.trim();
}

export function parseNominatim(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => {
      const detail = formatJpAddress(r.address) || String(r.display_name ?? '').trim();
      return {
        title: String(r.name || r.display_name?.split(',')[0] || '').trim(),
        detail,
        address: detail,
        lat: Number(r.lat),
        lng: Number(r.lon),
        source: 'OpenStreetMap',
      };
    })
    .filter((r) => isValidLatLng(r.lat, r.lng));
}

export function parseGsi(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => {
      const title = String(r.properties?.title ?? '').trim();
      return { title, detail: title, address: title, lat: Number(r.geometry?.coordinates?.[1]), lng: Number(r.geometry?.coordinates?.[0]), source: '地理院' };
    })
    .filter((r) => isValidLatLng(r.lat, r.lng));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SPAN = { lat: 0.25, lng: 0.3 }; // 有推測位置時，先在它周圍約 ±25 公里內找

/**
 * 建立查詢器。
 *   search(query, { hint })  回傳 { results, error }。results 最多 maxResults 筆，去掉彼此約 50 公尺內的重複。
 *                            有 hint 時依距離排序、每筆附 distanceKm，並在最後附上「推測位置」本身當最後手段。
 *   reverse(lat, lng)        回傳 { address, error }，座標 → 日文地址（町、大字等級，不到門牌）。
 * Nominatim 規範每秒最多 1 次，所以兩次請求之間至少間隔 minIntervalMs。
 * 單一請求失敗不會丟錯；所有請求都失敗才回報 error。
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

  const nominatimUrl = (q, hint, bounded) => {
    const params = new URLSearchParams({ q, format: 'jsonv2', limit: String(maxResults), countrycodes: 'jp', 'accept-language': 'ja', addressdetails: '1' });
    if (hint && bounded) {
      params.set('viewbox', [hint.lng - SPAN.lng, hint.lat + SPAN.lat, hint.lng + SPAN.lng, hint.lat - SPAN.lat].join(','));
      params.set('bounded', '1');
    }
    return `${NOMINATIM}/search?${params}`;
  };

  return {
    async search(query, { hint = null } = {}) {
      const q = String(query ?? '').trim();
      if (!q) return { results: [], error: null };
      const out = [];
      let attempts = 0;
      let failures = 0;
      const run = async (url, parse) => {
        attempts += 1;
        try {
          const found = parse(await throttled(url));
          out.push(...found);
          return found.length;
        } catch {
          failures += 1;
          return 0;
        }
      };

      const variants = searchVariants(q);
      if (looksLikeAddress(q)) await run(`${GSI}?${new URLSearchParams({ q })}`, parseGsi);
      if (hint) for (const v of variants.slice(0, 3)) if (await run(nominatimUrl(v, hint, true), parseNominatim)) break;
      if (out.length === 0) for (const v of variants.slice(0, hint ? 2 : 3)) if (await run(nominatimUrl(v, hint, false), parseNominatim)) break;

      const unique = [];
      for (const r of out) {
        if (!unique.some((u) => Math.abs(u.lat - r.lat) < 0.0005 && Math.abs(u.lng - r.lng) < 0.0005)) unique.push(r);
      }
      if (hint) {
        for (const r of unique) r.distanceKm = distanceMeters(hint, r) / 1000;
        unique.sort((a, b) => a.distanceKm - b.distanceKm);
      }
      const results = unique.slice(0, maxResults);
      if (hint) {
        results.push({
          title: '依 Google 地點編號推測的位置',
          detail: `約 ${hint.lat.toFixed(4)}, ${hint.lng.toFixed(4)}。可能偏差數公里，選了之後請在地圖上確認`,
          address: '',
          lat: hint.lat,
          lng: hint.lng,
          source: '推測',
          approximate: true,
        });
      }
      return { results, error: attempts > 0 && failures === attempts && !hint ? '無法連線到地名搜尋服務' : null };
    },

    async reverse(lat, lng) {
      if (!isValidLatLng(lat, lng)) return { address: '', error: '座標不正確' };
      try {
        const params = new URLSearchParams({ lat: String(lat), lon: String(lng), format: 'jsonv2', zoom: '17', 'accept-language': 'ja', addressdetails: '1' });
        const r = await throttled(`${NOMINATIM}/reverse?${params}`);
        const address = formatJpAddress(r.address) || String(r.display_name ?? '').trim();
        return address ? { address, error: null } : { address: '', error: '查不到這個位置的地址' };
      } catch {
        return { address: '', error: '無法連線到地名搜尋服務' };
      }
    },
  };
}
