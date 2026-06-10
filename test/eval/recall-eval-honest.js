#!/usr/bin/env node
// 正直な4-way 評価: recency / FTS / vector / hybrid を、現実寄りコーパス(混在recency・cross・重タイポ)で比較。
// eval-integrity 監査の指摘に応え、FTS の寄与とタイポ耐性、recency の非strawman 性を晒す。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../src/store.js';
import { ensureHome, loadConfig } from '../../src/config.js';
import { recallObservations } from '../../src/recall.js';
import { embedAvailable, embedTexts, embedConfig, vecToBuf, cosine } from '../../src/embed.js';
import { buildHonestCorpus, buildHonestQueries, ITEMS } from './corpus-honest.js';

const K = Number(process.argv[2] || 5);
const NOISE = Number(process.argv[3] || 1500);

async function setup(config) {
  const home = join(mkdtempSync(join(tmpdir(), 'ulm-honest-')), 'ulm');
  ensureHome(home);
  const store = openStore(home);
  const idmap = {};
  const upd = store.db.prepare('UPDATE observations SET ts = ? WHERE id = ?');
  for (const o of buildHonestCorpus({ noise: NOISE })) {
    const ob = store.addObservation({ text: o.text, project: o.project, tags: [], secret: !!o.secret, source: 'manual' });
    upd.run(new Date(Date.now() - (o.days_ago || 0) * 86_400_000).toISOString(), ob.id);
    idmap[o.id] = ob.id;
  }
  let embedded = 0;
  if (embedAvailable(config)) {
    const pend = store.observationsNeedingEmbedding({ limit: 100000 });
    const vecs = await embedTexts(pend.map((p) => p.text), config);
    for (let i = 0; i < pend.length; i++) store.upsertEmbedding(pend[i].id, embedConfig(config).model, vecToBuf(vecs[i]));
    embedded = pend.length;
  }
  return { home, store, idmap, embedded };
}

function recencyIds(store, project, limit) {
  return [...store.listObservations({ project, limit }), ...store.listObservations({ global: true, limit })]
    .sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit).map((o) => o.id);
}
function hit(ids, rel, k) { return rel.some((r) => ids.slice(0, k).includes(r)) ? 1 : 0; }

async function run() {
  const config = loadConfig();
  const { home, store, idmap, embedded } = await setup(config);
  const cats = ['exact', 'synonym', 'typo', 'cross'];
  const freshById = Object.fromEntries(ITEMS.map((i) => [i.id, i.fresh]));
  const acc = {}; for (const r of ['recency', 'fts', 'vector', 'hybrid']) { acc[r] = {}; for (const c of cats) acc[r][c] = { h: 0, n: 0 }; }
  const recencyByAge = { fresh: { h: 0, n: 0 }, old: { h: 0, n: 0 } };
  let ftsUniqueRescue = 0, vecUniqueRescue = 0;
  try {
    for (const { q, relevant, category, project } of buildHonestQueries()) {
      const rel = relevant.map((id) => idmap[id]);
      const scopes = ['global', project];
      const rec = recencyIds(store, project, 50);
      const fts = store.searchObservations({ query: q, scopes, limit: 50 }).map((o) => o.id);
      let vec = [];
      if (embedAvailable(config)) {
        const [qv] = await embedTexts([q], config);
        vec = store.vectorSearch(Float32Array.from(qv), { scopes, limit: 50, cosine }).map((o) => o.id);
      }
      const hyb = (await recallObservations(store, config, { query: q, scopes, limit: 50, candidateK: 50 })).hits.map((o) => o.id);
      acc.recency[category].h += hit(rec, rel, K); acc.recency[category].n++;
      acc.fts[category].h += hit(fts, rel, K); acc.fts[category].n++;
      acc.vector[category].h += hit(vec, rel, K); acc.vector[category].n++;
      acc.hybrid[category].h += hit(hyb, rel, K); acc.hybrid[category].n++;
      // recency を age 別に（strawman でないことの確認）
      const age = freshById[relevant[0]] ? 'fresh' : 'old';
      recencyByAge[age].h += hit(rec, rel, K); recencyByAge[age].n++;
      // FTS/vector のユニーク救済（K=5 で片方だけが当てた数）
      const fH = hit(fts, rel, K), vH = hit(vec, rel, K);
      if (fH && !vH) ftsUniqueRescue++;
      if (vH && !fH) vecUniqueRescue++;
    }
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
  const overall = (r) => { let h = 0, n = 0; for (const c of cats) { h += acc[r][c].h; n += acc[r][c].n; } return n ? h / n : 0; };
  return { K, NOISE, embedded, cats, acc, overall: Object.fromEntries(['recency', 'fts', 'vector', 'hybrid'].map((r) => [r, overall(r)])), recencyByAge, ftsUniqueRescue, vecUniqueRescue };
}

const r = await run();
const pct = (x) => Math.round(x * 100) + '%';
console.log(`正直な4-way 評価: K=${r.K} ノイズ=${r.NOISE} 埋め込み=${r.embedded}\n`);
console.log('全体 Recall@' + r.K + ':');
for (const rt of ['recency', 'fts', 'vector', 'hybrid']) console.log(`  ${rt.padEnd(8)}: ${pct(r.overall[rt])}`);
console.log('\nカテゴリ別 (recency/fts/vector/hybrid):');
for (const c of r.cats) console.log(`  ${c.padEnd(8)}: ${pct(r.acc.recency[c].h / r.acc.recency[c].n)} / ${pct(r.acc.fts[c].h / r.acc.fts[c].n)} / ${pct(r.acc.vector[c].h / r.acc.vector[c].n)} / ${pct(r.acc.hybrid[c].h / r.acc.hybrid[c].n)}`);
console.log(`\nrecency の内訳（strawman 検証）: 最近-relevant=${pct(r.recencyByAge.fresh.h / r.recencyByAge.fresh.n)} 古い-relevant=${pct(r.recencyByAge.old.h / r.recencyByAge.old.n)}`);
console.log(`FTS ユニーク救済(K=${r.K})=${r.ftsUniqueRescue}件  vector ユニーク救済=${r.vecUniqueRescue}件`);
const fs = await import('node:fs');
fs.writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'eval-honest-result.json'), JSON.stringify(r, null, 2));
