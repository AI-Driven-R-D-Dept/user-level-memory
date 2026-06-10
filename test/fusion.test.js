import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuseVectorPrimary } from '../src/recall.js';

// 外部評価が見つけた「等重み RRF が強い vector を弱い FTS で引き下げる」欠陥の回帰。
// 融合は vector の順位を保持し、FTS 固有ヒットだけ末尾に足す。

test('fusion: vector の順位を完全保持する（hybrid ranking ≥ vector を保証）', () => {
  const vec = [{ id: 'A', sim: 0.9 }, { id: 'B', sim: 0.8 }, { id: 'C', sim: 0.7 }];
  const fts = [{ id: 'C', rank: -1 }, { id: 'A', rank: -2 }]; // FTS は別順位だが…
  const out = fuseVectorPrimary(vec, fts, new Map(fts.map((o) => [o.id, o])));
  assert.deepEqual(out.slice(0, 3).map((o) => o.id), ['A', 'B', 'C'], 'vector の順序が保たれる');
});

test('fusion: FTS 固有ヒットは末尾に救済追加される（Recall を守る）', () => {
  const vec = [{ id: 'A', sim: 0.9 }, { id: 'B', sim: 0.8 }];
  const fts = [{ id: 'D', rank: -1 }, { id: 'A', rank: -2 }]; // D は vector に無い固有ヒット
  const out = fuseVectorPrimary(vec, fts, new Map(fts.map((o) => [o.id, o])));
  assert.deepEqual(out.map((o) => o.id), ['A', 'B', 'D'], 'vector の後に FTS 固有 D が来る');
  // 先頭は必ず vector のトップ（弱い FTS が割り込まない）
  assert.equal(out[0].id, 'A');
});

test('fusion: vector が空でも FTS 固有だけで成立', () => {
  const out = fuseVectorPrimary([], [{ id: 'X', rank: -1 }], new Map([['X', { id: 'X', rank: -1 }]]));
  assert.deepEqual(out.map((o) => o.id), ['X']);
});
