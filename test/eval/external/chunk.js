#!/usr/bin/env node
// 実OSSドキュメント(raw/*.md)を観測候補にチャンク分割する（機械的・決定的）。
// 「条件付きの勘所/gotcha」になりうる実質的な段落だけを残す。作者は本文を書かない=出典追跡可能。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const RAW = join(DIR, 'raw');

function clean(s) {
  return s.replace(/\r/g, '').trim();
}
// 段落が「実質的な技術文」かの粗いフィルタ
function isSubstantive(p) {
  const t = p.trim();
  if (t.length < 90 || t.length > 600) return false;
  if (/[<>]/.test(t)) return false; // HTML タグ/ナビを含む段落は捨てる
  if (/^#{1,6}\s/.test(t)) return false; // 見出し
  if (/[•|]/.test(t)) return false; // ナビ・表区切り
  if (/^[-*>]/.test(t)) return false; // リスト/引用始まり
  if ((t.match(/`/g) || []).length > 8) return false; // コード塗れ
  if (/^\[?!?\[/.test(t)) return false; // バッジ/画像
  if ((t.match(/https?:\/\//g) || []).length >= 2) return false; // リンク集
  if (/^[A-Z][a-z]+ \d/.test(t) && t.length < 120) return false; // バージョン行など
  // 文らしさ: ピリオドを含む（散文）こと
  if (!/[.。]/.test(t)) return false;
  // 技術的な条件・挙動・注意を含みやすい語を要求
  const hasTechCue = /\b(if|when|because|note|default|option|flag|behavior|behaviour|instead|require|requires|must|will|unless|only|cannot|won't|warning|however|enable|disable|match|matches|pattern|config|cache|ignore|skip|escape|encoding|symlink|recursive)\b/i.test(t);
  return hasTechCue;
}

const records = [];
let auto = 0;
for (const f of readdirSync(RAW).filter((x) => x.endsWith('.md'))) {
  const text = clean(readFileSync(join(RAW, f), 'utf8'));
  const source = basename(f, '.md');
  // 段落分割（空行区切り）。コードフェンスは段落から除外。
  const noFence = text.replace(/```[\s\S]*?```/g, '\n\n');
  for (const para of noFence.split(/\n\s*\n/)) {
    const p = para.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (!isSubstantive(p)) continue;
    records.push({ id: `ext-${source}-${auto++}`, source, text: p });
  }
}
// 長さでばらけさせ、重複を粗く除去
const seen = new Set();
const uniq = records.filter((r) => {
  const k = r.text.slice(0, 60).toLowerCase();
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
writeFileSync(join(DIR, 'corpus.external.jsonl'), uniq.map((r) => JSON.stringify(r)).join('\n') + '\n');
const bySource = {};
for (const r of uniq) bySource[r.source] = (bySource[r.source] || 0) + 1;
console.log(`観測候補: ${uniq.length} 件`);
console.log('ソース別:', JSON.stringify(bySource));
