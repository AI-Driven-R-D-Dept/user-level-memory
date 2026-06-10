#!/usr/bin/env node
// 独立クエリ生成: 各観測(実OSS doc段落)から「それを必要とする開発者の症状ベースの質問」を
// 別LLM(codex/openai)に生成させる。観測の固有語彙をコピーさせない＝字句重複で当たるのを防ぐ。
// 作者は本文もクエリも書かない。出力は snapshot して再現可能にする。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callProvider, resolveProvider } from '../../../src/miner.js';
import { loadConfig } from '../../../src/config.js';
import { extractJsonArray } from '../../../src/miner.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] || 40);
const config = loadConfig();
// バッチ生成は速い openai を優先（キーがあれば）。なければ codex。
const prov = process.env[config.miner.api_key_env || 'OPENAI_API_KEY'] ? 'openai' : resolveProvider(config);

const obs = readFileSync(join(DIR, 'corpus.external.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// 「条件付きの勘所」らしさが強い観測を優先選別（when/if/note/must/only 等を含む）
const score = (t) => (t.match(/\b(if|when|because|note|default|must|only|unless|cannot|won't|instead|require|warning|behaviou?r|otherwise|by default)\b/gi) || []).length;
const ranked = [...obs].sort((a, b) => score(b.text) - score(a.text));
// ソースが偏らないよう、上位からソース分散させて N 件選ぶ
const picked = [];
const perSource = {};
for (const o of ranked) {
  perSource[o.source] = perSource[o.source] || 0;
  if (perSource[o.source] >= Math.ceil(N / 4)) continue; // 1ソース上限
  picked.push(o);
  perSource[o.source]++;
  if (picked.length >= N) break;
}

const SYS = `あなたは、ある技術ドキュメントの一節を読んで「その知識を必要とする現実の開発者が投げる質問」を作る出題者です。
鉄則:
- 質問は「症状・困りごと・やりたいこと」を、開発者自身の言葉で書く。ドキュメント原文の固有の語彙・オプション名・コマンド名・専門用語を**使い回さない**（言い換える/一般的な症状で表現する）。
- その一節を読めば答えられるが、語彙が一致しないと検索で当たらない、くらいの距離感にする。
- 1〜2文。日本語。質問だけを書く（前置き・引用符なし）。`;

const out = [];
for (let i = 0; i < picked.length; i++) {
  const o = picked[i];
  process.stderr.write(`gen ${i + 1}/${picked.length} (${o.source})...\n`);
  const prompt = { system: SYS, user: `ドキュメントの一節:\n"""\n${o.text}\n"""\n\nこの知識を必要とする開発者の質問を1つ:` };
  try {
    const resp = await callProvider(prov, prompt, config, process.cwd());
    const q = resp.replace(/^["'\s]+|["'\s]+$/g, '').replace(/\n/g, ' ').trim().slice(0, 200);
    if (q.length >= 8) out.push({ qid: `q${i}`, query: q, expects_id: o.id, source: o.source });
  } catch (e) {
    process.stderr.write(`  skip: ${e.message}\n`);
  }
}
writeFileSync(join(DIR, 'queries.external.jsonl'), out.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`生成クエリ: ${out.length} 件 (provider=${prov})`);
