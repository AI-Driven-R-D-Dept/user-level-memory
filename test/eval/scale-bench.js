#!/usr/bin/env node
// スケール計測: obs_vec に N 件のランダムベクトルを入れ vectorSearch のレイテンシを測る。
// 全件 JS 線形スキャンが数万件で実用的かを数値で確定する（破綻するか不明、を解消）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store.js';
import { ensureHome } from '../../src/config.js';
import { vecToBuf, cosine } from '../../src/embed.js';

const N = Number(process.argv[2] || 20000);
const DIM = 1536;
const home = join(mkdtempSync(join(tmpdir(), 'ulm-scale-')), 'ulm');
ensureHome(home);
const store = openStore(home);

// 決定的擬似乱数
let s = 7;
const rnd = () => ((s = (1103515245 * s + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

console.error(`挿入中 ${N} 件 (dim=${DIM})...`);
const t0 = Date.now();
// observations を1件だけ作り、obs_vec を直接大量挿入（観測本体のコストを除外して vector 探索のみ計測）
const stmt = store.db.prepare('INSERT INTO obs_vec (obs_id, model, dim, vec) VALUES (?, ?, ?, ?)');
const obsStmt = store.db.prepare("INSERT INTO observations (id, ts, project, text, tags, source, secret, meta, pinned, redacted, archived) VALUES (?, '2026-01-01T00:00:00Z', 'bench', 't', '[]', 'manual', 0, '{}', 0, 0, 0)");
store.db.exec('BEGIN');
for (let i = 0; i < N; i++) {
  const id = `obs-b${i}`;
  obsStmt.run(id);
  const v = new Float32Array(DIM);
  for (let j = 0; j < DIM; j++) v[j] = rnd();
  stmt.run(id, 'bench', DIM, vecToBuf(v));
}
store.db.exec('COMMIT');
console.error(`挿入完了 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const q = new Float32Array(DIM);
for (let j = 0; j < DIM; j++) q[j] = rnd();

// ウォームアップ + 計測
const lat = [];
for (let r = 0; r < 12; r++) {
  const t = Date.now();
  store.vectorSearch(q, { project: 'bench', limit: 10, cosine });
  lat.push(Date.now() - t);
}
lat.sort((a, b) => a - b);
const p50 = lat[Math.floor(lat.length * 0.5)];
const p95 = lat[Math.floor(lat.length * 0.95)];
console.log(`vectorSearch over ${N} vectors: p50=${p50}ms p95=${p95}ms (12 runs)`);
store.close();
rmSync(home, { recursive: true, force: true });
