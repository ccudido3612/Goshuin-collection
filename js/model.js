// model.js — 資料的長相，以及不碰瀏覽器的資料操作（建立、篩選、合併、驗證備份）。
// 儲存到 localStorage / IndexedDB 的部分在 store.js。

import { isValidLatLng } from './geo.js';

export const KINDS = { shrine: '神社', temple: '寺院', other: '其他' };
export const KIND_GLYPH = { shrine: '社', temple: '寺', other: '印' };
export const STATUS_LABEL = { want: '想去', got: '已集' };
export const BACKUP_APP = 'goshuin-map';
export const BACKUP_VERSION = 1;

export function newId(prefix = 'e') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 建立一筆「參拜紀錄」。所有欄位都會被整理成合法的值，
 * 所以匯入別人給的 JSON 時也安全（不合法的欄位會被丟掉或換成預設值）。
 *
 * photoIds[i] 對應 IndexedDB 裡的一張縮圖；photoKeys[i] 是原檔的指紋，
 * 用來避免同一張照片重複匯入。
 */
export function makeEntry(fields = {}) {
  const located = isValidLatLng(fields.lat, fields.lng);
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    id: typeof fields.id === 'string' && fields.id ? fields.id : newId(),
    name: text(fields.name, 80),
    kind: Object.hasOwn(KINDS, fields.kind) ? fields.kind : 'shrine',
    status: fields.status === 'got' ? 'got' : 'want',
    lat: located ? fields.lat : null,
    lng: located ? fields.lng : null,
    visitedAt: /^\d{4}-\d{2}-\d{2}$/.test(fields.visitedAt ?? '') ? fields.visitedAt : null,
    note: text(fields.note, 2000),
    // 只接受 http(s) 連結（例如從 Google 地圖清單匯入的原始連結），避免 javascript: 之類的網址
    link: /^https?:\/\//i.test(fields.link ?? '') ? fields.link.slice(0, 1000) : '',
    photoIds: Array.isArray(fields.photoIds) ? fields.photoIds.filter((x) => typeof x === 'string') : [],
    photoKeys: Array.isArray(fields.photoKeys) ? fields.photoKeys.filter((x) => typeof x === 'string') : [],
    sample: Boolean(fields.sample),
    createdAt: typeof fields.createdAt === 'string' ? fields.createdAt : new Date().toISOString(),
  };
}

export const hasLocation = (entry) => entry.lat !== null && entry.lng !== null;
export const displayName = (entry) => entry.name.trim() || '（未命名）';

/** 統計：已集、想去、還沒有位置的數量。 */
export function summarize(entries) {
  return {
    total: entries.length,
    got: entries.filter((e) => e.status === 'got').length,
    want: entries.filter((e) => e.status === 'want').length,
    unlocated: entries.filter((e) => !hasLocation(e)).length,
  };
}

/** 排序：有日期的新到舊，沒日期的依建立時間新到舊排在後面。 */
export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.visitedAt && b.visitedAt && a.visitedAt !== b.visitedAt) {
      return b.visitedAt.localeCompare(a.visitedAt);
    }
    if (a.visitedAt && !b.visitedAt) return -1;
    if (!a.visitedAt && b.visitedAt) return 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/** 清單篩選。filter: all | want | got | unlocated；query 比對名稱與備註。 */
export function filterEntries(entries, { filter = 'all', query = '' } = {}) {
  const q = query.trim().toLowerCase();
  return sortEntries(entries).filter((e) => {
    if (filter === 'want' && e.status !== 'want') return false;
    if (filter === 'got' && e.status !== 'got') return false;
    if (filter === 'unlocated' && hasLocation(e)) return false;
    if (q && !`${e.name}\n${e.note}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** 合併匯入的資料：id 已存在的保留現有的，只加入新的。 */
export function mergeImported(existing, incoming) {
  const have = new Set(existing.map((e) => e.id));
  const added = incoming.filter((e) => !have.has(e.id));
  return {
    entries: [...existing, ...added],
    added: added.length,
    skipped: incoming.length - added.length,
  };
}

/**
 * 檢查備份檔。成功回傳 { ok: true, entries, photos }，
 * photos 是 { 照片id: "data:image/..." }；失敗回傳 { ok: false, error }。
 */
export function validateBackup(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: '檔案內容不是有效的 JSON 物件' };
  if (obj.app !== BACKUP_APP) return { ok: false, error: '這不是「御朱印地圖」的備份檔' };
  if (!Array.isArray(obj.entries)) return { ok: false, error: '備份檔裡找不到 entries' };

  const entries = obj.entries.map((e) => makeEntry(e));
  const photos = {};
  if (obj.photos && typeof obj.photos === 'object') {
    for (const [id, dataUrl] of Object.entries(obj.photos)) {
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) photos[id] = dataUrl;
    }
  }
  return { ok: true, entries, photos };
}
