// ULM_HOME と config.json の管理
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CONFIG = {
  // 機械的機密ゲート: 組込みパターンに追加する正規表現（文字列）
  deny_patterns: [],
  gate: {
    // 高エントロピー文字列（未知形式トークンの兆候）を検出したら安全側に secret 化する（fail-closed）。
    // false にすると警告のみ（取りこぼし漏洩のリスクを受け入れる）。
    entropy_secret: true,
  },
  context: {
    max_obs: 10, // SessionStart で注入する観測の最大件数
    max_chars: 4000, // 注入ブロック全体の文字数予算
    days: 30, // 観測の参照期間
    obs_chars: 200, // 観測1件あたりの最大文字数
    recall_k: 5, // UserPromptSubmit の関連度想起で出す観測の最大件数
    recall_inject_min: 0.3, // 最良ヒットの cosine がこれ未満なら recall は全棄権（無関係プロンプトへのノイズ注入防止）
    recall_min_sim: 0.22, // 棄権しない場合に候補として残す cosine の下限（近傍バンドの床）
  },
  capture: {
    enabled: true, // Stop hook での観測自動抽出
    provider: 'auto', // auto | codex | opencode | openai（miner と同設定を流用）
    max_per_session: 3, // 1セッションで自動抽出する観測の上限
    // 自動抽出(source=auto)の未レビュー観測を recall 注入に含めるか。
    // recall は「関連時のみ発火・データfenceで無害化・(自動抽出/未レビュー)ラベル付き・機密ゲート済み」
    // なので既定 true（E2E で実価値を確認）。SessionStart の無条件注入では auto は除外したまま。
    // 一切の未レビュー注入を避けたい場合は false に。
    recall_auto: true,
  },
  embed: {
    // 意味的想起のための埋め込み（任意）。キーが無ければ自動で無効になり FTS のみで動く。
    enabled: true,
    model: 'text-embedding-3-small',
    // base_url / api_key_env / allowed_hosts は未指定なら miner 設定を流用
  },
  miner: {
    // auto は codex → opencode の順で CLI を探す（どちらも API キー不要・定額側）。
    // openai（従量課金 API）への暗黙フォールバックはしない: 'openai' を明示したときのみ使う。
    provider: 'auto', // auto | codex | opencode | openai
    model: 'gpt-5.5', // codex / openai 用
    opencode_model: 'opencode-go/deepseek-v4-flash', // opencode 用（provider/model 形式）
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
