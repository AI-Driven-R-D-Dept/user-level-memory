#!/usr/bin/env node
// 想起品質の評価ハーネス: BM25(FTS5) vs recency baseline を Recall@K / MRR で実測。
// recency baseline = listObservations の ts DESC（=従来の SessionStart 注入相当）。
// relevant 観測を古く・ノイズを新しく置くことで「最近だが無関係」「古いが関連」の罠を仕込む。
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../src/store.js';
import { ensureHome } from '../../src/config.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const CORPUS = JSON.parse(readFileSync(join(DIR, 'corpus.json'), 'utf8'));
const K = Number(process.argv[2] || 5);

function setup() {
  const home = join(mkdtempSync(join(tmpdir(), 'ulm-eval-')), 'ulm');
  ensureHome(home);
  const store = openStore(home);
  // days_ago を ts に反映するため、addObservation 後に ts を直接更新
  const idmap = {};
  for (const o of CORPUS.observations) {
    const obs = store.addObservation({ text: o.text, project: o.project, tags: o.tags || [], secret: !!o.secret, source: 'manual' });
    const ts = new Date(Date.now() - (o.days_ago || 0) * 86_400_000).toISOString();
    store.db.prepare('UPDATE observations SET ts = ? WHERE id = ?').run(ts, obs.id);
    idmap[o.id] = obs.id; // 論理id → 実id
  }
  return { home, store, idmap };
}

/** 検索結果(実id配列)に対する Recall@K と RR を計算 */
function metricsFor(resultIds, relevantRealIds, k) {
  const topk = resultIds.slice(0, k);
  const hit = relevantRealIds.some((r) => topk.includes(r));
  let rr = 0;
  for (let i = 0; i < resultIds.length; i++) {
    if (relevantRealIds.includes(resultIds[i])) { rr = 1 / (i + 1); break; }
  }
  // secret が結果に混入していないか
  return { recall: hit ? 1 : 0, rr };
}

export function run() {
  const { home, store, idmap } = setup();
  const ftsOn = store.hasFts();
  const secretRealIds = CORPUS.observations.filter((o) => o.secret).map((o) => idmap[o.id]);
  const agg = { bm25: { recall: 0, rr: 0, leak: 0 }, recency: { recall: 0, rr: 0, leak: 0 } };
  const perQuery = [];
  try {
    for (const { q, relevant } of CORPUS.queries) {
      const relReal = relevant.map((id) => idmap[id]);
      // BM25（project スコープは irodori+global 相当に広く: project 指定なし=全件から）
      const bm = store.searchObservations({ query: q, limit: 20 }).map((o) => o.id);
      // recency baseline: 最近順（query 無視）。従来の注入が見る集合に相当
      const rc = store.listObservations({ limit: 20 }).map((o) => o.id);
      const mb = metricsFor(bm, relReal, K);
      const mr = metricsFor(rc, relReal, K);
      // secret leak: 上位Kに secret が出たか
      mb.leak = bm.slice(0, K).some((id) => secretRealIds.includes(id)) ? 1 : 0;
      mr.leak = rc.slice(0, K).some((id) => secretRealIds.includes(id)) ? 1 : 0;
      agg.bm25.recall += mb.recall; agg.bm25.rr += mb.rr; agg.bm25.leak += mb.leak;
      agg.recency.recall += mr.recall; agg.recency.rr += mr.rr; agg.recency.leak += mr.leak;
      perQuery.push({ q, relevant, bm25: mb, recency: mr });
    }
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
  const n = CORPUS.queries.length;
  const out = {
    fts_enabled: ftsOn,
    n_queries: n,
    K,
    bm25: { recall_at_k: +(agg.bm25.recall / n).toFixed(3), mrr: +(agg.bm25.rr / n).toFixed(3), secret_leaks: agg.bm25.leak },
    recency: { recall_at_k: +(agg.recency.recall / n).toFixed(3), mrr: +(agg.recency.rr / n).toFixed(3), secret_leaks: agg.recency.leak },
    perQuery,
  };
  return out;
}

// 直接実行時のみレポートを出す（test から import した時は実行しない）
if (process.argv[1] && process.argv[1].endsWith('recall-eval.js')) {
  const r = run();
  console.log(`FTS=${r.fts_enabled}  n=${r.n_queries}  K=${r.K}`);
  console.log(`BM25    Recall@${r.K}=${r.bm25.recall_at_k}  MRR=${r.bm25.mrr}  secret_leaks=${r.bm25.secret_leaks}`);
  console.log(`recency Recall@${r.K}=${r.recency.recall_at_k}  MRR=${r.recency.mrr}  secret_leaks=${r.recency.secret_leaks}`);
  console.log('\nper-query (✓=top-K に関連obs):');
  for (const p of r.perQuery) {
    console.log(`  bm25:${p.bm25.recall ? '✓' : '✗'}(rr=${p.bm25.rr.toFixed(2)}) recency:${p.recency.recall ? '✓' : '✗'}  ${p.q.slice(0, 38)}`);
  }
  const fs = await import('node:fs');
  fs.writeFileSync(join(DIR, 'eval-result.json'), JSON.stringify(r, null, 2));
}
