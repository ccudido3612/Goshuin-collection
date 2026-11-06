// main.js — 把畫面、地圖、資料接在一起。
//
// 讀程式的順序建議：
//   1. state          現在畫面的狀態都放在這一個物件
//   2. renderAll()    狀態改變 → 重畫（統計、圖釘、清單）
//   3. openDetail()   點圖釘或清單 → 打開詳細資料
//   4. importPhotos() 從照片匯入（這個 app 最有用的功能）

import {
  KINDS,
  KIND_GLYPH,
  STATUS_LABEL,
  makeEntry,
  displayName,
  hasLocation,
  summarize,
  filterEntries,
  mergeImported,
} from './model.js';
import { todayISO, formatDate, mapsUrl, groupPhotos, isValidLatLng } from './geo.js';
import {
  loadEntries,
  saveEntries,
  putPhoto,
  getPhoto,
  deletePhoto,
  buildBackup,
  downloadText,
  restoreBackup,
} from './store.js';
import { readPhotoMeta, makeThumb, photoKey } from './photo.js';
import { createMap } from './map.js';
import { parseGoogleList, itemsToEntries } from './gmaps.js';
import { parseMapsLink, createGeocoder } from './geocode.js';
import { planTiles, iterateTiles, estimateMB } from './tiles.js';
import {
  registerServiceWorker,
  watchOnline,
  requestPersistence,
  cacheStats,
  clearTiles,
  prefetchTiles,
  MAX_CACHED_TILES,
} from './offline.js';

/* ---------- 小工具 ---------- */

const $ = (selector) => document.querySelector(selector);

/**
 * 建立 DOM 元素。文字一律用 textContent / createTextNode，
 * 所以使用者輸入的內容（例如寺社名稱）不會被當成 HTML 執行。
 * 用法：h('button', { class: 'btn', onclick: fn }, '文字', 子元素...)
 */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

let toastTimer = 0;
function toast(message, ms = 3500) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function busy(message) {
  $('#busy').hidden = message === null;
  if (message !== null) $('#busyText').textContent = message;
}

/** 第一次按變成「確認」，3.5 秒內再按一次才真的執行。取代被擋掉的 confirm()。 */
function twoStep(button, armedText, action) {
  const original = button.textContent;
  let armed = false;
  let timer = 0;
  button.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      button.textContent = armedText;
      button.classList.add('is-armed');
      timer = setTimeout(() => {
        armed = false;
        button.textContent = original;
        button.classList.remove('is-armed');
      }, 3500);
      return;
    }
    clearTimeout(timer);
    action();
  });
}

/* ---------- 狀態 ---------- */

const state = {
  entries: loadEntries(),
  view: 'map', // 'map' | 'list'
  filter: 'all', // 清單篩選
  query: '', // 清單搜尋
  selectedId: null, // 目前打開詳細資料的那一筆
  placing: null, // 放置模式：{ id } 移動既有紀錄；{} 新增
};

let photoUrls = []; // 詳細頁顯示照片用的 object URL，關閉時要釋放
let attachTargetId = null; // 「加照片」是要加到哪一筆

const find = (id) => state.entries.find((e) => e.id === id);
const allPhotoKeys = () => new Set(state.entries.flatMap((e) => e.photoKeys).filter(Boolean));

const map = createMap($('#map'), {
  onMapClick: handleMapClick,
  onPinClick: (id) => {
    if (!state.placing) openDetail(id);
  },
});

/* ---------- 儲存與重畫 ---------- */

let saveTimer = 0;
function persist() {
  if (!saveEntries(state.entries)) {
    toast('瀏覽器無法儲存資料。請先到「清單」匯出備份。', 6000);
  }
}

/** 資料有改動：存檔並重畫。打字時用延遲存檔（immediate: false），避免每個字都寫一次。 */
function commit({ immediate = true } = {}) {
  clearTimeout(saveTimer);
  if (immediate) persist();
  else saveTimer = setTimeout(persist, 400);
  renderAll();
}

function renderAll() {
  const s = summarize(state.entries);
  $('#stats').replaceChildren(
    h('span', { class: 'stat--got' }, `已集 ${s.got}`),
    h('span', {}, `想去 ${s.want}`),
  );
  map.render(state.entries, state.selectedId);
  if (state.view === 'list') renderList();
}

