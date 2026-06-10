import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vecToBuf, bufToVec, cosine, cosineFromBuf, l2norm, embedAvailable, embedConfig } from '../src/embed.js';
import { withFreshStore, testConfig } from './helpers.js';

test('embed: Float32 ⇄ Buffer ラウンドトリップ', () => {
  const v = [0.1, -0.5, 1.0, 0.333];
  const back = bufToVec(vecToBuf(v));
  for (let i = 0; i < v.length; i++) assert.ok(Math.abs(back[i] - v[i]) < 1e-6);
});

test('embed: 非4整列バッファでも例外なく復元（SQLite BLOB のアラインメント耐性）', () => {
  const v = [0.1, -0.5, 1.0, 0.333, -0.999];
  const src = vecToBuf(v);
  const padded = Buffer.alloc(src.length + 1);
  src.copy(padded, 1);
  const misaligned = padded.subarray(1); // byteOffset=1（4 の倍数でない）
  const back = bufToVec(misaligned);
  for (let i = 0; i < v.length; i++) assert.ok(Math.abs(back[i] - v[i]) < 1e-6);
});

test('embed: cosineFromBuf は cosine と一致（スケール最適化が結果を変えない）', () => {
  const a = [0.2, -0.7, 0.5, 0.9, -0.1, 0.33];
  const b = [0.1, 0.4, -0.6, 0.8, 0.2, -0.5];
  const buf = vecToBuf(b);
  const expected = cosine(Float32Array.from(a), Float32Array.from(b));
  const got = cosineFromBuf(Float32Array.from(a), l2norm(Float32Array.from(a)), buf);
  assert.ok(Math.abs(expected - got) < 1e-5, `${expected} ≈ ${got}`);
  // 非整列バッファでも一致
  const padded = Buffer.alloc(buf.length + 1); buf.copy(padded, 1);
  const got2 = cosineFromBuf(Float32Array.from(a), l2norm(Float32Array.from(a)), padded.subarray(1));
  assert.ok(Math.abs(expected - got2) < 1e-5);
});

test('embed: cosine の基本性質', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  assert.ok(cosine([1, 1], [1, 0.9]) > 0.99);
  assert.equal(cosine([0, 0], [1, 1]), 0); // ゼロベクトルは 0
});

test('embed: API キーが無ければ embedAvailable=false（FTS のみで動く）', () => {
  const cfg = testConfig();
  const env = process.env[embedConfig(cfg).api_key_env];
  delete process.env[embedConfig(cfg).api_key_env];
  try {
    assert.equal(embedAvailable(cfg), false);
  } finally {
    if (env !== undefined) process.env[embedConfig(cfg).api_key_env] = env;
  }
});

test('store: 埋め込みの upsert と vectorSearch', () => {
  withFreshStore((store) => {
    const a = store.addObservation({ text: 'りんご', project: 'p' });
    const b = store.addObservation({ text: 'みかん', project: 'p' });
    store.upsertEmbedding(a.id, 'test', vecToBuf([1, 0, 0]));
    store.upsertEmbedding(b.id, 'test', vecToBuf([0, 1, 0]));
    assert.equal(store.embeddingCount(), 2);
    const res = store.vectorSearch(Float32Array.from([0.9, 0.1, 0]), { project: 'p', limit: 2, cosine });
    assert.equal(res[0].id, a.id); // [1,0,0] に近い方が上位
    assert.ok(res[0].sim > res[1].sim);
    // upsert（更新）
    store.upsertEmbedding(a.id, 'test', vecToBuf([0, 0, 1]));
    assert.equal(store.embeddingCount(), 2);
  });
});
