import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceMeters,
  isValidLatLng,
  parseExifDateTime,
  todayISO,
  dateTimeFromMillis,
  formatDate,
  mapsUrl,
  groupPhotos,
} from '../js/geo.js';

test('distanceMeters: 東京車站到明治神宮約 6 公里', () => {
  const tokyo = { lat: 35.6812, lng: 139.7671 };
  const meiji = { lat: 35.6764, lng: 139.6993 };
  const d = distanceMeters(tokyo, meiji);
  assert.ok(d > 6000 && d < 6400, `距離 ${d}`);
  assert.equal(distanceMeters(tokyo, tokyo), 0);
});

test('isValidLatLng 排除 (0,0)、超出範圍與非數字', () => {
  assert.equal(isValidLatLng(35.68, 139.76), true);
  assert.equal(isValidLatLng(0, 0), false);
  assert.equal(isValidLatLng(91, 10), false);
  assert.equal(isValidLatLng(10, 181), false);
  assert.equal(isValidLatLng(NaN, 10), false);
  assert.equal(isValidLatLng(null, null), false);
});

test('parseExifDateTime', () => {
  assert.deepEqual(parseExifDateTime('2026:11:02 14:50:01'), { date: '2026-11-02', time: '14:50' });
  assert.deepEqual(parseExifDateTime('2026-11-02T09:05:00'), { date: '2026-11-02', time: '09:05' });
  assert.equal(parseExifDateTime('0000:00:00 00:00:00'), null);
  assert.equal(parseExifDateTime('hello'), null);
  assert.equal(parseExifDateTime(undefined), null);
});

test('todayISO / dateTimeFromMillis / formatDate / mapsUrl', () => {
  assert.equal(todayISO(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  const t = dateTimeFromMillis(new Date(2026, 10, 2, 8, 7).getTime());
  assert.deepEqual(t, { date: '2026-11-02', time: '08:07' });
  assert.equal(dateTimeFromMillis(0), null);
  assert.equal(formatDate('2026-11-02'), '2026/11/02');
  assert.equal(formatDate(null), '');
  assert.equal(mapsUrl(35.1, 139.2), 'https://www.google.com/maps/search/?api=1&query=35.1,139.2');
});

test('groupPhotos: 同一天且 150 公尺內合併，其餘分開', () => {
  const near = (dLat) => ({ lat: 35.6764 + dLat, lng: 139.6993 });
  const items = [
    { id: 'a', ...near(0), date: '2026-11-02', time: '10:00' },
    { id: 'b', ...near(0.0004), date: '2026-11-02', time: '10:05' }, // 約 44 公尺
    { id: 'c', ...near(0.0008), date: '2026-11-02', time: '10:20' }, // 約 89 公尺
    { id: 'd', lat: 35.7148, lng: 139.7967, date: '2026-11-02', time: '14:00' }, // 同天不同地
    { id: 'e', ...near(0), date: '2026-11-03', time: '09:00' }, // 同地不同天
    { id: 'f', lat: null, lng: null, date: '2026-11-02', time: '16:00' }, // 沒位置
    { id: 'g', lat: null, lng: null, date: '2026-11-02', time: '16:10' }, // 沒位置
  ];
  const groups = groupPhotos(items);
  assert.equal(groups.length, 4);
  const sizes = groups.map((g) => g.items.map((i) => i.id).join(''));
  assert.deepEqual(sizes, ['abc', 'd', 'fg', 'e']);
  const noLoc = groups.find((g) => g.items[0].id === 'f');
  assert.equal(noLoc.lat, null);
  assert.equal(noLoc.lng, null);
});

test('groupPhotos: 沒日期的排最後、亂序輸入也能分組', () => {
  const groups = groupPhotos([
    { id: 'x', lat: 35, lng: 139, date: null, time: null },
    { id: 'y', lat: 35, lng: 139, date: '2026-01-01', time: '10:00' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].date, '2026-01-01');
  assert.equal(groups[1].date, null);
});
