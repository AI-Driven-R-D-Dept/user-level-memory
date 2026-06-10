// ULM_HOME と config.json の管理
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CONFIG = {
  // 機械的機密ゲート: 組込みパターンに追加する正規表現（文字列）
  deny_patterns: [],
  context: {
    max_obs: 10, // SessionStart で注入する観測の最大件数
    max_chars: 4000, // 注入ブロック全体の文字数予算
    days: 30, // 観測の参照期間
    obs_chars: 200, // 観測1件あたりの最大文字数
    recall_k: 5, // UserPromptSubmit の関連度想起で出す観測の最大件数
  },
  capture: {
    enabled: true, // Stop hook での観測自動抽出
    provider: 'auto', // auto | codex | openai（miner と同設定を流用）
    max_per_session: 3, // 1セッションで自動抽出する観測の上限
  },
  miner: {
    provider: 'auto', // auto | codex | openai
    model: 'gpt-5.5',
    reasoning_effort: 'low',
    base_url: 'https://api.openai.com/v1',
    allowed_hosts: [], // base_url の追加許可ホスト（exfil 防止の allowlist）
    api_key_env: 'OPENAI_API_KEY', // キーは環境変数からのみ読む（保存しない）
    max_obs: 50, // LLM に渡す観測の上限
    max_candidates: 5, // 1回の mine で作る候補の上限
    days: 30,
  },
};

export function ulmHome() {
  return process.env.ULM_HOME || join(homedir(), '.claude', 'user-memory');
}

export function configPath(home = ulmHome()) {
  return join(home, 'config.json');
}

export function dbPath(home = ulmHome()) {
  return join(home, 'memory.db');
}

function deepMerge(base, over) {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || Array.isArray(over)) return over;
  if (base !== null && over !== null && typeof base === 'object' && typeof over === 'object') {
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
    return out;
  }
  return over;
}

export function loadConfig(home = ulmHome()) {
  const p = configPath(home);
  if (!existsSync(p)) return structuredClone(DEFAULT_CONFIG);
  let raw;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`config.json が壊れています (${p}): ${err.message}`);
  }
  return deepMerge(structuredClone(DEFAULT_CONFIG), raw);
}

/** ULM_HOME を初期化（存在してもよい）。作成したパスの一覧を返す */
export function ensureHome(home = ulmHome()) {
  const created = [];
  for (const dir of [home, join(home, 'export'), join(home, 'ref')]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }
  const cp = configPath(home);
  if (!existsSync(cp)) {
    writeFileSync(cp, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    created.push(cp);
  }
  return created;
}

export function homeInitialized(home = ulmHome()) {
  return existsSync(configPath(home));
}
