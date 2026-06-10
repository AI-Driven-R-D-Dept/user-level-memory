import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFreshStore } from './helpers.js';

test('observation: 追記と取得', () => {
  withFreshStore((store) => {
    const o = store.addObservation({ text: 'コツA', project: 'p1', tags: ['x'] });
    assert.match(o.id, /^obs-[0-9a-f]{6}$/);
    assert.equal(o.text, 'コツA');
    assert.deepEqual(o.tags, ['x']);
    assert.equal(store.getObservation(o.id).text, 'コツA');
    assert.equal(store.countObservations(), 1);
  });
});

test('observation: 空テキストは拒否', () => {
  withFreshStore((store) => {
    assert.throws(() => store.addObservation({ text: '   ' }));
  });
});

test('observation: secret は既定 list から除外、include で出る', () => {
  withFreshStore((store) => {
    store.addObservation({ text: '公開', project: 'p' });
    store.addObservation({ text: '秘密', project: 'p', secret: true });
    assert.equal(store.listObservations({ project: 'p' }).length, 1);
    assert.equal(store.listObservations({ project: 'p', includeSecret: true }).length, 2);
  });
});

test('observation: redact は墓石化し本文を消す', () => {
  withFreshStore((store) => {
    const o = store.addObservation({ text: '機密がうっかり' });
    store.redactObservation(o.id);
    assert.equal(store.getObservation(o.id).text, '[redacted]');
    assert.equal(store.listObservations({}).length, 0); // 既定 list から消える
    assert.equal(store.countObservations(), 0);
  });
});

test('observation: pin と archive フラグ', () => {
  withFreshStore((store) => {
    const o = store.addObservation({ text: '重要', project: 'p' });
    store.setObservationFlags(o.id, { pinned: true });
    assert.equal(store.listObservations({ pinnedOnly: true }).length, 1);
    store.setObservationFlags(o.id, { archived: true });
    assert.equal(store.listObservations({ project: 'p' }).length, 0); // archived は既定除外
    assert.equal(store.listObservations({ project: 'p', includeArchived: true }).length, 1);
  });
});

test('observation: tag 編集', () => {
  withFreshStore((store) => {
    const o = store.addObservation({ text: 't', tags: ['a', 'b'] });
    store.setObservationTags(o.id, ['a', 'c']);
    assert.deepEqual(store.getObservation(o.id).tags.sort(), ['a', 'c']);
  });
});

test('observation: global(project IS NULL) フィルタ', () => {
  withFreshStore((store) => {
    store.addObservation({ text: 'g', project: null });
    store.addObservation({ text: 'p', project: 'proj' });
    const g = store.listObservations({ global: true });
    assert.equal(g.length, 1);
    assert.equal(g[0].text, 'g');
  });
});

test('state: set/get と上書き', () => {
  withFreshStore((store) => {
    store.setState('k', 'v1');
    assert.equal(store.getState('k').value, 'v1');
    store.setState('k', 'v2');
    assert.equal(store.getState('k').value, 'v2'); // 上書き
  });
});

test('state: TTL 期限切れは get で無視', () => {
  withFreshStore((store) => {
    store.setState('exp', 'x', { ttlMs: -1000 }); // 過去
    assert.equal(store.getState('exp'), null);
    assert.equal(store.listStates().length, 0);
    assert.equal(store.listStates({ includeExpired: true }).length, 1);
  });
});

test('state: scope 分離', () => {
  withFreshStore((store) => {
    store.setState('k', 'global-v', { scope: 'global' });
    store.setState('k', 'proj-v', { scope: 'projX' });
    assert.equal(store.getState('k', { scope: 'global' }).value, 'global-v');
    assert.equal(store.getState('k', { scope: 'projX' }).value, 'proj-v');
  });
});

test('state: secret は listStates で除外オプション', () => {
  withFreshStore((store) => {
    store.setState('pub', 'v');
    store.setState('sec', 'token', { secret: true });
    assert.equal(store.listStates({ includeSecret: false }).length, 1);
    assert.equal(store.listStates({ includeSecret: true }).length, 2);
  });
});