function renderList() {
  const rows = filterEntries(state.entries, { filter: state.filter, query: state.query });
  const body = $('#listBody');
  if (rows.length === 0) {
    body.replaceChildren(
      h('li', { class: 'list__empty' }, state.entries.length === 0 ? '還沒有紀錄。按下 ＋ 開始。' : '沒有符合的項目。'),
    );
  } else {
    body.replaceChildren(
      ...rows.map((entry) =>
        h(
          'li',
          {},
          h(
            'button',
            { type: 'button', class: `row row--${entry.status}`, onclick: () => openDetail(entry.id, { fly: true }) },
            h('span', { class: 'row__glyph', 'aria-hidden': 'true' }, KIND_GLYPH[entry.kind]),
            h(
              'span',
              {},
              h('span', { class: 'row__name' }, displayName(entry)),
              h(
                'span',
                { class: 'row__meta' },
                [KINDS[entry.kind], formatDate(entry.visitedAt), entry.sample ? '範例' : ''].filter(Boolean).join('・'),
              ),
            ),
            hasLocation(entry)
              ? h('span', { class: `pill pill--${entry.status}` }, STATUS_LABEL[entry.status])
              : h('span', { class: 'pill pill--warn' }, '待定位'),
          ),
        ),
      ),
    );
  }
  for (const chip of document.querySelectorAll('#listFilters .chip')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.filter === state.filter));
  }
  $('#clearSamplesBtn').hidden = !state.entries.some((e) => e.sample);
}

function setView(view) {
  state.view = view;
  $('#listView').hidden = view !== 'list';
  $('#tabMap').setAttribute('aria-current', view === 'map' ? 'page' : 'false');
  $('#tabList').setAttribute('aria-current', view === 'list' ? 'page' : 'false');
  if (view === 'list') renderList();
  else map.refresh();
}

/* ---------- 底部面板 ---------- */

function openSheet(title, content) {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').replaceChildren(content);
  $('#sheetBody').scrollTop = 0;
  $('#sheet').hidden = false;
  $('#backdrop').hidden = false;
}

function closeSheet() {
  $('#sheet').hidden = true;
  $('#backdrop').hidden = true;
  for (const url of photoUrls) URL.revokeObjectURL(url);
  photoUrls = [];
  if (state.selectedId !== null) {
    state.selectedId = null;
    map.render(state.entries, null);
  }
}

/* ---------- 新增選單 ---------- */

function openAddMenu() {
  const item = (title, sub, onclick) =>
    h('button', { type: 'button', class: 'menu__item', onclick }, h('strong', {}, title), h('span', {}, sub));

  openSheet(
    '新增御朱印',
    h(
      'div',
      { class: 'menu' },
      item('從照片匯入', '自動讀取拍攝位置與日期。同一天、150 公尺內的照片會合併成一筆。', () => {
        closeSheet();
        $('#photoInput').click();
      }),
      item('記錄現在位置', '在寺社現場使用：用目前位置和今天的日期新增一筆。', () => {
        closeSheet();
        addHere();
      }),
      item('在地圖上選位置', '點一下地圖，放一個「想去」的地點。', () => {
        startPlacing({});
      }),
      item('貼上 Google 地圖連結', '在 Google 地圖按分享、拷貝連結，再貼到這裡。會用名稱搜尋位置。', openPasteSheet),
      h(
        'p',
        { class: 'tip' },
        '照片沒有位置？手機選照片時常會把位置拿掉：iPhone 可以在選照片的畫面點「選項」，看看能不能附上位置；Android 多半會移除。沒有位置的照片會放進清單的「待定位」，之後可以手動補上。',
      ),
    ),
  );
}

/* ---------- 詳細資料 ---------- */

function openDetail(id, { fly = false } = {}) {
  const entry = find(id);
  if (!entry) return;
  state.selectedId = id;
  if (hasLocation(entry)) {
    setView('map');
    if (fly) map.flyTo(entry.lat, entry.lng);
  }
  openSheet(displayName(entry), detailContent(entry));
  map.render(state.entries, id);
}

function segmented(label, options, current, onPick) {
  const buttons = Object.entries(options).map(([value, text]) =>
    h(
      'button',
      {
        type: 'button',
        class: 'seg__btn',
        dataset: { value },
        'aria-pressed': String(value === current),
        onclick: () => {
          onPick(value);
          for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === value));
        },
      },
      text,
    ),
  );
  return h('div', { class: 'field' }, h('span', { class: 'field__label' }, label), h('div', { class: 'seg', role: 'group', 'aria-label': label }, buttons));
}

