import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFreshStoreAsync, testConfig } from './helpers.js';
import { recallObservations } from '../src/recall.js';

// 読み取り時ゲートの回帰: 入口ゲートを迂回(importRows)して入った secret=0 の機密が
// recall(FTS/vector) の注入候補に出ないこと。embedding 無し(キー無し)でも FTS 経路で守る。
test('recall: importRows 由来の secret=0 機密は読み取りゲートで除外', async () => {
  await withFreshStoreAsync(async (store) => {
    store.importRows('observations', [
      { id: 'obs-leak01', ts: new Date().toISOString(), project: 'p', text: 'HuggingFace token は hf_SHOULDNOTLEAK1234567890ABCD', tags: '[]', source: 'import', secret: 0, meta: '{}', pinned: 0, redacted: 0, archived: 0 },
      { id: 'obs-ok01', ts: new Date().toISOString(), project: 'p', text: 'tailwind の content 設定漏れでクラスが効かない token の話', tags: '[]', source: 'import', secret: 0, meta: '{}', pinned: 0, redacted: 0, archived: 0 },
    ]);
    const { hits } = await recallObservations(store, testConfig(), { query: 'HuggingFace token を教えて', project: 'p', limit: 5 });
    assert.ok(hits.every((h) => !h.text.includes('hf_SHOULDNOTLEAK')), '機密が recall 候補に出ない');
  });
});

test('recall: 短いクエリ(LIKEフォールバック)でも scopes を尊重しクロスプロジェクト混入しない（M5 回帰）', async () => {
  await withFreshStoreAsync(async (store) => {
    store.addObservation({ text: 'projA の ab に関する観測', project: 'projA' });
    store.addObservation({ text: 'projB の ab に関する観測', project: 'projB' });
    store.addObservation({ text: 'global の ab 観測', project: null });
    // "ab" は2文字=trigram不可→LIKEフォールバック
    const { hits } = await recallObservations(store, testConfig(), { query: 'ab', scopes: ['global', 'projA'], limit: 10 });
    const projs = new Set(hits.map((h) => h.project));
    assert.ok(!projs.has('projB'), 'projB の観測が混入しない');
  });
});
