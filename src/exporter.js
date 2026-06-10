// JSONL エクスポート（控え）。差分を git で追えるよう安定した順序で出力する。
// 既定の出力先は ULM_HOME/export（= ~/.claude 配下でリポジトリ外）。
// secret は別ファイルに分離 + gitignore 自動生成 + 残存機密スキャンで二重に守る。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from './util.js';
import { compileGate } from './gate.js';

function toJsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

export function exportAll(store, home, config) {
  const dir = join(home, 'export');
  mkdirSync(dir, { recursive: true });

  const obs = store.allRows('observations').filter((o) => !o.redacted); // 墓石は出さない
  const states = store.allRows('states');
  const publicObs = obs.filter((o) => !o.secret);
  const publicStates = states.filter((s) => !s.secret);

  const files = {
    'observations.jsonl': toJsonl(publicObs),
    'observations.secret.jsonl': toJsonl(obs.filter((o) => o.secret)),
    'states.jsonl': toJsonl(publicStates),
    'states.secret.jsonl': toJsonl(states.filter((s) => s.secret)),
    'candidates.jsonl': toJsonl(store.allRows('candidates')),
    'refs.jsonl': toJsonl(store.allRows('refs')),
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({ exported_at: nowIso(), schema_version: store.schemaVersion(), stats: store.stats() }, null, 2) + '\n'
  );
  // secret 分離ファイルを誤って push しないための保険
  writeFileSync(join(dir, '.gitignore'), 'observations.secret.jsonl\nstates.secret.jsonl\n');

  // 公開ファイル側に残存する機密をスキャンして警告（取りこぼし前提の多層防御）
  const gate = compileGate(config ?? { deny_patterns: [] });
  const warnings = [];
  for (const o of publicObs) {
    const hit = gate.match(o.text);
    if (hit) warnings.push(`observations.jsonl: ${o.id} に機密の疑い (${hit})。\`ulm obs secret ${o.id}\` を検討`);
  }
  for (const s of publicStates) {
    const hit = gate.match(s.value);
    if (hit) warnings.push(`states.jsonl: ${s.key} に機密の疑い (${hit})`);
  }
  return { dir, files: Object.keys(files), warnings };
}
