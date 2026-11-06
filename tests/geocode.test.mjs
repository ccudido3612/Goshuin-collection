import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUrl, parseMapsLink, parseNominatim, parseGsi, createGeocoder } from '../js/geocode.js';

// 使用者實際從 Google 地圖（住吉大社）取得的展開後網址
const SUMIYOSHI =
  'https://www.google.com/maps?q=%E4%BD%8F%E5%90%89%E5%A4%A7%E7%A4%BE+2+Chome-9-89+Sumiyoshi,+Sumiyoshi+Ward,+Osaka,+558-0045%E6%97%A5%E6%9C%AC&ftid=0x6000e7bbc67c0001:0xa7f51dfe4d001f82&entry=gps&shh=CAE&lucs=,94297699,94231188&g_ep=CAISEjI2LjQ0LjQuMDA2ODc3NDIxMBgAINeCAypyLDk0Mjk3Njk5&skid=005c26a6';

test('parseMapsLink：實際的住吉大社網址 → 名稱與地址、沒有座標、連結被縮短', () => {
  const r = parseMapsLink(SUMIYOSHI);
  assert.equal(r.kind, 'full');
  assert.equal(r.name, '住吉大社');
  assert.match(r.address, /^2 Chome-9-89 Sumiyoshi/);
  assert.equal(r.query, '住吉大社');
  assert.equal(r.lat, null);
  assert.ok(r.link.length < 350, '追蹤參數應該被去掉（原網址約 480 字）');
  assert.ok(r.link.includes('ftid=0x6000e7bbc67c0001'));
  assert.ok(!r.link.includes('g_ep'));
});

test('parseMapsLink：短連結（去掉 ?g_st）與分享文字', () => {
  const r = parseMapsLink('住吉大社\nhttps://maps.app.goo.gl/XgrPp7EpcmEgYTaf7?g_st=ic');
  assert.equal(r.kind, 'short');
  assert.equal(r.link, 'https://maps.app.goo.gl/XgrPp7EpcmEgYTaf7');
});

test('parseMapsLink：/maps/place/名稱/@座標 的寫法', () => {
  const r = parseMapsLink('https://www.google.com/maps/place/%E4%BD%8F%E5%90%89%E5%A4%A7%E7%A4%BE/@34.6118,135.4934,17z/data=!3d34.6120!4d135.4930');
  assert.equal(r.name, '住吉大社');
  assert.equal(r.lat, 34.612);
  assert.equal(r.lng, 135.493);
});

test('parseMapsLink：q 是座標、q 只有地址、不是 Google 地圖', () => {
  assert.deepEqual([parseMapsLink('https://www.google.com/maps?q=34.6,135.5').lat, parseMapsLink('https://www.google.com/maps?q=34.6,135.5').name], [34.6, '']);
  const addr = parseMapsLink('https://www.google.com/maps?q=558-0045+Osaka');
  assert.equal(addr.name, '');
  assert.equal(addr.query, '558-0045 Osaka');
  assert.equal(parseMapsLink('https://example.com/maps?q=x'), null);
  assert.equal(parseMapsLink('不是網址'), null);
  assert.equal(extractUrl('a https://x.y/z?a=1 b'), 'https://x.y/z?a=1');
});

test('parseNominatim / parseGsi：欄位轉換、過濾壞座標', () => {
  const n = parseNominatim([{ name: '住吉大社', display_name: '住吉大社, 住吉区, 大阪市', lat: '34.6118', lon: '135.4934' }, { lat: 'x', lon: '1' }]);
  assert.equal(n.length, 1);
  assert.equal(n[0].title, '住吉大社');
  assert.equal(n[0].lng, 135.4934);
  const g = parseGsi([{ geometry: { coordinates: [135.49, 34.61] }, properties: { title: '大阪府大阪市住吉区住吉' } }]);
  assert.equal(g[0].lat, 34.61);
  assert.deepEqual(parseNominatim(null), []);
});

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

test('search：Nominatim 優先，結果夠多就不再問地理院；帶 countrycodes=jp 與日文', async () => {
  const urls = [];
  const geo = createGeocoder({
    wait: async () => {},
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonRes([
        { name: 'A', display_name: 'A', lat: '34.61', lon: '135.49' },
        { name: 'B', display_name: 'B', lat: '35.00', lon: '135.00' },
      ]);
    },
  });
  const { results, error } = await geo.search('住吉大社');
  assert.equal(error, null);
  assert.equal(results.length, 2);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /countrycodes=jp/);
  assert.match(urls[0], /accept-language=ja/);
});

test('search：Nominatim 失敗時退回地理院；兩個都失敗才回報錯誤', async () => {
  const geo = createGeocoder({
    wait: async () => {},
    fetchImpl: async (url) => {
      if (url.includes('nominatim')) throw new TypeError('blocked');
      return jsonRes([{ geometry: { coordinates: [135.49, 34.61] }, properties: { title: '住吉' } }]);
    },
  });
  const ok = await geo.search('住吉');
  assert.equal(ok.results.length, 1);
  assert.equal(ok.error, null);

  const dead = createGeocoder({ wait: async () => {}, fetchImpl: async () => jsonRes({}, false, 500) });
  const r = await dead.search('x');
  assert.equal(r.results.length, 0);
  assert.ok(r.error);
});

test('search：重疊的候選會合併；空字串不發請求；請求之間會等待', async () => {
  let calls = 0;
  const waits = [];
  const geo = createGeocoder({
    minIntervalMs: 1100,
    wait: async (ms) => waits.push(ms),
    fetchImpl: async () => (calls++, jsonRes([{ name: 'A', lat: '34.6100', lon: '135.4900' }])),
  });
  const { results } = await geo.search('x'); // Nominatim 與地理院各回同一個點 → 合併成 1 筆
  assert.equal(results.length, 1);
  assert.equal(calls, 2);
  assert.ok(waits.length >= 1 && waits.every((ms) => ms > 0 && ms <= 1100));

  calls = 0;
  assert.deepEqual(await geo.search('  '), { results: [], error: null });
  assert.equal(calls, 0);
});
