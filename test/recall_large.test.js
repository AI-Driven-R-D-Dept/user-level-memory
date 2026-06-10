import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { ensureHome } from '../src/config.js';
import { buildCorpus, buildQueries } from './eval/corpus-large.js';

// 現実条件（ノイズ多数・relevant は古い）の回帰: FTS が recency を圧倒し、
// カテゴリ別に「字句一致が効く/効かない」境界が想定どおりであることを固定する。
// 埋め込み(hybrid)は API キーが要るのでここでは検証せず、recall-eval-large.js に委ねる。

function setup(noise) {
  const home = join(mkdtempSync(join(tmpdir(), 'ulm-rl-')), 'ulm');
  ensureHome(home);
  const store = openStore(home);
  const idmap = {};
  const upd = store.db.prepare('UPDATE observations SET ts = ? WHERE id = ?');
  for (const o of buildCorpus({ noise })) {
    const obs = store.addObservation({ text: o.text, project: o.project, tags: [], secret: !!o.secret, source: 'manual' });
    upd.run(new Date(Date.now() - (o.days_ago || 0) * 86_400_000).toISOString(), obs.id);
    idmap[o.id] = obs.id;
  }
  return { home, store, idmap };
}

test('recall(現実条件): FTS は recency を圧倒し exact/typo を確実に拾う', () => {
  const { home, store, idmap } = setup(200);
  try {
    const byCat = {};
    for (const { q, relevant, category, project } of buildQueries()) {
      const rel = relevant.map((id) => idmap[id]);
      const scopes = ['global', project];
      const fts = store.searchObservations({ query: q, scopes, limit: 5 }).map((o) => o.id);
      const recency = [...store.listObservations({ project, limit: 5 }), ...store.listObservations({ global: true, limit: 5 })]
        .sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 5).map((o) => o.id);
      byCat[category] ??= { ftsHit: 0, recHit: 0, n: 0 };
      byCat[category].ftsHit += rel.some((r) => fts.includes(r)) ? 1 : 0;
      byCat[category].recHit += rel.some((r) => recency.includes(r)) ? 1 : 0;
      byCat[category].n++;
    }
    // recency は新しいノイズに埋もれて relevant をほぼ拾えない
    const recAll = Object.values(byCat).reduce((s, c) => s + c.recHit, 0);
    assert.ok(recAll <= 1, `recency はほぼ 0 ヒット（実測 ${recAll}）`);
    // FTS は exact/typo を確実に
    assert.equal(byCat.exact.ftsHit, byCat.exact.n, 'exact は FTS で全ヒット');
    assert.equal(byCat.typo.ftsHit, byCat.typo.n, 'typo も trigram で全ヒット');
    // FTS 全体は十分高い（synonym で落ちるが exact/typo/paraphrase で稼ぐ）
    const ftsAll = Object.values(byCat).reduce((s, c) => s + c.ftsHit, 0);
    const total = Object.values(byCat).reduce((s, c) => s + c.n, 0);
    assert.ok(ftsAll / total >= 0.6, `FTS 全体 Recall@5 >= 0.6（実測 ${(ftsAll / total).toFixed(2)}）`);
    // 既知の天井: synonym は字句一致では半分も拾えない（hybrid が必要なことの根拠）
    assert.ok(byCat.synonym.ftsHit / byCat.synonym.n <= 0.5, '字句一致だけでは synonym は弱い（埋め込みが要る）');
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
