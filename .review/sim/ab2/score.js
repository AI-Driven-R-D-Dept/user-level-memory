#!/usr/bin/env node
// 採点: (1)客観=リポ固有キーターム命中率＋ヘッジ検出, (2)盲検LLMジャッジ(codex,アーム秘匿)。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const ISO = readFileSync(join(DIR, 'iso_cwd.txt'), 'utf8').trim();
const TASKS = Object.fromEntries(JSON.parse(readFileSync(join(DIR, 'tasks.json'), 'utf8')).map((t) => [t.id, t]));
const records = JSON.parse(readFileSync(join(DIR, 'raw-records.json'), 'utf8'));

const HEDGE = /可能性が高い|可能性があります|かもしれません|確認してください|確認するの|一般的に|一般に|見直して|だと思われ|でしょう|別モデル|別の.*モデル|API があるか/;

// (1) 客観指標
for (const r of records) {
  const t = TASKS[r.task];
  const a = r.answer || '';
  const hits = t.key_terms.filter((k) => a.toLowerCase().includes(k.toLowerCase()));
  r.keyterm_hits = hits.length;
  r.keyterm_total = t.key_terms.length;
  r.keyterm_ratio = hits.length / t.key_terms.length;
  r.hedge = HEDGE.test(a);
}

// (2) 盲検LLMジャッジ用に匿名化＆シャッフル
const blind = records.map((r, i) => ({ idx: i, task: r.task, q: TASKS[r.task].q, truth: TASKS[r.task].truth, answer: r.answer }));
// 決定的シャッフル（再現性のため固定シード的に index 並べ替え）
blind.sort((x, y) => (`${x.answer}`.length % 7) - (`${y.answer}`.length % 7) || x.idx - y.idx);

function judge(item) {
  const prompt =
    `あなたは Irodori-TTS の厳格な技術採点者です。以下の「質問」に対する「回答」を、提示した「正解の要点」に照らして採点してください。\n` +
    `回答が正解の核心（リポジトリ固有の原因と正しい対処）を具体的に述べていれば高得点、曖昧なヘッジや誤った方向（別モデルを探す等）なら低得点です。\n\n` +
    `質問: ${item.q}\n\n正解の要点: ${item.truth}\n\n回答: ${item.answer}\n\n` +
    `次のJSONのみを出力（説明文なし）: {"identifies_root_cause": 0|1|2, "correct_fix": 0|1|2, "misleading": 0|1, "verdict": "correct"|"partial"|"wrong"}\n` +
    `identifies_root_cause: 正解のリポ固有原因を特定=2 / 部分的=1 / 触れず=0。correct_fix: 正しい対処を具体提示=2 / 部分=1 / 無/誤=0。misleading: 誤誘導や別モデル推奨があれば1。`;
  const r = spawnSync('codex', [
    'exec', '--skip-git-repo-check', '-s', 'read-only', '--color', 'never', '--ephemeral',
    '-C', ISO, '-m', 'gpt-5.5', '-c', 'model_reasoning_effort="low"', '-',
  ], { input: prompt, encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'ignore'] });
  const out = (r.stdout || '').trim();
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return { identifies_root_cause: 0, correct_fix: 0, misleading: 1, verdict: 'wrong', parse_error: true };
  try { return JSON.parse(m[0]); } catch { return { identifies_root_cause: 0, correct_fix: 0, misleading: 1, verdict: 'wrong', parse_error: true }; }
}

for (const item of blind) {
  process.stderr.write(`judge idx=${item.idx} (${item.task})...\n`);
  const v = judge(item);
  records[item.idx].judge = v;
  records[item.idx].judge_score = (v.identifies_root_cause || 0) + (v.correct_fix || 0) - (v.misleading || 0); // -1..4
}

writeFileSync(join(DIR, 'scored-records.json'), JSON.stringify(records, null, 2));

// 集計
function agg(arm) {
  const rs = records.filter((r) => r.arm === arm);
  const n = rs.length;
  const kt = rs.reduce((s, r) => s + r.keyterm_ratio, 0) / n;
  const hedge = rs.filter((r) => r.hedge).length / n;
  const js = rs.reduce((s, r) => s + (r.judge_score || 0), 0) / n;
  const correct = rs.filter((r) => r.judge?.verdict === 'correct').length / n;
  const mislead = rs.filter((r) => r.judge?.misleading).length / n;
  return { arm, n, keyterm_ratio: kt, hedge_rate: hedge, judge_score_mean: js, correct_rate: correct, misleading_rate: mislead };
}
const summary = { A_no_memory: agg('A'), B_with_memory: agg('B'), tasks: Object.keys(TASKS).length, trials_per_cell: records.length / (Object.keys(TASKS).length * 2) };
writeFileSync(join(DIR, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
