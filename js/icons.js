// icons.js — 鳥居與三重塔的向量圖（自己畫的，沒有授權問題）。
// 全部用 currentColor 填色，顏色由外層的 CSS 決定，所以深淺色模式會自動切換。
// 這裡只放「寫死的常數字串」，不會放進任何使用者輸入，所以用 innerHTML 是安全的。

/** 鳥居：笠木（上橫梁，兩端翹起）、島木、貫、額束、兩根柱。 */
export const TORII = `<svg viewBox="0 0 64 56" fill="currentColor" aria-hidden="true" focusable="false">
  <path d="M1 4.5 Q32 15 63 4.5 L61 11 Q32 21 3 11 Z"/>
  <rect x="8" y="14.5" width="48" height="3.6" rx="0.6"/>
  <rect x="9" y="26" width="46" height="4.4" rx="0.6"/>
  <rect x="29.6" y="17" width="4.8" height="9.5"/>
  <path d="M12 17 H18.4 L19.4 54 H10.6 Z"/>
  <path d="M45.6 17 H52 L53.4 54 H44.6 Z"/>
</svg>`;

// 三重塔的屋簷：頂點 → 向外彎曲 → 翹起的簷角 → 底部
const roof = (cx, top, wTop, wBot, h) =>
  `<path d="M${cx} ${top} Q${cx + wTop} ${top + h * 0.28} ${cx + wBot} ${top + h * 0.58} L${cx + wBot * 0.6} ${top + h} H${cx - wBot * 0.6} L${cx - wBot} ${top + h * 0.58} Q${cx - wTop} ${top + h * 0.28} ${cx} ${top} Z"/>`;

/** 三重塔：相輪（頂上的尖塔）、三層屋簷與塔身、基壇。 */
export const PAGODA = `<svg viewBox="0 0 48 64" fill="currentColor" aria-hidden="true" focusable="false">
  <rect x="23.1" y="0.8" width="1.8" height="11"/>
  <rect x="21.2" y="3.6" width="5.6" height="1.3" rx="0.4"/>
  <rect x="21.7" y="6.6" width="4.6" height="1.3" rx="0.4"/>
  ${roof(24, 10, 7, 12, 8.5)}
  <rect x="19.5" y="18" width="9" height="6.5"/>
  ${roof(24, 23.5, 9, 16, 9.5)}
  <rect x="17.5" y="32.5" width="13" height="7"/>
  ${roof(24, 38.5, 11, 21, 10.5)}
  <rect x="14.5" y="49" width="19" height="7.5"/>
  <rect x="8" y="56.5" width="32" height="4.5" rx="0.6"/>
</svg>`;

/** 其他（印）：簡單的朱印方章。 */
export const SEAL = `<svg viewBox="0 0 48 48" fill="currentColor" aria-hidden="true" focusable="false">
  <path fill-rule="evenodd" d="M6 6 H42 V42 H6 Z M12 12 V36 H36 V12 Z"/>
  <rect x="20" y="17" width="8" height="14" rx="1"/>
</svg>`;

export const KIND_ICON = { shrine: TORII, temple: PAGODA, other: SEAL };

/** 把上面的常數字串變成 DOM 元素。 */
export function svgElement(markup, className = '') {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  const el = t.content.firstElementChild;
  if (className) el.setAttribute('class', className);
  return el;
}
