// ulm doctor — 環境診断
import { existsSync } from 'node:fs';
import { ulmHome, configPath, dbPath, loadConfig, homeInitialized } from './config.js';
import { compileGate } from './gate.js';
import { codexAvailable, opencodeAvailable } from './miner.js';
import { openStore } from './store.js';
import { projectInfo } from './project.js';

export function runDoctor() {
  const home = ulmHome();
  const checks = [];
  const ok = (name, detail) => checks.push({ level: 'ok', name, detail });
  const warn = (name, detail) => checks.push({ level: 'warn', name, detail });
  const bad = (name, detail) => checks.push({ level: 'error', name, detail });

  // Node バージョン（node:sqlite は 22.5+）
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 5)) ok('node', `v${process.versions.node}`);
  else bad('node', `v${process.versions.node} — node:sqlite に Node >= 22.5 が必要`);

  // ULM_HOME
  if (homeInitialized(home)) ok('home', home);
  else {
    bad('home', `${home} が未初期化 — \`ulm init\` を実行してください`);
    return { home, checks };
  }
  if (existsSync(dbPath(home))) ok('db', dbPath(home));
  else warn('db', 'memory.db がまだありません（初回書き込みで作成されます）');

  // 現在の project 解決
  const pi = projectInfo(process.cwd());
  ok('project', `${pi.name}${pi.remote ? ` (${pi.remote})` : ' (remote なし)'}`);

  // ref ファイルの不在 + 観測件数の閾値
  if (existsSync(dbPath(home))) {
    const store = openStore(home);
    try {
      const missing = store.listRefs().filter((r) => !existsSync(r.path));
      if (missing.length) warn('refs', `${missing.length} 件の ref ファイルが不在: ${missing.map((r) => r.path).join(', ')}`);
      const s = store.stats();
      if (s.observations >= 5000) warn('volume', `観測 ${s.observations} 件 — archive を検討`);
      if (s.candidates_inbox >= 50) warn('inbox', `未レビュー候補 ${s.candidates_inbox} 件 — review/reject-stale を検討`);
      // FTS5（関連度想起）の利用可否
      if (store.hasFts()) ok('recall', 'FTS5(trigram) 有効 — ulm recall で関連度想起');
      else warn('recall', 'FTS5 が無効（この SQLite ビルドは fts5 非対応）。recall は LIKE にフォールバック');
    } finally {
      store.close();
    }
  }

  // config
  try {
    const config = loadConfig(home);
    ok('config', configPath(home));
    const warns = [];
    compileGate(config, (m) => warns.push(m));
    if (warns.length) warn('deny_patterns', warns.join(' / '));
    else ok('gate', `組込み + 追加 ${config.deny_patterns.length} パターン`);

    // miner プロバイダ（auto は codex → opencode。openai は明示時のみ）
    const codex = codexAvailable();
    const oc = opencodeAvailable();
    const keyEnv = config.miner.api_key_env || 'OPENAI_API_KEY';
    const hasKey = !!process.env[keyEnv];
    if (codex) ok('miner:codex', 'codex CLI が利用可能');
    else warn('miner:codex', 'codex CLI が見つかりません');
    if (oc) ok('miner:opencode', `opencode CLI が利用可能 (model=${config.miner.opencode_model})`);
    else warn('miner:opencode', 'opencode CLI が見つかりません');
    if (hasKey) ok('miner:openai', `${keyEnv} が設定済み (${config.miner.base_url}) — provider="openai" 明示時のみ使用`);
    else warn('miner:openai', `${keyEnv} が未設定（openai プロバイダは使えません）`);
    if (!codex && !oc) {
      if (hasKey) warn('miner', 'codex / opencode が無いため auto では mine/capture は動きません（openai は provider 明示で使用可）');
      else bad('miner', 'どのプロバイダも使えません。`ulm mine` は失敗します');
    }
  } catch (err) {
    bad('config', err.message);
  }

  return { home, checks };
}
