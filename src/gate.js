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
  { name: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'stripe-key', re: /(?:sk|rk)_live_[A-Za-z0-9]{16,}/ },
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{30,}/ },
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'db-uri', re: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s]+:[^@\s]+@/ },
  { name: 'bearer', re: /bearer\s+[A-Za-z0-9_\-.=]{20,}/i },
  {
    name: 'credential-assignment',
    re: /(?:password|passwd|pwd|api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret|auth[_-]?token)\s*[:=]\s*['"]?[^\s'"]{6,}/i,
  },
];

const MAX_PATTERN_LENGTH = 300; // 極端に長い独自パターンを拒否
const MAX_SCAN_LENGTH = 64 * 1024; // ReDoS/CPU 事故予防: これ以上は先頭のみ走査
// ネストした量化子など破滅的バックトラックを生みやすい構造を静的に拒否
const DANGEROUS_PATTERN = /(\([^)]*[+*][^)]*\)[+*])|(\[[^\]]*\][+*]\{?\d*,?\}?[+*])/;

/** config.deny_patterns（文字列の正規表現）をコンパイル。危険/不正なものは警告して除外 */
export function compileGate(config, warn = () => {}) {
  const patterns = [...BUILTIN];
  for (const src of config?.deny_patterns ?? []) {
    if (typeof src !== 'string' || src.length === 0) continue;
    if (src.length > MAX_PATTERN_LENGTH) {
      warn(`deny_patterns: 長すぎるパターンを無視 (${src.slice(0, 40)}…)`);
      continue;
    }
    if (DANGEROUS_PATTERN.test(src)) {
      warn(`deny_patterns: ReDoS の恐れがあるパターンを無視: ${src}`);
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
 * 誤検知が多いので「警告」用途。自動 secret 化はしない。
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

const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * 注入・生成用の無害化。
 * observation/state は「データ」であり命令ではない。注入ブロックの構造を壊させない。
 * - ゼロ幅/制御文字の除去（不可視命令対策）
 * - 偽 system/role タグ、fence ブレイク列の中和
 * - 1行化（リスト/コードブロック構造の偽装防止）
 */
export function sanitizeForContext(text) {
  return String(text)
    .replace(ZERO_WIDTH, '')
    .replace(CONTROL, ' ')
    .replace(/<\/?(?:user-memory|system|assistant|human|tool_call|function_calls|invoke)\b[^>]*>/gi, '[tag]')
    .replace(/^\s*(?:SYSTEM|ASSISTANT|USER|HUMAN|DEVELOPER)\s*:/gim, 'ロール: ')
    .replace(/`{3,}/g, '``')
    .replace(/^[-=]{3,}\s*$/gm, '—')
    .replace(/[ \t]*\n[ \t]*/g, ' ')
    .trim();
}
