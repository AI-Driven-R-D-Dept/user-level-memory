#!/usr/bin/env node
// qrels(正解集合)を TREC スタイルのプーリングで構築する。
// 各クエリで recency/fts/vector/hybrid の上位を pool → 独立ジャッジLLM(生成器と別役割)が
// (query, doc) の関連度を 0/1/2 で採点。作者は採点しない。embeddings は .evalhome に snapshot。
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../../src/store.js';
import { ensureHome, loadConfig } from '../../../src/config.js';
import { recallObservations } from '../../../src/recall.js';
import { embedAvailable, embedTexts, embedConfig, vecToBuf, cosine } from '../../../src/embed.js';
import { callProvider, extractJsonArray } from '../../../src/miner.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const POOL_K = 8;
const config = loadConfig();
const prov = process.env[config.miner.api_key_env || 'OPENAI_API_KEY'] ? 'openai' : 'codex';

const corpus = readFileSync(join(DIR, 'corpus.external.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// クエリファイルと出力先は env で差し替え可（Claude 生成クエリの独立評価に使う）
const QFILE = process.env.QUERIES_FILE || 'queries.external.jsonl';
const QOUT = process.env.QRELS_OUT || 'qrels.external.json';
const queries = readFileSync(join(DIR, QFILE), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// 永続 eval home（embeddings を snapshot 再利用するため）
const EVAL_HOME = join(DIR, '.evalhome', 'ulm');
export function setupEvalHome() {
  if (existsSync(join(DIR, '.evalhome'))) rmSync(join(DIR, '.evalhome'), { recursive: true, force: true });
  ensureHome(EVAL_HOME);
  const store = openStore(EVAL_HOME);
  const idmap = {};
  for (const o of corpus) {
    // 決定的 ID（ext-* をそのまま store id に）で .evalhome を再現可能にし、
    // クロスベンダ qrels(別ビルド)が同じ ID 系列で再実行できるようにする。
    const ob = store.addObservation({ text: o.text, project: 'external', tags: [o.source], source: 'manual', id: o.id });
    idmap[o.id] = ob.id;
  }
  writeFileSync(join(DIR, 'idmap.json'), JSON.stringify(idmap));
  return { store, idmap };
}

async function embedCorpus(store, config) {
  if (!embedAvailable(config)) return 0;
  const pend = store.observationsNeedingEmbedding({ limit: 100000 });
  const vecs = await embedTexts(pend.map((p) => p.text), config);
  for (let i = 0; i < pend.length; i++) store.upsertEmbedding(pend[i].id, embedConfig(config).model, vecToBuf(vecs[i]));
  return pend.length;
}

const JUDGE_SYS = `あなたは情報検索の厳格な関連度評価者です。開発者の質問と、検索で見つかった候補テキストの関連度を採点します。
各候補を 0/1/2 で:
 2 = この候補は質問に直接答える（必要な情報そのもの）
 1 = 関連はするが部分的/間接的
 0 = 無関係
出力は JSON 配列のみ: [{"i":0,"grade":2},{"i":1,"grade":0},...]（説明文なし）。候補の出所や順位は考慮せず、内容だけで判定。`;

async function judge(query, docs) {
  const list = docs.map((d, i) => `[${i}] ${d.text}`).join('\n');
  const prompt = { system: JUDGE_SYS, user: `質問: ${query}\n\n候補:\n${list}\n\n各候補の関連度をJSON配列で:` };
  const resp = await callProvider(prov, prompt, config, process.cwd());
  const arr = extractJsonArray(resp);
  const grades = {};
  for (const x of arr) if (typeof x?.i === 'number' && x.i < docs.length) grades[docs[x.i].id] = Number(x.grade) || 0;
  return grades;
}

async function main() {
  const { store, idmap } = setupEvalHome();
  const embedded = await embedCorpus(store, config);
  process.stderr.write(`corpus=${corpus.length} embedded=${embedded} prov=${prov}\n`);
  const qrels = {};
  for (let qi = 0; qi < queries.length; qi++) {
    const { qid, query, expects_id } = queries[qi];
    process.stderr.write(`qrels ${qi + 1}/${queries.length}...\n`);
    // プール: 4経路の上位を集める
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
    // expects_id（生成元）も必ずプールに入れる（取り逃しの判定漏れ防止）
    const expReal = idmap[expects_id];
    if (expReal && !pool.has(expReal)) { const o = store.getObservation(expReal); if (o) pool.set(o.id, o); }
    const docs = [...pool.values()];
    let grades = {};
    try { grades = await judge(query, docs); } catch (e) { process.stderr.write(`  judge err: ${e.message}\n`); }
    qrels[qid] = Object.fromEntries(Object.entries(grades).filter(([, g]) => g >= 1));
  }
  store.close();
  writeFileSync(join(DIR, QOUT), JSON.stringify(qrels, null, 1));
  const withRel = Object.values(qrels).filter((m) => Object.keys(m).length).length;
  console.log(`qrels 構築完了: ${queries.length} クエリ中 ${withRel} 件に relevant あり`);
}
main();
