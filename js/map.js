// map.js — 地圖本體（Leaflet）。只負責「畫」，不決定「要做什麼」；
// 點了地圖或圖釘之後的行為，由 main.js 傳進來的 handlers 決定。

import { KIND_GLYPH, displayName, hasLocation } from './model.js';
import { loadPref, savePref } from './store.js';
import { KIND_ICON } from './icons.js';

/** 圖案 + 文字的 HTML（常數字串，不含使用者輸入）。清單裡的 kindMark 用的是同一套 class。 */
export function kindMarkHtml(kind) {
  return `<span class="kindmark">${KIND_ICON[kind] ?? KIND_ICON.other}<span class="kindmark__char">${KIND_GLYPH[kind] ?? '印'}</span></span>`;
}

const L = window.L; // 由 index.html 先載入的 vendor/leaflet/leaflet.js 提供

const BASES = {
  // 国土地理院「標準地圖」：日本境內最詳細，地名是日文。
  gsi: {
    label: '地理院地圖',
    bulk: true, // 離線地圖預先下載只開放給這個底圖（見 README）
    url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    options: {
      minZoom: 5,
      maxZoom: 18,
      attribution:
        '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
    },
  },
  // OpenStreetMap：全世界通用。請遵守 OSM 圖磚使用規範（個人少量使用沒問題）。
  osm: {
    label: 'OpenStreetMap',
    bulk: false, // OSM 的圖磚使用規範不鼓勵大量預先下載
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 貢獻者',
    },
  },
};

const TOKYO = [35.6812, 139.7671];

export function createMap(container, { onMapClick, onPinClick }) {
  const map = L.map(container, { zoomControl: false, attributionControl: true }).setView(TOKYO, 10);
  L.control.zoom({ position: 'topright' }).addTo(map);
  map.attributionControl.setPrefix(false);

  // 預設是 OpenStreetMap。偏好設定換了新名字（base2），讓舊版存下的選擇不再生效，所有裝置一開始都是同一張底圖。
  let baseName = loadPref('base2', 'osm');
  if (!BASES[baseName]) baseName = 'osm';
  let baseLayer = null;
  const useBase = (name) => {
    if (baseLayer) baseLayer.remove();
    baseName = name;
    baseLayer = L.tileLayer(BASES[name].url, BASES[name].options).addTo(map);
    savePref('base2', name);
  };
  useBase(baseName);

  const pins = L.layerGroup().addTo(map);
  const meLayer = L.layerGroup().addTo(map);

  map.on('click', (e) => onMapClick({ lat: e.latlng.lat, lng: e.latlng.lng }));

  // 圖釘 = 圖案（鳥居／三重塔，只有輪廓或單色、沒有底色）＋疊在上面的毛筆字。樣式在 css 的 .kindmark。
  const iconFor = (entry, selected) =>
    L.divIcon({
      className: `pin pin--${entry.status} kind-${entry.kind}${selected ? ' is-selected' : ''}`,
      html: kindMarkHtml(entry.kind),
      iconSize: [40, 40],
      iconAnchor: [20, 20],
    });

  return {
    /** 重畫所有圖釘。沒有位置的紀錄不會出現在地圖上。 */
    render(entries, selectedId = null) {
      pins.clearLayers();
      for (const entry of entries) {
        if (!hasLocation(entry)) continue;
        L.marker([entry.lat, entry.lng], {
          icon: iconFor(entry, entry.id === selectedId),
          title: displayName(entry),
          alt: displayName(entry),
          riseOnHover: true,
        })
          .on('click', () => onPinClick(entry.id))
          .addTo(pins);
      }
    },

    /** 縮放到所有圖釘都看得到；只有一個就放大到那裡。 */
    fitTo(entries) {
      const pts = entries.filter(hasLocation).map((e) => [e.lat, e.lng]);
      if (pts.length === 0) map.setView(TOKYO, 10);
      else if (pts.length === 1) map.setView(pts[0], 15);
      else map.fitBounds(pts, { padding: [48, 48], maxZoom: 15 });
    },

    flyTo(lat, lng, zoom = 16) {
      map.flyTo([lat, lng], Math.max(map.getZoom(), zoom), { duration: 0.6 });
    },

    /** 在地圖上標出「我現在的位置」與定位誤差範圍。 */
    showMe(lat, lng, accuracy) {
      meLayer.clearLayers();
      if (Number.isFinite(accuracy) && accuracy > 0) {
        L.circle([lat, lng], { radius: accuracy, className: 'me-accuracy', interactive: false }).addTo(meLayer);
      }
      L.circleMarker([lat, lng], { radius: 7, className: 'me-dot', interactive: false }).addTo(meLayer);
    },

    /** 底圖在 gsi 與 osm 之間切換，回傳新的名稱。 */
    toggleBase() {
      useBase(baseName === 'osm' ? 'gsi' : 'osm');
      return BASES[baseName].label;
    },
    baseLabel: () => BASES[baseName].label,

    /** 目前底圖的資訊，離線地圖要用：圖磚網址樣板、是否開放預先下載、縮放範圍。 */
    baseInfo() {
      const b = BASES[baseName];
      return { name: baseName, label: b.label, url: b.url, bulk: b.bulk, minZoom: b.options.minZoom ?? 0, maxZoom: b.options.maxZoom ?? 18 };
    },

    /** 目前畫面看到的範圍與縮放，離線地圖用它決定要下載哪一塊。 */
    getView() {
      const b = map.getBounds();
      return {
        bounds: { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() },
        zoom: map.getZoom(),
      };
    },

    /** 放置模式：游標變十字。 */
    setPlacing(on) {
      container.classList.toggle('is-placing', on);
    },

    /** 版面大小改變（例如切換分頁）後呼叫，讓 Leaflet 重新量尺寸。 */
    refresh() {
      map.invalidateSize();
    },
  };
}
