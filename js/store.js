// store.js — 資料存哪裡、怎麼備份。
//
// 資料分兩處：
//   · localStorage：參拜紀錄（文字，很小）
//   · IndexedDB   ：照片縮圖（二進位，比較大，localStorage 放不下）
// 兩者都只存在「這支手機的這個瀏覽器」。清除瀏覽資料或換手機就會消失，
// 所以要定期用「匯出備份」存成檔案。

import {
  makeEntry,
  validateBackup,
  mergeImported,
  newId,
  BACKUP_APP,
  BACKUP_VERSION,
} from './model.js';
import { SAMPLES } from './samples.js';

const ENTRIES_KEY = 'goshuin-map:v1';
const DB_NAME = 'goshuin-map';
const PHOTO_STORE = 'photos';

/* ---------- 參拜紀錄（localStorage） ---------- */

/** 讀出所有紀錄。第一次使用（完全沒存過）會放入範例。 */
export function loadEntries() {
  try {
    const raw = localStorage.getItem(ENTRIES_KEY);
    if (raw === null) return SAMPLES.map(makeEntry);
    const data = JSON.parse(raw);
    return Array.isArray(data.entries) ? data.entries.map(makeEntry) : [];
  } catch {
    // localStorage 被擋、或內容壞掉：回到範例，至少畫面不是空白
    return SAMPLES.map(makeEntry);
  }
}

/** 存檔。成功回傳 true，失敗（空間滿、無痕模式）回傳 false，讓畫面提醒使用者。 */
export function saveEntries(entries) {
  try {
    localStorage.setItem(ENTRIES_KEY, JSON.stringify({ version: 1, entries }));
    return true;
  } catch {
    return false;
  }
}

/** 地圖底圖偏好（gsi / osm）。 */
export function loadPref(key, fallback) {
  try {
    return localStorage.getItem(`goshuin-map:pref:${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}
export function savePref(key, value) {
  try {
    localStorage.setItem(`goshuin-map:pref:${key}`, value);
  } catch {
    /* 存不了就算了，不影響使用 */
  }
}

/* ---------- 照片（IndexedDB） ---------- */

let dbPromise = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(PHOTO_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 在一個 transaction 裡執行 fn(store)，交易完成後回傳 request 的結果。 */
function withStore(mode, fn) {
  dbPromise ??= openDb();
  return dbPromise.then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, mode);
        const request = fn(tx.objectStore(PHOTO_STORE));
        tx.oncomplete = () => resolve(request ? request.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

/** 存一張縮圖，回傳它的 id。 */
export async function putPhoto(blob, id = newId('p')) {
  await withStore('readwrite', (s) => s.put(blob, id));
  return id;
}
export const getPhoto = (id) => withStore('readonly', (s) => s.get(id));
export const deletePhoto = (id) => withStore('readwrite', (s) => s.delete(id));

/* ---------- 備份與還原 ---------- */

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const dataUrlToBlob = async (dataUrl) => (await fetch(dataUrl)).blob();

/** 把紀錄與照片打包成一段 JSON 文字。 */
export async function buildBackup(entries) {
  const photos = {};
  for (const id of new Set(entries.flatMap((e) => e.photoIds))) {
    try {
      const blob = await getPhoto(id);
      if (blob) photos[id] = await blobToDataUrl(blob);
    } catch {
      /* 某張讀不到就跳過，其他照片照常備份 */
    }
  }
  return JSON.stringify(
    { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), entries, photos },
    null,
    1,
  );
}

/** 觸發瀏覽器下載一個文字檔。 */
export function downloadText(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 讀回備份檔文字，把新的紀錄與照片合併進現有資料。
 * 回傳 { entries, added, skipped }；檔案不合法會丟出 Error。
 */
export async function restoreBackup(text, existingEntries) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('這個檔案不是有效的 JSON');
  }
  const result = validateBackup(obj);
  if (!result.ok) throw new Error(result.error);

  const have = new Set(existingEntries.map((e) => e.id));
  for (const entry of result.entries) {
    if (have.has(entry.id)) continue; // 已存在的紀錄不覆蓋，照片也不動
    for (const id of entry.photoIds) {
      if (result.photos[id]) await putPhoto(await dataUrlToBlob(result.photos[id]), id);
    }
  }
  return mergeImported(existingEntries, result.entries);
}
