// photo.js — 從照片讀出「在哪裡、何時拍的」，並做出小張的縮圖。
//
// 重點：存下來的是「重新壓縮過的縮圖」，不是原檔。
// 重新壓縮會自然去掉 EXIF，所以備份檔裡的照片不會帶著你的 GPS 位置。

import { parse, gps } from '../vendor/exifr/full.esm.js';
import { isValidLatLng, parseExifDateTime, dateTimeFromMillis } from './geo.js';

/**
 * 讀取照片的拍攝位置與時間。
 * 回傳 { lat, lng, date, time, dateGuessed }；讀不到的欄位是 null。
 * 位置讀不到很常見：手機的檔案選擇器常會在上傳時移除位置資訊。
 */
export async function readPhotoMeta(file) {
  let lat = null;
  let lng = null;
  try {
    const pos = await gps(file);
    if (pos && isValidLatLng(pos.latitude, pos.longitude)) {
      lat = pos.latitude;
      lng = pos.longitude;
    }
  } catch {
    /* 沒有 EXIF 或格式讀不了 → 當作沒有位置 */
  }

  let when = null;
  try {
    // reviveValues: false → 拿到原始字串，由 parseExifDateTime 自己解析，避免時區把日期換掉
    const tags = await parse(file, { pick: ['DateTimeOriginal', 'CreateDate'], reviveValues: false });
    when = parseExifDateTime(tags?.DateTimeOriginal ?? tags?.CreateDate);
  } catch {
    /* 同上 */
  }

  let dateGuessed = false;
  if (!when) {
    when = dateTimeFromMillis(file.lastModified); // 備案：檔案修改時間，不一定準
    dateGuessed = when !== null;
  }
  return { lat, lng, date: when?.date ?? null, time: when?.time ?? null, dateGuessed };
}

/** 把照片解碼成可以畫到 canvas 的來源（會套用照片的旋轉資訊）。 */
async function decode(file) {
  if ('createImageBitmap' in window) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close?.() };
    } catch {
      /* 有些瀏覽器不支援這個選項或格式，改用 <img> */
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  return {
    source: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

/** 產生長邊不超過 maxSide 的 JPEG 縮圖（Blob）。 */
export async function makeThumb(file, maxSide = 960, quality = 0.78) {
  const img = await decode(file);
  try {
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext('2d').drawImage(img.source, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('縮圖失敗'))), 'image/jpeg', quality),
    );
  } finally {
    img.release();
  }
}

/** 檔案的「指紋」：同一張照片重複匯入時用來辨認。 */
export const photoKey = (file) => `${file.name}|${file.size}|${file.lastModified}`;