function detailContent(entry) {
  const dateInput = h('input', {
    type: 'date',
    id: 'f-date',
    value: entry.visitedAt ?? '',
    onchange: (e) => {
      entry.visitedAt = e.target.value || null;
      commit();
    },
  });

  const nameInput = h('input', {
    type: 'text',
    id: 'f-name',
    value: entry.name,
    maxlength: '80',
    placeholder: '例：明治神宮',
    autocomplete: 'off',
    oninput: (e) => {
      entry.name = e.target.value;
      $('#sheetTitle').textContent = displayName(entry);
      commit({ immediate: false });
    },
  });

  const noteInput = h(
    'textarea',
    {
      id: 'f-note',
      rows: '3',
      maxlength: '2000',
      placeholder: '授與時間、價格、限定款、旁邊好吃的店⋯',
      oninput: (e) => {
        entry.note = e.target.value;
        commit({ immediate: false });
      },
    },
    entry.note,
  );

  const locText = hasLocation(entry)
    ? `${entry.lat.toFixed(5)}, ${entry.lng.toFixed(5)}`
    : '尚未設定位置（還不會出現在地圖上）';

  const photos = h('div', { class: 'photos' });
  entry.photoIds.forEach((photoId, index) => {
    const img = h('img', { alt: '御朱印照片', loading: 'lazy' });
    const remove = h('button', { type: 'button', class: 'photo__rm', 'aria-label': '移除這張照片' }, '×');
    twoStep(remove, '刪？', () => removePhoto(entry, index));
    photos.append(h('figure', { class: 'photo' }, img, remove));
    getPhoto(photoId)
      .then((blob) => {
        if (!blob || state.selectedId !== entry.id) return;
        const url = URL.createObjectURL(blob);
        photoUrls.push(url);
        img.src = url;
      })
      .catch(() => {});
  });

  const deleteBtn = h('button', { type: 'button', class: 'btn btn--danger' }, '刪除這筆紀錄');
  twoStep(deleteBtn, '再按一次確認刪除', () => deleteEntry(entry));

  return h(
    'div',
    { class: 'sheet__content', style: 'display:grid;gap:16px' },
    entry.sample
      ? h('p', { class: 'sample-hint' }, '這是範例資料，座標為概略值。出發前請自己確認開放時間與是否提供御朱印。')
      : null,
    h('div', { class: 'field' }, h('label', { for: 'f-name' }, '名稱'), nameInput),
    segmented('種類', KINDS, entry.kind, (value) => {
      entry.kind = value;
      commit();
    }),
    segmented('狀態', STATUS_LABEL, entry.status, (value) => {
      entry.status = value;
      if (value === 'got' && !entry.visitedAt) {
        entry.visitedAt = todayISO();
        dateInput.value = entry.visitedAt;
      }
      commit();
    }),
    h('div', { class: 'field' }, h('label', { for: 'f-date' }, '參拜日期'), dateInput),
    h('div', { class: 'field' }, h('label', { for: 'f-note' }, '備註'), noteInput),
    h(
      'div',
      { class: 'field loc' },
      h('span', { class: 'field__label' }, '位置'),
      h('p', { class: 'loc__text' }, locText),
      h(
        'div',
        { class: 'loc__row' },
        h('button', { type: 'button', class: 'btn', onclick: () => startPlacing({ id: entry.id }) }, '在地圖上點選'),
        h('button', { type: 'button', class: 'btn', onclick: () => setHere(entry) }, '用現在位置'),
        h('button', { type: 'button', class: 'btn', onclick: () => searchLocationFor(entry) }, '用名稱搜尋位置'),
        hasLocation(entry)
          ? h('a', { href: mapsUrl(entry.lat, entry.lng), target: '_blank', rel: 'noopener' }, '在 Google 地圖開啟')
          : null,
        entry.link
          ? h('a', { href: entry.link, target: '_blank', rel: 'noopener noreferrer' }, '開啟原始 Google 地圖連結')
          : null,
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'field__label' }, `照片（${entry.photoIds.length}）`),
      photos,
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          onclick: () => {
            attachTargetId = entry.id;
            $('#attachInput').click();
          },
        },
        '加照片',
      ),
    ),
    h('button', { type: 'button', class: 'btn btn--primary', onclick: closeSheet }, '完成'),
    deleteBtn,
  );
}

async function removePhoto(entry, index) {
  const [photoId] = entry.photoIds.splice(index, 1);
  entry.photoKeys.splice(index, 1);
  try {
    await deletePhoto(photoId);
  } catch {
    /* 縮圖刪不掉也不影響紀錄 */
  }
  commit();
  openDetail(entry.id);
}

async function deleteEntry(entry) {
  for (const photoId of entry.photoIds) {
    try {
      await deletePhoto(photoId);
    } catch {
      /* 略過 */
    }
  }
  state.entries = state.entries.filter((e) => e.id !== entry.id);
  state.selectedId = null;
  closeSheet();
  commit();
  toast('已刪除');
}

/* ---------- 放置模式（點地圖設定位置） ---------- */

function startPlacing(target) {
  closeSheet();
  state.placing = target;
  setView('map');
  const label = target.id ? `點地圖，放置「${displayName(find(target.id))}」` : '點地圖，放置新的地點';
  $('#placingText').textContent = label;
  $('#placingBar').hidden = false;
  map.setPlacing(true);
}

function stopPlacing() {
  state.placing = null;
  $('#placingBar').hidden = true;
  map.setPlacing(false);
}

