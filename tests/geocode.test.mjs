import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUrl, parseMapsLink, parseNominatim, parseGsi, createGeocoder, searchVariants, looksLikeAddress, formatJpAddress, toShinjitai } from '../js/geocode.js';

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

test('search：Nominatim 優先並帶 countrycodes=jp、日文；名稱不會送去地理院地址搜尋', async () => {
  const urls = [];
  const geo = createGeocoder({
    wait: async () => {},
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonRes([{ name: 'A', display_name: 'A', lat: '34.61', lon: '135.49' }]);
    },
  });
  const { results, error } = await geo.search('玉龍山 浄光寺');
  assert.equal(error, null);
  assert.equal(results.length, 1);
  assert.ok(urls.every((u) => u.includes('nominatim')), '名稱搜尋不該呼叫地理院');
  assert.match(urls[0], /countrycodes=jp/);
  assert.match(urls[0], /accept-language=ja/);
});

test('search：找不到時會換寫法再試（去山號、新舊字體），而且不會拿「玉」去配地址', async () => {
  const queries = [];
  const geo = createGeocoder({
    wait: async () => {},
    fetchImpl: async (url) => {
      queries.push(new URL(url).searchParams.get('q'));
      return jsonRes([]);
    },
  });
  const { results } = await geo.search('玉龍山 浄光寺');
  assert.equal(results.length, 0);
  assert.ok(queries.includes('浄光寺'));
  assert.ok(queries.length <= 3);
});

test('search：像地址的輸入走地理院；Nominatim 失敗仍有地理院的結果；全部失敗才回報錯誤', async () => {
  const geo = createGeocoder({
    wait: async () => {},
    fetchImpl: async (url) => {
      if (url.includes('nominatim')) throw new TypeError('blocked');
      return jsonRes([{ geometry: { coordinates: [135.68, 34.93] }, properties: { title: '京都府長岡京市井ノ内南内畑' } }]);
    },
  });
  const ok = await geo.search('京都府長岡京市井ノ内南内畑73');
  assert.equal(ok.results.length, 1);
  assert.equal(ok.error, null);

  const dead = createGeocoder({ wait: async () => {}, fetchImpl: async () => jsonRes({}, false, 500) });
  const r = await dead.search('神社');
  assert.equal(r.results.length, 0);
  assert.ok(r.error);
});

test('search + hint：先在推測位置附近（viewbox + bounded）找、依距離排序、最後附上推測位置', async () => {
  const hint = { lat: 34.94, lng: 135.69 };
  const urls = [];
  const geo = createGeocoder({
    wait: async () => {},
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonRes([
        { name: '遠', display_name: '遠', lat: '34.80', lon: '135.50' },
        { name: '近', display_name: '近', lat: '34.941', lon: '135.688' },
      ]);
    },
  });
  const { results } = await geo.search('浄光寺', { hint });
  assert.match(urls[0], /bounded=1/);
  assert.match(urls[0], /viewbox=/);
  assert.equal(results[0].title, '近');
  assert.ok(results[0].distanceKm < results[1].distanceKm);
  const last = results.at(-1);
  assert.equal(last.approximate, true);
  assert.equal(last.lat, 34.94);
});

test('search + hint：附近找不到時放寬範圍再找；全部連不上仍給推測位置，不回報錯誤', async () => {
  const urls = [];
  const geo = createGeocoder({
    wait: async () => {},
    fetchImpl: async (url) => {
      urls.push(url);
      throw new TypeError('offline');
    },
  });
  const r = await geo.search('Ryuonji Temple', { hint: { lat: 35.1, lng: 135.4 } });
  assert.ok(urls.some((u) => u.includes('bounded=1')) && urls.some((u) => !u.includes('bounded=1')));
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].approximate, true);
  assert.equal(r.error, null);
});

test('search：重疊的候選會合併；空字串不發請求；請求之間會等待', async () => {
  let calls = 0;
  const waits = [];
  const geo = createGeocoder({
    minIntervalMs: 1100,
    wait: async (ms) => waits.push(ms),
    fetchImpl: async () => (calls++, jsonRes([{ name: 'A', lat: '34.6100', lon: '135.4900' }, { name: 'A2', lat: '34.6101', lon: '135.4901' }])),
  });
  const { results } = await geo.search('住吉大社');
  assert.equal(results.length, 1);
  assert.equal(calls, 1);

  await geo.search('住吉大社'); // 第二次請求 → 要等
  assert.ok(waits.length >= 1 && waits.every((ms) => ms > 0 && ms <= 1100));

  calls = 0;
  assert.deepEqual(await geo.search('  '), { results: [], error: null });
  assert.equal(calls, 0);
});

test('reverse：座標 → 日文地址；失敗與壞座標', async () => {
  const geo = createGeocoder({
    wait: async () => {},
    fetchImpl: async (url) => {
      assert.match(url, /\/reverse\?/);
      return jsonRes({ display_name: 'x', address: { postcode: '617-0813', state: '京都府', city: '長岡京市', suburb: '井ノ内' } });
    },
  });
  assert.deepEqual(await geo.reverse(34.94, 135.68), { address: '〒617-0813 京都府長岡京市井ノ内', error: null });
  assert.ok((await geo.reverse(999, 0)).error);
  const dead = createGeocoder({ wait: async () => {}, fetchImpl: async () => { throw new TypeError('x'); } });
  assert.ok((await dead.reverse(34.9, 135.6)).error);
});

test('searchVariants：寺名、新舊字體、羅馬拼音', () => {
  const a = searchVariants('玉龍山 浄光寺');
  assert.ok(a.includes('玉龍山 浄光寺') && a.includes('玉龍山浄光寺') && a.includes('浄光寺'));
  assert.ok(searchVariants('高山稻荷神社').includes('高山稲荷神社'));
  assert.ok(searchVariants('多摩川淺間神社').includes('多摩川浅間神社'));
  assert.ok(searchVariants('大阪天滿宮').includes('大阪天満宮'));
  assert.ok(searchVariants('村松山虛空藏堂 日高寺').includes('日高寺'));
  const r = searchVariants('Ryuonji Temple');
  assert.deepEqual(r, ['Ryuonji Temple', 'Ryuonji', 'Ryuon-ji']);
  assert.deepEqual(searchVariants('Enmei-in Temple'), ['Enmei-in Temple', 'Enmei-in']);
  assert.deepEqual(searchVariants('   '), []);
  assert.equal(toShinjitai('玉龍山'), '玉龍山', '龍不換');
});

test('looksLikeAddress / formatJpAddress', () => {
  assert.ok(looksLikeAddress('京都府長岡京市井ノ内南内畑73'));
  assert.ok(looksLikeAddress('〒617-0813'));
  assert.ok(looksLikeAddress('大阪市住吉区住吉2丁目9-89'));
  assert.ok(!looksLikeAddress('玉龍山 浄光寺'));
  assert.ok(!looksLikeAddress('住吉大社'));
  assert.equal(formatJpAddress({ state: '大阪府', city: '大阪市', city_district: '住吉区', suburb: '住吉', quarter: '2丁目', postcode: '558-0045' }), '〒558-0045 大阪府大阪市住吉区住吉2丁目');
  assert.equal(formatJpAddress(null), '');
});

test('parseMapsLink：網址裡的地點編號 → hint 與 key', () => {
  const r = parseMapsLink(SUMIYOSHI);
  assert.equal(r.key, 'a7f51dfe4d001f82');
  assert.ok(r.hint && r.hint.lat > 34 && r.hint.lat < 35);
});
