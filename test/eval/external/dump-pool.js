#!/usr/bin/env node
// 各クエリのプール候補(4経路の上位を集約)を JSON で出力する。
// 別ベンダ(Claude)の独立ジャッジに採点させ、qrels の循環バイアス(生成器=採点器)を断つため。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../../src/store.js';
import { loadConfig } from '../../../src/config.js';
import { recallObservations } from '../../../src/recall.js';
import { embedAvailable, embedTexts, cosine } from '../../../src/embed.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const POOL_K = 8;
const config = loadConfig();
const store = openStore(join(DIR, '.evalhome', 'ulm'));
const queries = readFileSync(join(DIR, 'queries.external.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const out = [];
for (const { qid, query } of queries) {
  const scopes = ['external'];
  const pool = new Map();
  const add = (arr) => arr.slice(0, POOL_K).forEach((o) => pool.set(o.id, o));
  add(store.listObservations({ project: 'external', limit: POOL_K }));
  add(store.searchObservations({ query, scopes, limit: POOL_K }));
  if (embedAvailable(config)) {
    const [qv] = await embedTexts([query], config);
    add(store.vectorSearch(Float32Array.from(qv), { scopes, limit: POOL_K, cosine }));
  }
  add((await recallObservations(store, config, { query, scopes, limit: POOL_K, candidateK: POOL_K })).hits);
  out.push({ qid, query, candidates: [...pool.values()].map((o) => ({ id: o.id, text: o.text })) });
}
store.close();
writeFileSync(join(DIR, 'pool.json'), JSON.stringify(out, null, 1));
console.log(`プール出力: ${out.length} クエリ、平均候補 ${(out.reduce((s, q) => s + q.candidates.length, 0) / out.length).toFixed(1)} 件`);