function handleMapClick({ lat, lng }) {
  if (!state.placing) {
    if (!$('#sheet').hidden) closeSheet();
    return;
  }
  const target = state.placing;
  stopPlacing();
  lat = round6(lat);
  lng = round6(lng);
  if (target.id) {
    const entry = find(target.id);
    if (!entry) return;
    entry.lat = lat;
    entry.lng = lng;
    commit();
    openDetail(entry.id);
    toast('已更新位置');
  } else {
    const entry = makeEntry({ lat, lng, status: 'want' });
    state.entries.push(entry);
    commit();
    openDetail(entry.id);
  }
}

/* ---------- 目前位置 ---------- */

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!window.isSecureContext) {
      reject(new Error('定位只能在 https 或 localhost 的網址使用。'));
    } else if (!navigator.geolocation) {
      reject(new Error('這個瀏覽器不支援定位。'));
    } else {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 30000,
      });
    }
  });
}

function locationErrorMessage(err) {
  if (err && err.code === 1) return '定位被拒絕。請在瀏覽器的網站設定中允許「位置」。';
  if (err && err.message && !('code' in err)) return err.message;
  return '抓不到目前位置。請到戶外或稍後再試。';
}

/** 取得現在位置；失敗時顯示提示並回傳 null。 */
async function currentPosition() {
  busy('定位中…');
  try {
    const pos = await getPosition();
    return {
      lat: round6(pos.coords.latitude),
      lng: round6(pos.coords.longitude),
      accuracy: pos.coords.accuracy,
    };
  } catch (err) {
    toast(locationErrorMessage(err), 5000);
    return null;
  } finally {
    busy(null);
  }
}

async function addHere() {
  const pos = await currentPosition();
  if (!pos) return;
  const entry = makeEntry({ lat: pos.lat, lng: pos.lng, status: 'got', visitedAt: todayISO() });
  state.entries.push(entry);
  commit();
  map.showMe(pos.lat, pos.lng, pos.accuracy);
  openDetail(entry.id, { fly: true });
  toast('已用現在位置新增，記得填名稱');
}

async function setHere(entry) {
  const pos = await currentPosition();
  if (!pos) return;
  entry.lat = pos.lat;
  entry.lng = pos.lng;
  commit();
  map.showMe(pos.lat, pos.lng, pos.accuracy);
  openDetail(entry.id, { fly: true });
  toast('已更新位置');
}

/* ---------- 用名稱搜尋位置／從 Google 地圖連結新增 ---------- */

const geocoder = createGeocoder();

/**
 * 顯示「名稱 → 候選地點」面板，使用者點一個才算數（同名神社很多，不能全自動）。
 * onPick(候選)；onBack() 是面板底部那顆按鈕的動作。
 */
function openLocationSearch({ title, query, onPick, onBack, backLabel }) {
  const list = h('div', { class: 'menu' });
  const input = h('input', { type: 'search', value: query, 'aria-label': '搜尋的名稱', autocomplete: 'off' });
  const searchBtn = h('button', { type: 'button', class: 'btn' }, '搜尋');
  const root = h(
    'div',
    { class: 'menu' },
    h('div', { class: 'loc__row' }, input, searchBtn),
    list,
    h('button', { type: 'button', class: 'btn btn--quiet', onclick: onBack }, backLabel),
  );

  const run = async () => {
    const q = input.value.trim();
    if (!q) return;
    list.replaceChildren(h('p', { class: 'offline__note' }, `搜尋「${q}」中…`));
    const { results, error } = await geocoder.search(q);
    if (!root.isConnected) return; // 等待期間使用者已經關掉面板
    if (results.length === 0) {
      list.replaceChildren(
        h('p', { class: 'offline__warn' }, error ? `${error}。請確認有網路，或改用「在地圖上點選」。` : '找不到符合的地點。可以換個關鍵字（例如加上地名）再搜尋。'),
      );
      return;
    }
    list.replaceChildren(
      ...results.map((c) =>
        h(
          'button',
          { type: 'button', class: 'menu__item', onclick: () => onPick(c) },
          h('strong', {}, c.title || q),
          h('span', {}, `${c.detail}（${c.source}）`),
        ),
      ),
      h('p', { class: 'offline__note' }, '請確認地名與地址是你要的那一個，再點選。'),
    );
  };
  searchBtn.addEventListener('click', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run();
  });

  openSheet(title, root);
  run();
}

/** 已經有名稱、沒有位置（或位置不對）的紀錄：搜尋位置後更新。 */
function searchLocationFor(entry) {
  openLocationSearch({
    title: '搜尋位置',
    query: entry.name,
    backLabel: '返回',
    onBack: () => openDetail(entry.id),
    onPick: (c) => {
      entry.lat = c.lat;
      entry.lng = c.lng;
      commit();
      openDetail(entry.id, { fly: true });
      toast('已更新位置');
    },
  });
}

