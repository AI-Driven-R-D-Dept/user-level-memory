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
  // 線形化: 先頭 eyJ を否定後読みでアンカー（連結 eyJ 反復での全位置再走査を防ぐ）し、
  // 各セグメントを有界 {8,2048} に。旧 `{8,}` は無上限でドット無し eyJ 反復に対し二次
  // (1MB単一行で gate.match 約3.2s)になっていた。実JWTは各セグメント数百字で {8,2048} に収まる。
  { name: 'jwt', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,2048}\.eyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}/ },
  { name: 'db-uri', re: /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i }, // user:pass@host（スキーム不問。先頭アンカーで線形化）
  { name: 'bearer', re: /bearer\s+[A-Za-z0-9_\-.=]{20,}/i },
  { name: 'authorization-header', re: /authorization\s*:\s*\S{8,}/i },
  { name: 'gcp-service-account', re: /"private_key_id"\s*:|"type"\s*:\s*"service_account"/ },
  { name: 'azure-key', re: /AccountKey\s*=\s*[A-Za-z0-9+/=]{16,}/i },
  { name: 'hex-token', re: /\b[0-9a-f]{32,}\b/i }, // 32桁以上の連続 hex（汎用トークン）
  // 線形化: 識別子の先頭に否定後読みでアンカーし、キーワード前のスキャンを有界(0,80)化。
  // 以前の `[A-Z0-9_]*KW[A-Z0-9_]*` は前後の無制限 * がキーワード文字と重なり、
  // `TOKEN_`×N 入力で指数バックトラック(16KB=20s ハング)していた。アンカーで開始位置を
  // 識別子先頭のみに限定し、本体は単一の貪欲クラス `[A-Z0-9_]+` で1回マッチ→全体 O(n)。
  { name: 'env-secret-assign', re: /(?<![A-Z0-9_])(?=[A-Z0-9_]{0,80}(?:TOKEN|SECRET|PASSWORD|APIKEY|API_KEY|PRIVATE_KEY))[A-Z0-9_]+\s*[:=]\s*['"]?[^\s'"]{5,}/ },
  {
    name: 'credential-assignment',
    re: /(?:password|passwd|pwd|api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret|auth[_-]?token)\s*[:=]\s*['"]?[^\s'"]{5,}/i,
  },
  // 自然言語の秘密開示（`passphrase is X` / `password word is hunter2`）。構造化代入を
  // 通り抜ける平文機密の盲点(read-path 漏洩)を塞ぐ。強い秘密語＋近接(≤16字)の is/was/:/=
  // ＋6字以上の値に限定して誤検知を抑制。量化子は有界で線形。過検出は安全側(secret化)。
  {
    name: 'nl-secret-phrase',
    re: /\b(?:passphrase|password|passwd|secret[ _-]?key|private[ _-]?key|api[ _-]?key|access[ _-]?key|auth[ _-]?token|credential)\b[^\n]{0,16}?(?:\bis\b|\bwas\b|[:=])\s*\S{6,}/i,
  },
];

const MAX_PATTERN_LENGTH = 300; // 極端に長い独自パターンを拒否
// 走査は行単位＋重なり窓で全域をカバーする（16KB 先頭打ち切りによる末尾機密の取りこぼしを廃止）。
// BUILTIN を線形化済みなので、窓ごとのコストは O(窓長) に収まる。
const MAX_LINE_SCAN = 8 * 1024; // 1行(または1窓)あたりの走査長
const WINDOW_OVERLAP = 1024; // 窓境界をまたぐトークンの取りこぼし防止の重なり（想定トークン長より大）
const MAX_TOTAL_SCAN = 1024 * 1024; // 総走査量のバックストップ（1MB。極端な入力での CPU 事故予防）
// 1行あたりの最小計上コスト。短行でも全パターンの .test() が走るため、行数による
// CPU 増幅（`x\n`×N の大量短行）を総量に算入してバックストップを確実に発火させる。
const MIN_LINE_COST = 64;

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
      const full = String(text ?? '');
      try {
        let scanned = 0;
        // 行単位で全域を走査（末尾の機密も見落とさない）。無改行で長大な行は
        // 重なり付き窓に分割し、各窓を線形パターンで検査する（窓境界の機密は overlap で救済）。
        for (const line of full.split('\n')) {
          if (scanned > MAX_TOTAL_SCAN) break;
          if (line.length <= MAX_LINE_SCAN) {
            scanned += Math.max(line.length, MIN_LINE_COST); // 行数による増幅も総量に算入
            for (const p of patterns) if (p.re.test(line)) return p.name;
            continue;
          }
          for (let i = 0; i < line.length; i += MAX_LINE_SCAN - WINDOW_OVERLAP) {
            if (scanned > MAX_TOTAL_SCAN) break;
            const seg = line.slice(i, i + MAX_LINE_SCAN);
            scanned += seg.length;
            for (const p of patterns) if (p.re.test(seg)) return p.name;
          }
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
  // 区切りを増やして kebab/path/dotted な識別子（k8s 設定名・URL 風）を語に分解し誤検知を減らす。
  for (const tok of String(text ?? '').split(/[\s"'`,;:/.\\|()<>\[\]{}]+/)) {
    if (tok.length < 24) continue;
    if (!/^[A-Za-z0-9+=_-]+$/.test(tok)) continue;
    // 実在トークン/鍵はほぼ必ず数字を含む。純アルファの長語（CamelCase クラス名等）は除外し
    // 誤 secret 化を抑える。数字を含み高エントロピーなものだけを機密の兆候とみなす。
    const hasDigit = /[0-9]/.test(tok);
    if (hasDigit && entropy(tok) >= 4.0) {
      return tok.length > 12 ? `${tok.slice(0, 6)}…${tok.slice(-4)}` : tok;
    }
  }
  return null;
}

const ZERO_WIDTH = /[​-‏‪-‮⁠-⁤﻿]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g; // \r(\x0d) も含む。\t は残し後段で空白化

// cross-script 同形異字（キリル/ギリシャ）を Latin に畳む。NFKC では畳まれないため、
// `ЅYSTEM:`(キリル Ѕ) のような非Latin 偽装で役割マーカー中和を回避されるのを塞ぐ。
const CONFUSABLES = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', Ѕ: 'S', І: 'I', Ј: 'J', Ү: 'Y',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', ѕ: 's', і: 'i', ј: 'j',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X', Ϲ: 'C', ο: 'o', ϲ: 'c',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');
// NFKC で畳まれない角括弧変種（〈〉⟨⟩）を ASCII 山括弧に正規化し、後段の [tag] 化に乗せる。
// 全角＜＞は NFKC が畳むのでここでは扱わない。
const ANGLE_OPEN = /[〈⟨]/g;
const ANGLE_CLOSE = /[〉⟩]/g;
// 前置は「英数字以外」（語境界）の否定後読み。これで `。SYSTEM:` / `．USER:` など
// 記号直後の役割マーカーも捕捉。コロンクラスには同形異字コロン(∶ː꞉⁚＝U+2236/02D0/A789/205A,
// 全角：)も含め、`SYSTEM∶` のような偽装も中和する。`ABUSER:` のような語中一致は除外。
const ROLE_WORDS = /(?<![A-Za-z0-9])(?:SYSTEM|ASSISTANT|USER|HUMAN|DEVELOPER|ROLE|TOOL)\s*[:：∶ː꞉⁚]/gi;
// 角括弧で囲んだ役割マーカー（`[SYSTEM]` `[/ASSISTANT]` `[USER: ...]`）も中和する。
// 量化子は有界（\s{0,40}・[^\]\n]{0,200}）。旧 `\[\s*\/?\s*` の二重 `\s*` は空白分割で
// O(n²) になり、長大な空白入力で CPU ストール(`context --hook` 15s)を起こしていた。
const BRACKET_ROLE = /\[\s{0,40}\/?\s{0,40}(?:SYSTEM|ASSISTANT|USER|HUMAN|DEVELOPER|ROLE|TOOL)\b[^\]\n]{0,200}\]/gi;
// タグ様の山括弧を [tag] 化。`<` 直後や `/` 周りの空白も許容（CONTROL→空白置換で
// `<\x01/user-memory>`→`< /user-memory>` となり fence 脱出していた順序バグを塞ぐ）。
// 量化子は有界で線形。
const TAG_LIKE = /<\s{0,40}\/?\s{0,40}[A-Za-z][^>\n]{0,256}>/g;
const MAX_SANITIZE = 64 * 1024; // 注入表示用の入力上限（DoS backstop。元データは DB に保持）

/**
 * 注入・生成用の無害化。
 * observation/state/id/source は「データ」であり命令ではない。注入ブロックの構造を壊させない。
 *
 * 防御の要は「データfence(<user-memory>)の境界を閉じさせないこと」。境界さえ守れれば、
 * 内部に役割マーカーや同形異字が残ってもモデルには fence 内のデータとして提示される。
 * - NFKC 正規化（全角 SYSTEM：→ SYSTEM: 等の同形を畳む）
 * - NFD 分解＋結合ダイアクリティカル除去（合成済みアクセント ŚYSTEM→SYSTEM の偽装対策。
 *   除去対象は Latin 用結合域 U+0300-036F のみで、日本語の濁点(U+3099)等は触らない）
 * - cross-script 同形異字(キリル/ギリシャ)を Latin に畳む（NFKC では畳まれない偽装対策）
 * - ゼロ幅/制御文字(\r 含む)の除去（不可視命令・端末操作対策）
 * - 角括弧変種(〈〉⟨⟩)を ASCII 化し、タグ様の山括弧 `</word>` を [tag] 化（fence 境界の閉じを封じる）
 *   閉じ `>` を欠いた `</word` も中和（寛容な LLM の fence 誤読を防ぐ）
 * - 1行化してから役割マーカー（行頭/語境界・角括弧形）を中和（mid-line も捕捉）
 * - コードフェンス/水平線の中和
 */
export function sanitizeForContext(text) {
  let s = String(text);
  // 注入表示用の上限。これ自体が ReDoS/CPU 事故の最終 backstop（全 regex を線形化済みだが
  // 二重防御）。元データは DB に保持され、ここで切るのは context へ出す見え方だけ。
  if (s.length > MAX_SANITIZE) s = s.slice(0, MAX_SANITIZE);
  try {
    // NFKC で全角等を畳み、NFD 分解→Latin 結合域除去で合成済みアクセントを ASCII 字母に畳む。
    // \u6700\u5f8c\u306b NFC \u3067\u518d\u5408\u6210\uff08\u65e5\u672c\u8a9e\u306e\u6fc1\u70b9/\u534a\u6fc1\u70b9\u306a\u3069 Latin \u57df\u5916\u306e\u7d50\u5408\u6587\u5b57\u3092\u5143\u306e\u5408\u6210\u5f62\u306b\u623b\u3059\uff09\u3002
    s = s.normalize('NFKC').normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
  } catch {
    // 不正なコードポイントは握りつぶす
  }
  return s
    .replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] || c)
    .replace(ZERO_WIDTH, '')
    .replace(CONTROL, ' ')
    .replace(ANGLE_OPEN, '<')
    .replace(ANGLE_CLOSE, '>')
    .replace(/\n[ \t]*/g, ' ') // 改行+後続空白を空白化
    // 空白畳みを tag/role 中和の「前」に行う。これをしないと `<`〜`/word>` の間に
    // TAG_LIKE の上限(\s{0,40})を超える空白(41字以上)を詰めて TAG_LIKE を外し、後段の
    // 畳みで `< /user-memory>`（実 `>` 保持）が復元される fence 脱出が成立した（HIGH-1）。
    // 先に全空白ランを1つに畳めば、tag/role の有界量化子が常に届く。
    .replace(/\s{2,}/g, ' ')
    .replace(TAG_LIKE, '[tag]')
    .replace(/<\s{0,8}\/\s{0,8}[A-Za-z][\w-]{0,64}>?/g, '[tag]') // 閉じ `>` 欠落の `</word` も中和
    .replace(BRACKET_ROLE, '[ロール]')
    .replace(ROLE_WORDS, ' ロール: ')
    .replace(/`{2,}/g, "'")
    .replace(/(?:^|\s)[-=]{3,}(?=\s|$)/g, ' — ')
    .replace(/\s{2,}/g, ' ') // 置換で生じた連続空白の最終整形
    .trim();
}
