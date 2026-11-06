// geo.js — 座標與日期的純函式。
// 「純函式」= 同樣的輸入一定得到同樣的輸出，不碰畫面、不碰瀏覽器 API。
// 好處：可以直接用 node 跑測試（見 tests/），也最適合初學時閱讀。

const EARTH_RADIUS_M = 6371000;
const toRad = (deg) => (deg * Math.PI) / 180;

/** 兩個座標之間的距離（公尺），用 haversine 公式。a、b 都是 { lat, lng }。 */
export function distanceMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 座標是否可用。 (0, 0) 常是相機沒抓到 GPS 時留下的假值，所以也排除。 */
export function isValidLatLng(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/**
 * 解析 EXIF 的日期字串，例如 "2026:11:02 14:50:01"。
 * 回傳 { date: "2026-11-02", time: "14:50" }，格式不對就回傳 null。
 * EXIF 日期沒有時區，這裡刻意不轉成 Date，避免被時區偷偷改掉日期。
 */
export function parseExifDateTime(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  if (y === '0000' || mo === '00' || d === '00') return null;
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
}

/** 使用者本機時間的今天，格式 YYYY-MM-DD（給 <input type="date"> 用）。 */
export function todayISO(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 檔案的最後修改時間 → { date, time }。拿不到 EXIF 日期時的備案。 */
export function dateTimeFromMillis(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return { date: todayISO(d), time: `${p(d.getHours())}:${p(d.getMinutes())}` };
}

/** 2026-11-02 → 2026/11/02。空值回傳空字串。 */
export function formatDate(iso) {
  return iso ? iso.replaceAll('-', '/') : '';
}

/** 在 Google 地圖開啟某座標（給導航用）。 */
export function mapsUrl(lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

/**
 * 把一批照片合併成「一次參拜」。
 * 規則：同一天、而且距離第一張照片 radiusM 公尺以內，算同一個地點。
 * 沒有位置的照片，同一天的併成一組（之後再手動補位置）。
 *
 * items: [{ lat, lng, date, time, ... }]（多餘欄位會原樣保留）
 * 回傳:   [{ date, lat, lng, items: [...] }]
 */
export function groupPhotos(items, radiusM = 150) {
  const NO_DATE = '9999-99-99'; // 沒日期的排最後
  const sorted = [...items].sort(
    (a, b) =>
      (a.date ?? NO_DATE).localeCompare(b.date ?? NO_DATE) ||
      (a.time ?? '').localeCompare(b.time ?? ''),
  );

  const groups = [];
  for (const item of sorted) {
    const located = isValidLatLng(item.lat, item.lng);
    const date = item.date ?? null;
    const target = groups.find(
      (g) =>
        g.date === date &&
        (located
          ? g.anchor && distanceMeters(g.anchor, item) <= radiusM
          : g.anchor === null),
    );
    if (target) {
      target.items.push(item);
    } else {
      groups.push({
        date,
        anchor: located ? { lat: item.lat, lng: item.lng } : null,
        items: [item],
      });
    }
  }

  return groups.map((g) => ({
    date: g.date,
    lat: g.anchor ? g.anchor.lat : null,
    lng: g.anchor ? g.anchor.lng : null,
    items: g.items,
  }));
}