/** 加入一筆「想去」。已經有同一筆（同名稱與連結）就不重複加，回傳 null。 */
function addWantEntry({ name, link, lat, lng }) {
  const [entry] = itemsToEntries([{ name, note: '', link, lat, lng }]);
  const merged = mergeImported(state.entries, [entry]);
  if (merged.added === 0) return null;
  state.entries = merged.entries;
  commit();
  return entry;
}

/**
 * 處理一段 Google 地圖的分享內容（連結或「名稱＋連結」的文字）。
 * 有座標 → 直接加入；有名稱 → 搜尋位置讓使用者確認；只有短連結 → 先放進「待定位」。
 */
function addFromMapsText(raw) {
  const parsed = parseMapsLink(raw);
  if (!parsed) {
    toast('這不是 Google 地圖的連結。', 6000);
    return;
  }
  const finish = (entry, message) => {
    if (!entry) return toast('這個地點已經在清單裡了。', 4000);
    openDetail(entry.id, { fly: hasLocation(entry) });
    toast(message, 6000);
  };

  if (parsed.lat !== null) {
    finish(addWantEntry({ name: parsed.name, link: parsed.link, lat: parsed.lat, lng: parsed.lng }), '已加入「想去」');
    return;
  }
  if (!parsed.query) {
    finish(
      addWantEntry({ name: '', link: parsed.link, lat: null, lng: null }),
      '短連結裡沒有名稱，已先放進「待定位」。請在詳細頁輸入名稱後按「用名稱搜尋位置」。',
    );
    return;
  }
  openLocationSearch({
    title: `加入「${parsed.name || parsed.query}」`,
    query: parsed.query,
    backLabel: '找不到？先加入「待定位」',
    onBack: () => {
      const entry = addWantEntry({ name: parsed.name, link: parsed.link, lat: null, lng: null });
      closeSheet();
      if (entry) toast('已加入「待定位」', 4000);
    },
    onPick: (c) => finish(addWantEntry({ name: parsed.name || c.title, link: parsed.link, lat: c.lat, lng: c.lng }), '已加入「想去」'),
  });
}

function openPasteSheet() {
  const box = h('textarea', {
    rows: '4',
    placeholder: '貼上 Google 地圖分享的連結或文字',
    'aria-label': 'Google 地圖連結',
  });
  openSheet(
    '貼上 Google 地圖連結',
    h(
      'div',
      { class: 'menu' },
      box,
      h('button', { type: 'button', class: 'btn btn--primary', onclick: () => addFromMapsText(box.value) }, '新增'),
      h(
        'p',
        { class: 'tip' },
        'Google 地圖分享出來的短連結（maps.app.goo.gl 開頭）裡沒有名稱和座標，網頁沒辦法自己展開，只能先放進「待定位」。如果貼的是完整網址（google.com/maps?q=… 這種），會用裡面的地名搜尋位置。',
      ),
    ),
  );
}

/** 網址帶 ?add=（例如從 iOS 捷徑開啟）時，處理後把參數拿掉，重新整理才不會重複新增。 */
function handleAddParam() {
  const params = new URLSearchParams(location.search);
  const raw = params.get('add');
  if (raw === null) return;
  params.delete('add');
  history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : ''));
  addFromMapsText(raw);
}

/* ---------- 從照片匯入 ---------- */

async function importPhotos(fileList) {
  const files = [...fileList];
  if (files.length === 0) return;

  const seen = allPhotoKeys();
  const items = [];
  let duplicate = 0;
  let failed = 0;
  let dateGuessed = 0;

  // 一張一張處理，避免同時解碼太多大圖把手機記憶體用光
  for (const [i, file] of files.entries()) {
    busy(`處理照片 ${i + 1} / ${files.length}`);
    const key = photoKey(file);
    if (seen.has(key)) {
      duplicate++;
      continue;
    }
    try {
      const meta = await readPhotoMeta(file);
      const thumb = await makeThumb(file);
      if (meta.dateGuessed) dateGuessed++;
      seen.add(key);
      items.push({ ...meta, key, thumb });
    } catch {
      failed++;
    }
  }

  const created = [];
  for (const group of groupPhotos(items)) {
    const photoIds = [];
    const photoKeys = [];
    for (const item of group.items) {
      photoIds.push(await putPhoto(item.thumb));
      photoKeys.push(item.key);
    }
    const entry = makeEntry({
      status: 'got',
      lat: group.lat,
      lng: group.lng,
      visitedAt: group.date,
      photoIds,
      photoKeys,
    });
    state.entries.push(entry);
    created.push(entry);
  }
  busy(null);

  if (created.length > 0) commit();

  const parts = [`讀了 ${items.length} 張照片，新增 ${created.length} 筆`];
  const unlocated = created.filter((e) => !hasLocation(e)).length;
  if (unlocated) parts.push(`${unlocated} 筆沒有位置`);
  if (duplicate) parts.push(`${duplicate} 張已匯入過`);
  if (failed) parts.push(`${failed} 張讀不了（可能是這個瀏覽器不支援的格式）`);
  if (dateGuessed) parts.push(`${dateGuessed} 張沒有拍攝日期，暫用檔案日期`);
  toast(parts.join('，'), 7000);

  if (created.length === 1) {
    openDetail(created[0].id, { fly: true });
  } else if (unlocated > 0) {
    state.filter = 'unlocated';
    setView('list');
  } else if (created.length > 1) {
    setView('map');
    map.fitTo(created);
  }
}

