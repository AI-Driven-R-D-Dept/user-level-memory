#!/usr/bin/env node
// プロダクションA/Bハーネス:
// 同一モデル(codex gpt-5.5,low)・irodoriを読めない隔離CWD・4タスク×2アーム×N試行。
// A=記憶なし / B=記憶あり(ulm注入ブロックを前置)。回答は answers/ に保存。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const ISO = readFileSync(join(DIR, 'iso_cwd.txt'), 'utf8').trim();
const MEM = readFileSync(join(DIR, 'memory-block.txt'), 'utf8').trim();
const TASKS = JSON.parse(readFileSync(join(DIR, 'tasks.json'), 'utf8'));
const TRIALS = Number(process.argv[2] || 3);

function codex(prompt) {
  const r = spawnSync('codex', [
    'exec', '--skip-git-repo-check', '-s', 'read-only', '--color', 'never',
    '--ephemeral', '-C', ISO, '-m', 'gpt-5.5', '-c', 'model_reasoning_effort="low"', '-',
  ], { input: prompt, encoding: 'utf8', timeout: 180000, stdio: ['pipe', 'pipe', 'ignore'] });
  // codex exec は stdout に最終回答を含む。最後の非空ブロックを取る。
  const out = (r.stdout || '').trim();
  // codex の進捗行を除き、最後のまとまった回答を抽出（"tokens used" より前の最終応答）
  const parts = out.split(/\n(?=codex\n|tokens used)/);
  let ans = out;
  // 最も単純に: 末尾から "tokens used" 以降を除去し、最後の codex 応答ブロックを採用
  const ti = out.lastIndexOf('tokens used');
  let body = ti >= 0 ? out.slice(0, ti) : out;
  // 最後の "codex" マーカー以降を回答とみなす
  const ci = body.lastIndexOf('\ncodex\n');
  ans = (ci >= 0 ? body.slice(ci + 7) : body).trim();
  return ans;
}

const NOMEM_PREFIX =
  'あなたは Irodori-TTS（オープンソースのTTS）の開発者アシスタントです。' +
  'ファイルやリポジトリは一切読まず、ツールも使わず、あなたの一般知識だけで簡潔に答えてください。\n\n質問: ';
const MEM_PREFIX =
  'あなたは Irodori-TTS の開発者アシスタントです。セッション開始時に以下のユーザーレベル長期記憶が自動注入されています:\n\n' +
  MEM +
  '\n\nファイルやリポジトリは一切読まず、ツールも使わず、上記の注入記憶とあなたの知識だけで簡潔に答えてください。\n\n質問: ';

const records = [];
for (const t of TASKS) {
  for (let trial = 1; trial <= TRIALS; trial++) {
    for (const arm of ['A', 'B']) {
      const prompt = (arm === 'A' ? NOMEM_PREFIX : MEM_PREFIX) + t.q;
      process.stderr.write(`run ${t.id} arm=${arm} trial=${trial}...\n`);
      const answer = codex(prompt);
      const fn = `answers/${t.id}_${arm}_${trial}.txt`;
      writeFileSync(join(DIR, fn), answer);
      records.push({ task: t.id, arm, trial, file: fn, answer });
    }
  }
}
writeFileSync(join(DIR, 'raw-records.json'), JSON.stringify(records, null, 2));
process.stderr.write(`\n完了: ${records.length} 回答を収集\n`);
