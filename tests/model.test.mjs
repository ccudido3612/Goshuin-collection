import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeEntry,
  summarize,
  sortEntries,
  filterEntries,
  mergeImported,
  validateBackup,
  displayName,
  hasLocation,
  BACKUP_APP,
} from '../js/model.js';
import { SAMPLES } from '../js/samples.js';

test('makeEntry 會把不合法的欄位整理成預設值', () => {
  const e = makeEntry({ kind: 'castle', status: 'done', lat: 0, lng: 0, visitedAt: '昨天', name: 123 });
  assert.equal(e.kind, 'shrine');
  assert.equal(e.status, 'want');
  assert.equal(e.lat, null);
  assert.equal(e.lng, null);
  assert.equal(e.visitedAt, null);
  assert.equal(e.name, '');
  assert.ok(e.id.startsWith('e_'));
  assert.equal(hasLocation(e), false);
  assert.equal(displayName(e), '（未命名）');
});

test('makeEntry 保留合法資料', () => {
  const e = makeEntry({ id: 'x1', name: '明治神宮', kind: 'shrine', status: 'got', lat: 35.67, lng: 139.69, visitedAt: '2026-11-02', photoIds: ['p1', 5], photoKeys: ['k1'] });
  assert.equal(e.id, 'x1');
  assert.equal(e.status, 'got');
  assert.deepEqual(e.photoIds, ['p1']);
  assert.equal(hasLocation(e), true);
});

test('範例資料都是合法的紀錄', () => {
  for (const s of SAMPLES) {
    const e = makeEntry(s);
    assert.equal(hasLocation(e), true, s.name);
    assert.equal(e.sample, true);
    assert.equal(e.id, s.id);
  }
  assert.equal(new Set(SAMPLES.map((s) => s.id)).size, SAMPLES.length);
});

test('summarize / filterEntries / sortEntries', () => {
  const list = [
    makeEntry({ id: 'a', name: '明治神宮', status: 'got', lat: 35.6, lng: 139.6, visitedAt: '2026-11-01' }),
    makeEntry({ id: 'b', name: '浅草寺', status: 'want', lat: 35.7, lng: 139.7, note: '雷門' }),
    makeEntry({ id: 'c', name: '', status: 'got', visitedAt: '2026-11-03' }),
  ];
  assert.deepEqual(summarize(list), { total: 3, got: 2, want: 1, unlocated: 1 });
  assert.deepEqual(sortEntries(list).map((e) => e.id), ['c', 'a', 'b']);
  assert.deepEqual(filterEntries(list, { filter: 'unlocated' }).map((e) => e.id), ['c']);
  assert.deepEqual(filterEntries(list, { filter: 'got' }).map((e) => e.id), ['c', 'a']);
  assert.deepEqual(filterEntries(list, { query: '雷門' }).map((e) => e.id), ['b']);
  assert.deepEqual(filterEntries(list, { query: '神宮' }).map((e) => e.id), ['a']);
});

test('mergeImported 只加入新的 id', () => {
  const existing = [makeEntry({ id: 'a', name: '舊的' })];
  const incoming = [makeEntry({ id: 'a', name: '同 id 但不同內容' }), makeEntry({ id: 'b' })];
  const r = mergeImported(existing, incoming);
  assert.equal(r.added, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].name, '舊的');
});

test('validateBackup 擋掉不是這個 app 的檔案，並過濾壞照片', () => {
  assert.equal(validateBackup(null).ok, false);
  assert.equal(validateBackup({ app: 'other', entries: [] }).ok, false);
  assert.equal(validateBackup({ app: BACKUP_APP }).ok, false);
  const r = validateBackup({
    app: BACKUP_APP,
    entries: [{ id: 'a', name: 'x' }],
    photos: { p1: 'data:image/jpeg;base64,AAAA', p2: 'javascript:alert(1)', p3: 42 },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.photos), ['p1']);
});
