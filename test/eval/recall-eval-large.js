#!/usr/bin/env node
// 拡張・現実条件の想起評価: recency / FTS-only / hybrid(FTS+埋め込み) を
// カテゴリ別(exact/paraphrase/synonym/typo)に Recall@K と MRR で比較する。
// 2000件のノイズ(新しい)＋relevant(古い)で recency を意図的に不利化。secret 漏洩も検査。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../src/store.js';
import { ensureHome, loadConfig } from '../../src/config.js';
import { recallObservations } from '../../src/recall.js';
import { embedAvailable, embedTexts, embedConfig, vecToBuf } from '../../src/embed.js';
import { buildCorpus, buildQueries, RELEVANT, SECRET_OBS, SECRET_QUERIES } from './corpus-large.js';

const K = Number(process.argv[2] || 5);
const NOISE = Number(process.argv[3] || 2000);

async function setup(config) {
  const home = join(mkdtempSync(join(tmpdir(), 'ulm-evalL-')), 'ulm');
  ensureHome(home);
  const store = openStore(home);
  const idmap = {};
  const upd = store.db.prepare('UPDATE observations SET ts = ? WHERE id = ?');
  for (const o of buildCorpus({ noise: NOISE })) {
    const obs = store.addObservation({ text: o.text, project: o.project, tags: o.tags || [], secret: !!o.secret, source: 'manual' });
    upd.run(new Date(Date.now() - (o.days_ago || 0) * 86_400_000).toISOString(), obs.id);
    idmap[o.id] = obs.id;
  }
  // 埋め込み（非 secret 全件）
  let embedded = 0;
  if (embedAvailable(config)) {
    const model = embedConfig(config).model;
    let pending = store.observationsNeedingEmbedding({ limit: 100000 });
    const vecs = await embedTexts(pending.map((p) => p.text), config);
    for (let i = 0; i < pending.length; i++) store.upsertEmbedding(pending[i].id, model, vecToBuf(vecs[i]));
    embedded = pending.length;
  }
  return { home, store, idmap, embedded };
}

function recencyRetrieve(store, project, limit) {
  const proj = store.listObservations({ project, limit });
  const glob = store.listObservations({ global: true, limit });
  return [...proj, ...glob].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit).map((o) => o.id);
}

function metrics(ids, relReal, k) {
  const topk = ids.slice(0, k);
  const recall = relReal.some((r) => topk.includes(r)) ? 1 : 0;
  let rr = 0;
  for (let i = 0; i < ids.length; i++) if (relReal.includes(ids[i])) { rr = 1 / (i + 1); break; }
  return { recall, rr };
}

async function run() {
  const config = loadConfig();
  const { home, store, idmap, embedded } = await setup(config);
  const secretReal = SECRET_OBS.map((s) => idmap[s.id]);
  const cats = ['exact', 'paraphrase', 'synonym', 'typo'];
  const acc = {};
  for (const r of ['recency', 'fts', 'hybrid']) { acc[r] = {}; for (const c of cats) acc[r][c] = { recall: 0, rr: 0, n: 0 }; }
  let secretLeak = { recency: 0, fts: 0, hybrid: 0 };

  try {
    for (const { q, relevant, category, project } of buildQueries()) {
      const relReal = relevant.map((id) => idmap[id]);
      const scopes = ['global', project];
      const rec = recencyRetrieve(store, project, 50);
      const fts = store.searchObservations({ query: q, scopes, limit: 50 }).map((o) => o.id);
      const hyb = (await recallObservations(store, config, { query: q, scopes, limit: 50, candidateK: 50 })).hits.map((o) => o.id);
      const mr = metrics(rec, relReal, K), mf = metrics(fts, relReal, K), mh = metrics(hyb, relReal, K);
      acc.recency[category].recall += mr.recall; acc.recency[category].rr += mr.rr; acc.recency[category].n++;
      acc.fts[category].recall += mf.recall; acc.fts[category].rr += mf.rr; acc.fts[category].n++;
      acc.hybrid[category].recall += mh.recall; acc.hybrid[category].rr += mh.rr; acc.hybrid[category].n++;
    }
    // secret 漏洩: secret 狙いクエリで top-K に secret が出るか
    for (const sq of SECRET_QUERIES) {
      const scopes = ['global', 'irodori'];
      if (store.searchObservations({ query: sq, scopes, limit: K }).some((o) => secretReal.includes(o.id))) secretLeak.fts++;
      if ((await recallObservations(store, config, { query: sq, scopes, limit: K })).hits.some((o) => secretReal.includes(o.id))) secretLeak.hybrid++;
    }
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }

  function overall(r) {
    let recall = 0, rr = 0, n = 0;
    for (const c of cats) { recall += acc[r][c].recall; rr += acc[r][c].rr; n += acc[r][c].n; }
    return { recall: recall / n, mrr: rr / n, n };
  }
  return { K, noise: NOISE, embedded, cats, acc, overall: { recency: overall('recency'), fts: overall('fts'), hybrid: overall('hybrid') }, secretLeak };
}

const r = await run();
const pct = (x) => (x * 100).toFixed(0) + '%';
const f = (x) => x.toFixed(3);
console.log(`拡張評価: K=${r.K} ノイズ=${r.noise}件 埋め込み=${r.embedded}件\n`);
console.log('全体 Recall@' + r.K + ' / MRR:');
console.log(`  recency : Recall=${pct(r.overall.recency.recall)}  MRR=${f(r.overall.recency.mrr)}`);
console.log(`  FTSのみ : Recall=${pct(r.overall.fts.recall)}  MRR=${f(r.overall.fts.mrr)}`);
console.log(`  hybrid  : Recall=${pct(r.overall.hybrid.recall)}  MRR=${f(r.overall.hybrid.mrr)}`);
console.log('\nカテゴリ別 Recall@' + r.K + ' (recency / FTS / hybrid):');
for (const c of r.cats) {
  const g = (rt) => pct(r.acc[rt][c].recall / r.acc[rt][c].n);
  console.log(`  ${c.padEnd(11)}: ${g('recency').padStart(4)} / ${g('fts').padStart(4)} / ${g('hybrid').padStart(4)}`);
}
console.log(`\nsecret 漏洩(top-${r.K}): FTS=${r.secretLeak.fts} hybrid=${r.secretLeak.hybrid}（0 が正）`);
const fs = await import('node:fs');
fs.writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'eval-large-result.json'), JSON.stringify(r, null, 2));
