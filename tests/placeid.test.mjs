import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaceId, s2CellToLatLng, placeHint, placeKey } from '../js/placeid.js';
import { distanceMeters } from '../js/geo.js';

// 使用者 Google 地圖清單裡的真實網址（只取編號）
const OSAKA_TENMANGU = 'https://www.google.com/maps/place/x/data=!4m2!3m1!1s0x6000e6dba42a1cef:0xa135ef22a79f6eb2';
const MYOUGI = 'https://www.google.com/maps/place/x/data=!4m2!3m1!1s0x60188d9121c736e1:0x84ce7e485dd1228d';

test('parsePlaceId：data=!1s 與 ftid=（含 %3A）兩種寫法', () => {
  assert.equal(parsePlaceId(OSAKA_TENMANGU).key, 'a135ef22a79f6eb2');
  assert.equal(parsePlaceId('https://x/maps?ftid=0x6000e7bbc67c0001%3A0xa7f51dfe4d001f82&a=1').key, 'a7f51dfe4d001f82');
  assert.equal(parsePlaceId('沒有編號'), null);
  assert.equal(parsePlaceId(null), null);
  assert.equal(placeKey(OSAKA_TENMANGU), 'a135ef22a79f6eb2');
});

test('解碼：大阪天滿宮與已知位置（約 34.6958, 135.5128）相差不到 100 公尺', () => {
  const h = placeHint(OSAKA_TENMANGU);
  assert.ok(distanceMeters(h, { lat: 34.6958, lng: 135.5128 }) < 100, JSON.stringify(h));
});

test('解碼：妙義神社與使用者手機上搜尋到的位置（35.73862, 139.74506）相差不到 100 公尺', () => {
  const h = placeHint(MYOUGI);
  assert.ok(distanceMeters(h, { lat: 35.73862, lng: 139.74506 }) < 100, JSON.stringify(h));
});

test('解碼：其他地點落在合理地區（與 Python 對照值一致到小數第 4 位）', () => {
  const cases = [
    [0x60188ee02df456b3n, 35.72528, 139.81316], // 東向島白鬚神社（東京都墨田區）
    [0x3540d7ccee5ea361n, 32.85389, 131.15851], // 上色見熊野座神社（熊本縣）
    [0x5f9bc73835de5b75n, 40.93799, 140.3122], // 高山稻荷神社（青森縣）
    [0x6001041b14c4137bn, 34.94178, 135.68719], // 玉龍山 浄光寺（京都府長岡京市附近）
  ];
  for (const [cell, lat, lng] of cases) {
    const h = s2CellToLatLng(cell);
    assert.ok(Math.abs(h.lat - lat) < 1e-4 && Math.abs(h.lng - lng) < 1e-4, `${cell.toString(16)} → ${JSON.stringify(h)}`);
  }
});

test('壞資料：0、非法面、沒有結束標記', () => {
  assert.equal(s2CellToLatLng(0n), null);
  assert.equal(s2CellToLatLng(0xe000000000000001n), null); // face 7
  assert.equal(placeHint('https://www.google.com/maps/place/foo'), null);
});