/** 把照片加到既有的一筆。如果那筆還沒有位置或日期，就用照片的資訊補上。 */
async function attachPhotos(fileList, entryId) {
  const files = [...fileList];
  const entry = find(entryId);
  if (!entry || files.length === 0) return;

  const seen = allPhotoKeys();
  let added = 0;
  let duplicate = 0;
  let failed = 0;
  let filled = false;

  for (const [i, file] of files.entries()) {
    busy(`處理照片 ${i + 1} / ${files.length}`);
    const key = photoKey(file);
    if (seen.has(key)) {
      duplicate++;
      continue;
    }
    try {
      const meta = await readPhotoMeta(file);
      const thumb = await makeThumb(file);
      const photoId = await putPhoto(thumb);
      while (entry.photoKeys.length < entry.photoIds.length) entry.photoKeys.push('');
      entry.photoIds.push(photoId);
      entry.photoKeys.push(key);
      seen.add(key);
      if (!hasLocation(entry) && isValidLatLng(meta.lat, meta.lng)) {
        entry.lat = meta.lat;
        entry.lng = meta.lng;
        filled = true;
      }
      if (!entry.visitedAt && meta.date && !meta.dateGuessed) entry.visitedAt = meta.date;
      added++;
    } catch {
      failed++;
    }
  }
  busy(null);

  commit();
  openDetail(entry.id, { fly: filled });
  const parts = [`加入 ${added} 張`];
  if (filled) parts.push('已用照片的位置設定地點');
  if (duplicate) parts.push(`${duplicate} 張已匯入過`);
  if (failed) parts.push(`${failed} 張讀不了`);
  toast(parts.join('，'));
}

/* ---------- 備份 ---------- */

async function exportBackup() {
  busy('打包備份中…');
  try {
    const text = await buildBackup(state.entries);
    downloadText(`goshuin-map-${todayISO()}.json`, text);
    toast('已匯出備份檔，請把它存到安全的地方（雲端硬碟、電腦）。', 6000);
  } catch {
    toast('匯出失敗，請再試一次。');
  } finally {
    busy(null);
  }
}

async function importBackup(file) {
  if (!file) return;
  busy('匯入備份中…');
  try {
    const result = await restoreBackup(await file.text(), state.entries);
    state.entries = result.entries;
    commit();
    toast(`匯入 ${result.added} 筆，略過 ${result.skipped} 筆（已存在）`, 5000);
  } catch (err) {
    toast(err.message || '匯入失敗', 5000);
  } finally {
    busy(null);
  }
}

async function importGoogleList(file) {
  if (!file) return;
  busy('讀取 Google 地圖清單中…');
  try {
    const parsed = parseGoogleList(await file.text());
    if (parsed.error) {
      toast(parsed.error, 6000);
      return;
    }
    const incoming = itemsToEntries(parsed.items);
    const merged = mergeImported(state.entries, incoming);
    state.entries = merged.entries;
    commit();
    const unlocated = incoming.filter((e) => !hasLocation(e)).length;
    toast(
      `匯入 ${merged.added} 筆，略過 ${merged.skipped} 筆（已存在）` +
        (unlocated ? `。其中 ${unlocated} 筆沒有座標，已放進「待定位」。` : ''),
      8000,
    );
  } catch (err) {
    toast(err.message || '匯入失敗', 5000);
  } finally {
    busy(null);
  }
}

/* ---------- 離線地圖 ---------- */

const DOWNLOAD_CAP = 1000; // 一次最多下載幾張，避免不小心抓一大片
const DETAIL_CHOICES = [
  { zoom: 15, label: '一般（看得到街道）' },
  { zoom: 16, label: '詳細（看得到巷弄）' },
  { zoom: 17, label: '最詳細（看得到建築）' },
];

let offlineJob = null; // 下載進行中時：{ abort: AbortController, progress }
let offlineDetailZoom = 16;
let serviceWorkerReady = false;

