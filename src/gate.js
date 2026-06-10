// 機械的機密ゲート。判定に AI は使わない（判定のために機密を AI へ渡さない）。
// 入口 (obs/state/cand add) / 注入 (context) / 生成 (mine) / 持出 (export) で使う。
// 設計方針: 取りこぼし前提の多層防御 + 不正パターンは fail-closed（機密扱い）。

/** 組込み deny パターン。name は警告表示用。すべて ReDoS 安全な線形パターン。 */
const BUILTIN = [
  { name: 'openai-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'aws-secret', re: /aws_secret_access_key\s*[:=]\s*\S{16,}/i },
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'github-pat', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'gitlab-token', re: /glpat-[A-Za-z0-9_-]{16,}/ },
  { name: 'huggingface-token', re: /hf_[A-Za-z0-9]{16,}/ },
  { name: 'replicate-token', re: /r8_[A-Za-z0-9]{20,}/ },
  { name: 'digitalocean-token', re: /dop_v1_[a-f0-9]{32,}/ },
  { name: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'stripe-key', re: /(?:sk|rk)_live_[A-Za-z0-9]{16,}/ },
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{30,}/ },
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'db-uri', re: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i }, // user:pass@host（スキーム不問）
  { name: 'bearer', re: /bearer\s+[A-Za-z0-9_\-.=]{20,}/i },
  { name: 'authorization-header', re: /authorization\s*:\s*\S{8,}/i },
  { name: 'gcp-service-account', re: /"private_key_id"\s*:|"type"\s*:\s*"service_account"/ },
  { name: 'azure-key', re: /AccountKey\s*=\s*[A-Za-z0-9+/=]{16,}/i },
  { name: 'hex-token', re: /\b[0-9a-f]{32,}\b/i }, // 32桁以上の連続 hex（汎用トークン）
  { name: 'env-secret-assign', re: /[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|APIKEY|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[:=]\s*['"]?[^\s'"]{5,}/ },
  {
    name: 'credential-assignment',
    re: /(?:password|passwd|pwd|api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret|auth[_-]?token)\s*[:=]\s*['"]?[^\s'"]{5,}/i,
  },
];

const MAX_PATTERN_LENGTH = 300; // 極端に長い独自パターンを拒否
const MAX_SCAN_LENGTH = 16 * 1024; // ReDoS/CPU 事故予防: これ以上は先頭のみ走査（多項式爆発も有界化）

/**
 * ユーザー由来の deny パターンが ReDoS 安全かを静的に判定する。
 * 破滅的バックトラックは「曖昧さ（グループ/選択肢・隣接反復）× 無制限量化子」で起きる。
 * 純 Node では正規表現実行に timeout を掛けられないため、危険要素を構造的に禁止する:
 *  - グループ `(` と選択肢 `|`（指数爆発の源）を一切許可しない
 *  - 無制限量化子（* + {n,}）は最大1個まで（`a*a*$` 等の隣接反復による二次爆発も封じる）
 * これにより指数も二次も原理的に起きず、線形時間に収まる。
 * `?` や `{n}` `{n,m}`（有界）はカウントしないので実用パターンは書ける。
 * 組込みパターンはこの制約の対象外（人手でレビュー済み）。
 */
export function isPatternSafe(src) {
  if (/[(|]/.test(src)) return false; // グループ・選択肢を禁止
  const unbounded = (src.match(/\*|\+|\{\s*\d+\s*,\s*\}/g) || []).length;
  if (unbounded > 1) return false; // 無制限量化子は1個まで（二次爆発の防止）
  return true;
}

/** config.deny_patterns（文字列の正規表現）をコンパイル。危険/不正なものは警告して除外 */
export function compileGate(config, warn = () => {}) {
  const patterns = [...BUILTIN];
  for (const src of config?.deny_patterns ?? []) {
    if (typeof src !== 'string' || src.length === 0) continue;
    if (src.length > MAX_PATTERN_LENGTH) {
      warn(`deny_patterns: 長すぎるパターンを無視 (${src.slice(0, 40)}…)`);
      continue;
    }
    if (!isPatternSafe(src)) {
      warn(`deny_patterns: ReDoS の恐れがあるパターンを無視（グループ()・選択肢|・3個以上の量化子は不可）: ${src}`);
      continue;
    }
    try {
      patterns.push({ name: `custom:${src.slice(0, 30)}`, re: new RegExp(src) });
    } catch {
      warn(`deny_patterns: 不正な正規表現を無視: ${src}`);
    }
  }
  return {
    /** 機密パターンに一致したらパターン名、なければ null。例外時は fail-closed で 'gate-error' */
    match(text) {
      let s = String(text ?? '');
      if (s.length > MAX_SCAN_LENGTH) s = s.slice(0, MAX_SCAN_LENGTH);
      try {
        for (const p of patterns) {
          if (p.re.test(s)) return p.name;
        }
        return null;
      } catch {
        return 'gate-error'; // 判定に失敗したら機密扱い（fail-closed）
      }
    },
  };
}

/** Shannon エントロピー */
function entropy(str) {
  const freq = new Map();
  for (const ch of str) freq.set(ch, (freq.get(ch) || 0) + 1);
  let e = 0;
  for (const n of freq.values()) {
    const p = n / str.length;
    e -= p * Math.log2(p);
  }
  return e;
}

/**
 * 高エントロピーの長いトークンを検出（パターンに当たらない未知形式機密のヒント）。
 * 既定では fail-closed（cli の gateWrite が secret 化、recall/context が読み取り除外）。
 * config.gate.entropy_secret=false のときのみ「警告」用途に降格する。
 * @returns {string|null} 疑わしいトークンの断片、なければ null
 */
export function detectHighEntropy(text) {
  for (const tok of String(text ?? '').split(/[\s"'`,;]+/)) {
    if (tok.length >= 24 && /^[A-Za-z0-9+/=_-]+$/.test(tok) && entropy(tok) >= 4.0) {
      return tok.length > 12 ? `${tok.slice(0, 6)}…${tok.slice(-4)}` : tok;
    }
  }
  return null;
}

const ZERO_WIDTH = /[​-‏‪-‮⁠-⁤﻿]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g; // \r(\x0d) も含む。\t は残し後段で空白化
const ROLE_WORDS = /(?:^|[\s>\]])(?:SYSTEM|ASSISTANT|USER|HUMAN|DEVELOPER|ROLE|TOOL)\s*[:：]/gi;

/**
 * 注入・生成用の無害化。
 * observation/state/id/source は「データ」であり命令ではない。注入ブロックの構造を壊させない。
 *
 * 防御の要は「データfence(<user-memory>)の境界を閉じさせないこと」。境界さえ守れれば、
 * 内部に役割マーカーや同形異字が残ってもモデルには fence 内のデータとして提示される。
 * - NFKC 正規化（全角 SYSTEM：→ SYSTEM: 等の同形を畳む）
 * - ゼロ幅/制御文字(\r 含む)の除去（不可視命令・端末操作対策）
 * - あらゆる山括弧タグを [tag] 化（</user-memory> 等での境界脱出を一律封じる）
 * - 1行化してから役割マーカー（行頭/語境界）を中和（mid-line も捕捉）
 * - コードフェンス/水平線の中和
 */
export function sanitizeForContext(text) {
  let s = String(text);
  try {
    s = s.normalize('NFKC');
  } catch {
    // 不正なコードポイントは握りつぶす
  }
  return s
    .replace(ZERO_WIDTH, '')
    .replace(CONTROL, ' ')
    .replace(/<\/?[A-Za-z][^>]*>/g, '[tag]')
    .replace(/[ \t]*\n[ \t]*/g, ' ')
    .replace(ROLE_WORDS, ' ロール: ')
    .replace(/`{2,}/g, "'")
    .replace(/(?:^|\s)[-=]{3,}(?=\s|$)/g, ' — ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