test('state: unset で削除', () => {
  withFreshStore((store) => {
    store.setState('k', 'v');
    assert.equal(store.deleteState('k'), 1);
    assert.equal(store.getState('k'), null);
  });
});

test('candidate: 追加と重複検出', () => {
  withFreshStore((store) => {
    const c = store.addCandidate({ hypothesis: '赤ボタンが有効', origin: 'manual' });
    assert.match(c.id, /^cand-[0-9a-f]{6}$/);
    assert.equal(c.status, 'inbox');
    // 表記違いでも正規化ハッシュで重複検出
    const dup = store.addCandidate({ hypothesis: '赤ボタンが有効。', origin: 'manual' });
    assert.equal(dup.duplicateOf, c.id);
  });
});

test('candidate: approve → promote のライフサイクル', () => {
  withFreshStore((store) => {
    const c = store.addCandidate({ hypothesis: 'h', origin: 'manual' });
    store.reviewCandidate(c.id, 'approved', 'ok');
    assert.equal(store.getCandidate(c.id).status, 'approved');
    store.markPromoted(c.id, '/tmp/ref.md');
    assert.equal(store.getCandidate(c.id).status, 'promoted');
    // promoted は再レビュー不可
    assert.throws(() => store.reviewCandidate(c.id, 'rejected'));
  });
});

test('candidate: edit で条件を磨ける', () => {
  withFreshStore((store) => {
    const c = store.addCandidate({ hypothesis: 'h', origin: 'manual' });
    const e = store.editCandidate(c.id, { conditions: '狭めた条件' });
    assert.equal(e.conditions, '狭めた条件');
  });
});

test('candidate: reject-stale は古い inbox のみ', () => {
  withFreshStore((store) => {
    const c = store.addCandidate({ hypothesis: 'old', origin: 'manual' });
    // ts を強制的に古くする
    store.db.prepare('UPDATE candidates SET ts = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', c.id);
    store.addCandidate({ hypothesis: 'new', origin: 'manual' });
    const n = store.rejectStale(30);
    assert.equal(n, 1);
    assert.equal(store.getCandidate(c.id).status, 'rejected');
    assert.equal(store.inboxCount(), 1);
  });
});

test('ref: 追加・重複・削除', () => {
  withFreshStore((store) => {
    const r = store.addRef({ path: '/a/b.md', note: 'n' });
    assert.match(r.id, /^ref-/);
    const dup = store.addRef({ path: '/a/b.md' });
    assert.equal(dup.id, r.id); // 同パスは既存を返す
    assert.equal(store.removeRef(r.id), 1);
    assert.equal(store.listRefs().length, 0);
  });
});

test('ref: project スコープ（NULL は全 project に出る）', () => {
  withFreshStore((store) => {
    store.addRef({ path: '/g.md', project: null });
    store.addRef({ path: '/p.md', project: 'projA' });
    store.addRef({ path: '/q.md', project: 'projB' });
    assert.equal(store.listRefs({ project: 'projA' }).length, 2); // g + p
  });
});

test('export/import: ラウンドトリップ', () => {
  withFreshStore((store) => {
    store.addObservation({ text: 'o1', project: 'p' });
    const rows = store.allRows('observations');
    assert.equal(rows.length, 1);
    // 別ストアへ import
    const inserted = store.importRows('observations', [{ id: 'obs-aaaaaa', ts: '2026-01-01T00:00:00Z', project: 'p', text: 'imported', tags: '[]', source: 'import', secret: 0, meta: '{}', pinned: 0, redacted: 0, archived: 0 }]);
    assert.equal(inserted, 1);
    assert.equal(store.getObservation('obs-aaaaaa').text, 'imported');
    // 同 ID は IGNORE
    assert.equal(store.importRows('observations', [{ id: 'obs-aaaaaa', ts: '2026-01-01T00:00:00Z', text: 'dup', tags: '[]', source: 'import', secret: 0, meta: '{}', pinned: 0, redacted: 0, archived: 0 }]), 0);
  });
});

test('schema version は 2', () => {
  withFreshStore((store) => {
    assert.equal(store.schemaVersion(), 2);
  });
});
