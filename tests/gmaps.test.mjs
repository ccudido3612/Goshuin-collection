import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseGoogleList, coordsFromUrl, itemsToEntries, guessKind, mergeGoogleImport } from '../js/gmaps.js';
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

// 使用者實際從 My Maps 匯出的 KML（節錄）：沒有座標、第一筆是空的、住吉大社重複兩次
const REAL_KML = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Folder>
<Placemark><name/><description><![CDATA[筆記: <br>網址: <br>標籤: <br>留言: ]]></description><ExtendedData><Data name="筆記"><value/></Data><Data name="網址"><value/></Data></ExtendedData></Placemark>
<Placemark><name>住吉大社</name><address>住吉大社</address><ExtendedData><Data name="筆記"><value/></Data><Data name="網址"><value>https://www.google.com/maps/place/%E4%BD%8F%E5%90%89%E5%A4%A7%E7%A4%BE/data=!4m2!3m1!1s0x6000e7bbc67c0001:0xa7f51dfe4d001f82</value></Data></ExtendedData></Placemark>
<Placemark><name>住吉大社</name><ExtendedData><Data name="筆記"><value/></Data><Data name="網址"><value>https://www.google.com/maps/place/%E4%BD%8F%E5%90%89%E5%A4%A7%E7%A4%BE/data=!4m2!3m1!1s0x6000e7bbc67c0001:0xa7f51dfe4d001f82</value></Data></ExtendedData></Placemark>
<Placemark><name>玉龍山 浄光寺</name><ExtendedData><Data name="筆記"><value>卷軸御朱印（要預約）</value></Data><Data name="網址"><value>https://www.google.com/maps/place/%E7%8E%89%E9%BE%8D%E5%B1%B1+%E6%B5%84%E5%85%89%E5%AF%BA/data=!4m2!3m1!1s0x6001041b14c4137b:0x17b37be23e3f0fb2</value></Data></ExtendedData></Placemark>
<Placemark><name>Ryuonji Temple</name><ExtendedData><Data name="網址"><value>https://www.google.com/maps/place/Ryuonji+Temple/data=!4m2!3m1!1s0x600045e7dc7da82d:0x9fbbe2f043de5b0a</value></Data></ExtendedData></Placemark>
</Folder></Document></kml>`;

test('實際的 My Maps KML：空的略過、重複只留一筆、讀得到筆記與網址、帶推測位置', () => {
  const { items } = parseGoogleList(REAL_KML);
  const entries = itemsToEntries(items);
  assert.equal(entries.length, 3);
  const jko = entries.find((e) => e.name === '玉龍山 浄光寺');
  assert.equal(jko.note, '卷軸御朱印（要預約）');
  assert.equal(jko.id, 'gm_17b37be23e3f0fb2');
  assert.equal(jko.lat, null);
  assert.ok(jko.hint && jko.hint.lat > 34.9 && jko.hint.lat < 35);
  assert.ok(entries.every((e) => e.status === 'want'));
});

test('mergeGoogleImport：同一地點不重複新增，但補上推測位置；舊紀錄的位置不會被覆蓋', () => {
  // 先前用 CSV 匯入的舊紀錄：id 是舊算法、沒有 hint；其中一筆使用者已經手動定位
  const old = itemsToEntries([
    { name: '住吉大社', note: '', link: 'https://www.google.com/maps/place/x/data=!4m2!3m1!1s0x6000e7bbc67c0001:0xa7f51dfe4d001f82', lat: null, lng: null },
    { name: '妙義神社', note: '', link: '', lat: 35.7386, lng: 139.745 },
  ]).map((e, i) => ({ ...e, id: `old_${i}`, hint: null }));

  const incoming = itemsToEntries([
    { name: '住吉大社', note: '', link: 'https://www.google.com/maps/place/y/data=!4m2!3m1!1s0x6000e7bbc67c0001:0xa7f51dfe4d001f82', lat: null, lng: null, hint: { lat: 34.66, lng: 135.47 } },
    { name: '妙義神社', note: '', link: '', lat: 36.28, lng: 138.77, hint: { lat: 36.28, lng: 138.77 } },
    { name: '大阪天滿宮', note: '', link: '', lat: null, lng: null },
  ]);
  const r = mergeGoogleImport(old, incoming);
  assert.equal(r.added, 1);
  assert.equal(r.updated, 2);
  assert.equal(r.entries.length, 3);
  assert.deepEqual(r.entries[0].hint, { lat: 34.66, lng: 135.47 });
  assert.equal(r.entries[1].lat, 35.7386, '已經有位置的不能被覆蓋');

  const again = mergeGoogleImport(r.entries, incoming);
  assert.deepEqual([again.added, again.updated, again.skipped], [0, 0, 3]);
});

test('GeoJSON（Takeout 已加星號的地點：小寫欄位 + location.address）', () => {
  const geo = { type: 'FeatureCollection', features: [{ geometry: { type: 'Point', coordinates: [135.5051421, 34.6669629] }, properties: { date: 'x', google_maps_url: 'http://maps.google.com/?cid=17374332037517770750', location: { address: '日本〒542-0074 Osaka', country_code: 'JP', name: 'Sushi Sakaba Sashisu' } } }] };
  const { items } = parseGoogleList(JSON.stringify(geo));
  assert.equal(items[0].name, 'Sushi Sakaba Sashisu');
  assert.equal(items[0].address, '日本〒542-0074 Osaka');
  assert.equal(items[0].lat, 34.6669629);
});