const hasCacheApi = () => typeof caches !== 'undefined';
const fmtMB = (n) => (n === null ? '—' : n < 10 ? n.toFixed(1) : String(Math.round(n)));

function offlineStatusText() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return '離線開啟：未啟用（需要 https 網址）';
  if (navigator.serviceWorker.controller) return '離線開啟：已啟用，沒有網路也能打開這個 App';
  return serviceWorkerReady ? '離線開啟：安裝完成，重新開啟一次 App 後生效' : '離線開啟：尚未啟用';
}

async function openOfflineSheet() {
  const info = map.baseInfo();
  const statusBox = h('div', { class: 'offline__status' }, h('p', {}, '讀取中…'));
  const planBox = h('p', { class: 'offline__plan' });
  const warnBox = h('p', { class: 'offline__warn' });
  const bar = h('span');
  const progressText = h('p', { class: 'offline__note' });
  const progressWrap = h('div', {}, h('div', { class: 'progress', role: 'progressbar' }, bar), progressText);
  const downloadBtn = h('button', { type: 'button', class: 'btn btn--primary' }, '下載這個範圍');
  const cancelBtn = h('button', { type: 'button', class: 'btn' }, '取消下載');
  const clearBtn = h('button', { type: 'button', class: 'btn btn--danger' }, '清除離線地圖');
  const select = h(
    'select',
    { id: 'offlineDetail', 'aria-label': '細緻程度' },
    ...DETAIL_CHOICES.map((c) => h('option', { value: String(c.zoom), selected: c.zoom === offlineDetailZoom }, c.label)),
  );

  const view = map.getView();
  const makePlan = () =>
    planTiles(view.bounds, {
      minZoom: Math.max(info.minZoom, Math.min(12, Math.floor(view.zoom))),
      maxZoom: Math.min(info.maxZoom, offlineDetailZoom),
      cap: DOWNLOAD_CAP,
    });

  const showProgress = (p) => {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    bar.style.width = `${pct}%`;
    progressText.textContent = `${p.done} / ${p.total} 張（新增 ${p.fetched}、已有 ${p.skipped}、失敗 ${p.failed}）`;
  };

  const refreshPlan = () => {
    const running = offlineJob !== null;
    progressWrap.hidden = !running;
    cancelBtn.hidden = !running;
    downloadBtn.hidden = running;
    select.disabled = running;
    if (running) showProgress(offlineJob.progress);

    warnBox.textContent = '';
    planBox.textContent = '';
    downloadBtn.disabled = true;
    if (running) return;

    if (!hasCacheApi()) {
      warnBox.textContent = '這個瀏覽器目前無法使用離線儲存（需要 https 網址）。';
      return;
    }
    if (!info.bulk) {
      warnBox.textContent = `目前底圖是 ${info.label}。它的使用規範不鼓勵大量預先下載，請先按「切換底圖」換成地理院地圖。`;
      return;
    }
    const plan = makePlan();
    if (plan.tooLarge) {
      warnBox.textContent = '這個範圍太大了。請先回到地圖，放大到你要去的地區（例如一個市區）再來。';
      return;
    }
    planBox.textContent = `預計下載 ${plan.count} 張，約 ${fmtMB(estimateMB(plan.count))} MB（粗估）`;
    if (plan.reduced) {
      warnBox.textContent = `範圍比較大，最細只能到第 ${plan.maxZoom} 級。想要更細的街道，請先把地圖放大到更小的區域。`;
    }
    downloadBtn.disabled = plan.count === 0;
  };

  const refreshStatus = async () => {
    const st = await cacheStats();
    statusBox.replaceChildren(
      h('p', {}, offlineStatusText()),
      h('p', {}, `已存地圖：${st.tiles} 張（上限 ${MAX_CACHED_TILES}）`),
      h('p', {}, `本網站目前用量約 ${fmtMB(st.usageMB)} MB${st.quotaMB === null ? '' : `（瀏覽器給的空間約 ${fmtMB(st.quotaMB)} MB）`}`),
      h('p', {}, `防止被自動清除：${st.persisted === null ? '無法確認' : st.persisted ? '已啟用' : '未啟用，瀏覽器空間不足時可能被清掉'}`),
    );
    clearBtn.disabled = st.tiles === 0;
  };

  select.addEventListener('change', () => {
    offlineDetailZoom = Number(select.value);
    refreshPlan();
  });

  downloadBtn.addEventListener('click', async () => {
    const plan = makePlan();
    if (plan.tooLarge || plan.count === 0 || offlineJob) return;
    const abort = new AbortController();
    offlineJob = { abort, progress: { done: 0, total: plan.count, fetched: 0, skipped: 0, failed: 0 } };
    refreshPlan();
    requestPersistence().then(refreshStatus);
    try {
      const result = await prefetchTiles({
        template: info.url,
        tiles: iterateTiles(view.bounds, plan.minZoom, plan.maxZoom),
        total: plan.count,
        signal: abort.signal,
        onProgress: (p) => {
          offlineJob.progress = p;
          showProgress(p);
        },
      });
      if (result.aborted) toast(`已取消。這次新增了 ${result.fetched} 張。`, 5000);
      else if (result.stoppedEarly) toast('連續失敗，已停止。可能沒有網路，或被伺服器拒絕。', 7000);
      else toast(`完成：新增 ${result.fetched} 張，原本就有 ${result.skipped} 張，失敗 ${result.failed} 張。`, 6000);
    } catch (err) {
      console.warn(err);
      toast('下載時發生錯誤，可能是儲存空間不足。', 6000);
    } finally {
      offlineJob = null;
      refreshPlan();
      refreshStatus();
    }
  });

  cancelBtn.addEventListener('click', () => offlineJob?.abort.abort());

  twoStep(clearBtn, '再按一次確認清除', async () => {
    await clearTiles();
    toast('已清除離線地圖');
    refreshStatus();
  });
  clearBtn.disabled = true;

  openSheet(
    '離線地圖',
    h(
      'div',
      { class: 'offline' },
      statusBox,
      h(
        'p',
        { class: 'offline__note' },
        '先把地圖拉到你要去的地區（例如整個京都市區），再按下載。下載的是「現在畫面看到的範圍」。看過的地圖也會自動保留一段時間。',
      ),
      h('div', { class: 'field' }, h('label', { for: 'offlineDetail' }, '細緻程度'), select),
      planBox,
      warnBox,
      downloadBtn,
      progressWrap,
      cancelBtn,
      h('p', { class: 'offline__note' }, '離線時，紀錄、備註和照片縮圖照常可用；沒有下載到的地方，地圖會是空白。'),
      clearBtn,
    ),
  );
  refreshPlan();
  refreshStatus();
}

