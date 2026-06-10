#!/usr/bin/env node
// 外部評価ハーネス(STEP1): 作者がgameできない qrels に対し recency/fts/vector/hybrid を
// Recall@K / Precision@K / MRR / nDCG@K で比較。クエリ bootstrap で 95% 信頼区間も出す。
// 本番コード(recallObservations/searchObservations/vectorSearch)をそのまま通す。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../../src/store.js';
import { loadConfig } from '../../../src/config.js';
import { recallObservations } from '../../../src/recall.js';
import { embedAvailable, embedTexts, cosine } from '../../../src/embed.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const K = Number(process.argv[2] || 10);
const EVAL_HOME = join(DIR, '.evalhome', 'ulm');
const config = loadConfig();

const QFILE = process.env.QUERIES_FILE || 'queries.external.jsonl';
const queries = readFileSync(join(DIR, QFILE), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// qrels は環境変数 ULM_QRELS で差し替え可（別ベンダ採点 qrels-claude.json で循環バイアスを検証）
const qrelsFile = process.env.ULM_QRELS || 'qrels.external.json';
const qrels = JSON.parse(readFileSync(join(DIR, qrelsFile), 'utf8'));
const idmap = JSON.parse(readFileSync(join(DIR, 'idmap.json'), 'utf8'));

function dcg(grades) { return grades.reduce((s, g, i) => s + (Math.pow(2, g) - 1) / Math.log2(i + 2), 0); }
function metricsFor(rankedIds, rel, k) {
  const top = rankedIds.slice(0, k);
  const relIds = Object.keys(rel);
  const nRel = relIds.length;
  if (!nRel) return null; // relevant が無いクエリは評価対象外
  const hitCount = top.filter((id) => rel[id] >= 1).length;
  // success@K: top-K に関連が1件でもあれば1（メモリ注入で「役立つ記憶が1件出れば成功」の運用指標）
  const success = top.some((id) => rel[id] >= 1) ? 1 : 0;
  // 真の recall@K: 取得した関連数 / 全関連数（古典的定義）
  const recall = hitCount / nRel;
  const precision = hitCount / k;
  let rr = 0;
  for (let i = 0; i < rankedIds.length; i++) if (rel[rankedIds[i]] >= 1) { rr = 1 / (i + 1); break; }
  const gains = top.map((id) => rel[id] || 0);
  const ideal = Object.values(rel).sort((a, b) => b - a).slice(0, k);
  const ndcg = dcg(ideal) ? dcg(gains) / dcg(ideal) : 0;
  return { success, recall, precision, rr, ndcg };
}

function recencyIds(store, limit) {
  return store.listObservations({ project: 'external', limit }).map((o) => o.id);
}

function bootstrapCI(values, iters = 2000) {
  if (!values.length) return { mean: 0, lo: 0, hi: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  // 決定的 bootstrap（seed 固定の線形合同法。Math.random は使わない）
  let s = 12345;
  const rnd = () => ((s = (1103515245 * s + 12345) & 0x7fffffff) / 0x7fffffff);
  const means = [];
  for (let it = 0; it < iters; it++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(rnd() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return { mean, lo: means[Math.floor(iters * 0.025)], hi: means[Math.floor(iters * 0.975)] };
}

async function main() {
  if (!existsSync(join(EVAL_HOME, 'memory.db'))) { console.error('先に build-qrels.js を実行（.evalhome が必要）'); process.exit(1); }
  const store = openStore(EVAL_HOME);
  const routes = ['recency', 'fts', 'vector', 'hybrid'];
  const per = Object.fromEntries(routes.map((r) => [r, { success: [], recall: [], precision: [], rr: [], ndcg: [] }]));
  let evaluated = 0;
  const hasEmbed = embedAvailable(config) && store.embeddingCount() > 0;
  for (const { qid, query } of queries) {
    const rel = qrels[qid] || {};
    if (!Object.keys(rel).length) continue;
    evaluated++;
    const scopes = ['external'];
    const got = {
      recency: recencyIds(store, 50),
      fts: store.searchObservations({ query, scopes, limit: 50 }).map((o) => o.id),
      vector: [],
      hybrid: (await recallObservations(store, config, { query, scopes, limit: 50, candidateK: 50 })).hits.map((o) => o.id),
    };
    if (hasEmbed) {
      const [qv] = await embedTexts([query], config);
      got.vector = store.vectorSearch(Float32Array.from(qv), { scopes, limit: 50, cosine }).map((o) => o.id);
    }
    for (const r of routes) {
      const m = metricsFor(got[r], rel, K);
      if (m) for (const key of ['success', 'recall', 'precision', 'rr', 'ndcg']) per[r][key].push(m[key]);
    }
  }
  store.close();
  const summary = { K, evaluated, embed: hasEmbed, routes: {} };
  for (const r of routes) {
    summary.routes[r] = {
      success_at_k: bootstrapCI(per[r].success),
      recall_at_k: bootstrapCI(per[r].recall),
      precision_at_k: bootstrapCI(per[r].precision),
      mrr: bootstrapCI(per[r].rr),
      ndcg_at_k: bootstrapCI(per[r].ndcg),
    };
  }
  writeFileSync(join(DIR, 'eval-external-result.json'), JSON.stringify(summary, null, 2));
  const f = (c) => `${(c.mean * 100).toFixed(0)}% [${(c.lo * 100).toFixed(0)}-${(c.hi * 100).toFixed(0)}]`;
  console.log(`外部評価: K=${K} 評価クエリ=${evaluated} 埋め込み=${hasEmbed}\n`);
  // Success@K = top-K に関連が1件でも出れば成功（運用指標）。Recall@K = 古典的定義（取得関連数/全関連数）。
  console.log('route     Success@K          Recall@K           nDCG@K             MRR');
  for (const r of routes) {
    const s = summary.routes[r];
    console.log(`${r.padEnd(8)}  ${f(s.success_at_k).padEnd(18)} ${f(s.recall_at_k).padEnd(18)} ${f(s.ndcg_at_k).padEnd(18)} ${f(s.mrr)}`);
  }
}
main();
