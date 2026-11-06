import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseGoogleList, coordsFromUrl, itemsToEntries, guessKind } from '../js/gmaps.js';
import { mergeImported } from '../js/model.js';

test('parseCsv：引號、逗號、換行、雙引號跳脫、BOM、CRLF', () => {
  const rows = parseCsv('﻿a,b\r\n"x,y","line1\nline2"\r\n"he said ""hi""",z\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x,y', 'line1\nline2'], ['he said "hi"', 'z']]);
});

test('CSV（Takeout 風格：Title, Note, URL, Tags, Comment）', () => {
  const csv = 'Title,Note,URL,Tags,Comment\n' +
    '明治神宮,想早上去,https://www.google.com/maps/place/明治神宮/data=!4m2!3m1!1s0x60188cb0:0x1,,人少\n' +
    '"伏見稻荷大社, 京都",,"https://www.google.com/maps/place/x/@34.967,135.773,17z/data=!3d34.9671!4d135.7727",,\n';
  const { items } = parseGoogleList(csv);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, '明治神宮');
  assert.equal(items[0].note, '想早上去\n人少'); // Note 與 Comment 合併
  assert.equal(items[0].lat, null); // 網址沒有座標 → 待定位
  assert.equal(items[1].name, '伏見稻荷大社, 京都');
  assert.equal(items[1].lat, 34.9671); // 優先用 !3d!4d（地點本身，而不是畫面中心 @）
  assert.equal(items[1].lng, 135.7727);
});

test('coordsFromUrl：各種寫法與壞資料', () => {
  assert.deepEqual(coordsFromUrl('https://maps.google.com/?q=35.68,139.76'), { lat: 35.68, lng: 139.76 });
  assert.deepEqual(coordsFromUrl('https://www.google.com/maps/@35.1,139.2,15z'), { lat: 35.1, lng: 139.2 });
  assert.equal(coordsFromUrl('https://www.google.com/maps/place/foo'), null);
  assert.equal(coordsFromUrl('@999,999'), null);
  assert.equal(coordsFromUrl(null), null);
});

test('GeoJSON（座標順序是 [經度, 緯度]）', () => {
  const geo = { type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [139.6993, 35.6764] }, properties: { Title: '明治神宮', 'Google Maps URL': 'https://maps.google.com/?cid=1', Comment: 'x' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: '無效座標' } },
  ] };
  const { items } = parseGoogleList(JSON.stringify(geo));
  assert.equal(items[0].lat, 35.6764);
  assert.equal(items[0].lng, 139.6993);
  assert.equal(items[1].lat, null); // (0,0) 視為沒有座標
});

test('KML（座標順序是 經度,緯度,高度；CDATA 與實體字元）', () => {
  const kml = `<kml><Document>
    <Placemark><name><![CDATA[浅草寺]]></name><description>A &amp; B&lt;br&gt;note</description><Point><coordinates>139.7967,35.7148,0</coordinates></Point></Placemark>
    <Placemark><name>無座標</name></Placemark></Document></kml>`;
  const { items } = parseGoogleList(kml);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, '浅草寺');
  assert.equal(items[0].lat, 35.7148);
  assert.equal(items[0].lng, 139.7967);
  assert.match(items[0].note, /A & B/);
  assert.equal(items[1].lat, null);
});

test('壞檔案給明確錯誤', () => {
  assert.ok(parseGoogleList('').error);
  assert.ok(parseGoogleList('{壞掉').error);
  assert.ok(parseGoogleList('foo,bar\n1,2').error); // 沒有名稱/連結欄
});

test('itemsToEntries：想去、猜種類、重複匯入不會重複、連結只收 http(s)', () => {
  const items = [
    { name: '明治神宮', note: '', link: 'https://maps.google.com/?cid=1', lat: null, lng: null },
    { name: '浅草寺', note: '', link: 'javascript:alert(1)', lat: 35.7, lng: 139.8 },
    { name: '明治神宮', note: '', link: 'https://maps.google.com/?cid=1', lat: null, lng: null }, // 檔內重複
  ];
  const entries = itemsToEntries(items);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.status === 'want'));
  assert.equal(entries[0].kind, 'shrine');
  assert.equal(entries[1].kind, 'temple');
  assert.equal(entries[1].link, ''); // javascript: 被擋掉
  assert.equal(entries[0].link, 'https://maps.google.com/?cid=1');

  const first = mergeImported([], entries);
  const again = mergeImported(first.entries, itemsToEntries(items));
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 2);
});

test('guessKind', () => {
  assert.equal(guessKind('成田山新勝寺'), 'temple');
  assert.equal(guessKind('鶴岡八幡宮'), 'shrine');
  assert.equal(guessKind('護國寺神社'), 'shrine');
  assert.equal(guessKind(''), 'shrine');
});