/* ---------- 事件綁定 ---------- */

$('#fab').addEventListener('click', openAddMenu);
$('#tabMap').addEventListener('click', () => setView('map'));
$('#tabList').addEventListener('click', () => setView('list'));
$('#sheetClose').addEventListener('click', closeSheet);
$('#backdrop').addEventListener('click', closeSheet);
$('#placingCancel').addEventListener('click', stopPlacing);

$('#locateBtn').addEventListener('click', async () => {
  const pos = await currentPosition();
  if (!pos) return;
  map.showMe(pos.lat, pos.lng, pos.accuracy);
  map.flyTo(pos.lat, pos.lng, 16);
});
$('#baseBtn').addEventListener('click', () => toast(`底圖：${map.toggleBase()}`, 2000));
$('#offlineBtn').addEventListener('click', openOfflineSheet);

$('#listSearch').addEventListener('input', (e) => {
  state.query = e.target.value;
  renderList();
});
$('#listFilters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.filter = chip.dataset.filter;
  renderList();
});

$('#photoInput').addEventListener('change', (e) => {
  const files = e.target.files;
  importPhotos(files).finally(() => (e.target.value = ''));
});
$('#attachInput').addEventListener('change', (e) => {
  const files = e.target.files;
  attachPhotos(files, attachTargetId).finally(() => (e.target.value = ''));
});
$('#importInput').addEventListener('change', (e) => {
  importBackup(e.target.files[0]).finally(() => (e.target.value = ''));
});
$('#gmapsInput').addEventListener('change', (e) => {
  importGoogleList(e.target.files[0]).finally(() => (e.target.value = ''));
});
$('#gmapsBtn').addEventListener('click', () => $('#gmapsInput').click());
$('#exportBtn').addEventListener('click', exportBackup);
$('#importBtn').addEventListener('click', () => $('#importInput').click());

twoStep($('#clearSamplesBtn'), '再按一次確認清除', () => {
  state.entries = state.entries.filter((e) => !e.sample);
  commit();
  toast('已清除範例');
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.placing) stopPlacing();
  else if (!$('#sheet').hidden) closeSheet();
});

// 離開頁面前把還沒存的內容存下來（打字用的是延遲存檔）
window.addEventListener('pagehide', persist);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persist();
});

/* ---------- 啟動 ---------- */

renderAll();
map.fitTo(state.entries);
requestAnimationFrame(() => map.refresh());

// 離線：沒有網路時在標題旁顯示「離線中」；註冊 service worker（只有 https 才會成功）
watchOnline((online) => ($('#offlineChip').hidden = online));
handleAddParam();
registerServiceWorker({
  onUpdate: () => toast('已更新到新版。關掉再重新開啟 App 後生效。', 8000),
}).then((registration) => {
  serviceWorkerReady = Boolean(registration);
});
