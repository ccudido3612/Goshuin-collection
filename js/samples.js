// samples.js — 第一次打開時放的範例，讓地圖不是空的。
// 名稱與座標都只是概略值，出發前請自己查證；用「清單」裡的「清除範例」可以一次刪掉。

const sample = (id, name, kind, lat, lng) => ({
  id: `sample_${id}`,
  name,
  kind,
  status: 'want',
  lat,
  lng,
  note: '範例資料：座標為概略值，出發前請自己確認開放時間與是否提供御朱印。',
  sample: true,
  createdAt: '2026-01-01T00:00:00.000Z',
});

export const SAMPLES = [
  sample('meiji', '明治神宮', 'shrine', 35.6764, 139.6993),
  sample('sensoji', '浅草寺', 'temple', 35.7148, 139.7967),
  sample('tsurugaoka', '鶴岡八幡宮', 'shrine', 35.3259, 139.5563),
  sample('narita', '成田山新勝寺', 'temple', 35.7861, 140.3189),
  sample('hikawa', '川越氷川神社', 'shrine', 35.9262, 139.4887),
];
