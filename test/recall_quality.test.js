import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './eval/recall-eval.js';

// 想起品質の回帰テスト: BM25 が recency baseline を有意に上回り、secret を漏らさないこと。
test('recall: BM25 は recency を大きく上回る（Recall@5 / MRR）', () => {
  const r = run();
  assert.equal(r.fts_enabled, true, 'FTS5 が有効であること');
  assert.ok(r.bm25.recall_at_k >= 0.8, `BM25 Recall@5 >= 0.8（実測 ${r.bm25.recall_at_k}）`);
  assert.ok(r.bm25.mrr >= 0.8, `BM25 MRR >= 0.8（実測 ${r.bm25.mrr}）`);
  // recency より明確に優れる（少なくとも 2 倍の Recall）
  assert.ok(r.bm25.recall_at_k >= r.recency.recall_at_k * 2, `BM25 Recall は recency の 2 倍以上（${r.bm25.recall_at_k} vs ${r.recency.recall_at_k}）`);
});

test('recall: BM25 も recency も secret を top-K に漏らさない', () => {
  const r = run();
  assert.equal(r.bm25.secret_leaks, 0);
  assert.equal(r.recency.secret_leaks, 0);
});
