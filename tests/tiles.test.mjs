import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lngToTileX,
  latToTileY,
  tileBounds,
  tileRange,
  countTiles,
  planTiles,
  iterateTiles,
  fillTemplate,
  estimateMB,
} from '../js/tiles.js';

const TOKYO = { lat: 35.6812, lng: 139.7671 };

test('世界邊界與 z=0', () => {
  assert.equal(lngToTileX(-180, 3), 0);
  assert.equal(lngToTileX(180, 3), 7); // 剛好在邊界時不能超出 2^z - 1
  assert.equal(lngToTileX(10, 0), 0);
  assert.equal(latToTileY(89, 3), 0); // 超過 Mercator 緯度上限會被夾住
  assert.equal(latToTileY(-89, 3), 7);
});

test('往返驗算：座標一定落在它所屬圖磚的範圍內（多個層級）', () => {
  for (const z of [5, 10, 13, 15, 17]) {
    const x = lngToTileX(TOKYO.lng, z);
    const y = latToTileY(TOKYO.lat, z);
    const b = tileBounds(x, y, z);
    assert.ok(TOKYO.lng >= b.west && TOKYO.lng < b.east, `z${z} 經度`);
    assert.ok(TOKYO.lat <= b.north && TOKYO.lat > b.south, `z${z} 緯度`);
  }
});

test('z=10 的東京是 (909, 403) 附近', () => {
  assert.equal(lngToTileX(TOKYO.lng, 10), 909);
  assert.equal(latToTileY(TOKYO.lat, 10), 403);
});

test('tileRange / countTiles：範圍越大、層級越細，圖磚越多', () => {
  const small = { west: 139.69, east: 139.71, south: 35.67, north: 35.69 };
  const r = tileRange(small, 15);
  assert.ok(r.x0 <= r.x1 && r.y0 <= r.y1);
  assert.equal(countTiles(small, 15), (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1));
  assert.ok(countTiles(small, 16) >= countTiles(small, 15) * 3); // 每放大一級約 4 倍
});

test('iterateTiles 產生的數量等於 countTiles 的總和，且沒有重複', () => {
  const b = { west: 139.69, east: 139.72, south: 35.67, north: 35.7 };
  const tiles = [...iterateTiles(b, 13, 15)];
  const expected = [13, 14, 15].reduce((s, z) => s + countTiles(b, z), 0);
  assert.equal(tiles.length, expected);
  assert.equal(new Set(tiles.map((t) => `${t.z}/${t.x}/${t.y}`)).size, tiles.length);
});

test('planTiles：超過上限會自動降低最細層級', () => {
  const b = { west: 139.6, east: 139.9, south: 35.55, north: 35.8 };
  const loose = planTiles(b, { minZoom: 10, maxZoom: 16, cap: 1e9 });
  assert.equal(loose.reduced, false);
  assert.equal(loose.maxZoom, 16);

  const capped = planTiles(b, { minZoom: 10, maxZoom: 16, cap: 300 });
  assert.equal(capped.reduced, true);
  assert.ok(capped.maxZoom < 16);
  assert.ok(capped.count <= 300);
});

test('planTiles：連最粗層級都放不下時回報 tooLarge', () => {
  const huge = { west: 120, east: 150, south: 20, north: 50 };
  const plan = planTiles(huge, { minZoom: 12, maxZoom: 16, cap: 100 });
  assert.equal(plan.tooLarge, true);
  assert.equal(plan.maxZoom, 12);
});

test('fillTemplate / estimateMB', () => {
  assert.equal(
    fillTemplate('https://example.com/xyz/std/{z}/{x}/{y}.png', 15, 29100, 12900),
    'https://example.com/xyz/std/15/29100/12900.png',
  );
  assert.ok(Math.abs(estimateMB(1024) - 15) < 1e-9);
});
