// 汎用ユーティリティ（依存ゼロ）

export function nowIso() {
  return new Date().toISOString();
}

/** "30m" | "24h" | "7d" | "2w" → ミリ秒。不正なら null */
export function parseTtl(ttl) {
  const m = /^(\d+)(m|h|d|w)$/.exec(String(ttl).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]];
  return n * unit;
}

export function truncate(text, max) {
  const s = String(text);
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/** stdin を全部読む（TTY なら即 ''） */
export async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/** ISO 日時を "2026-06-10" に短縮 */
export function shortDate(iso) {
  return String(iso).slice(0, 10);
}

/** カンマ区切り → トリム済み配列 */
export function splitCsv(s) {
  if (!s) return [];
  return String(s)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export function parseJsonSafe(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/**
 * トライグラム包含率（小さい方の集合に対する共通率、0〜1）。
 * 注意: これは「似ているかもしれない」警告用の弱フィルタ専用。重複の判定には使えない —
 * 実測で「同事実の言い換え」(0.44-0.54) より「同型文の別事実」(0.76) が高く、分離する閾値が
 * 存在しない（DESIGN.md §9.6）。判定が要る場面では LLM のペア判定を使うこと。
 */
export function trigramContainment(a, b) {
  const norm = (s) => String(s).toLowerCase().replace(/[\s、。・「」『』（）()\[\]【】.,:;!?！？]/g, '');
  const tri = (s) => {
    const n = norm(s);
    const set = new Set();
    for (let i = 0; i + 3 <= n.length; i++) set.add(n.slice(i, i + 3));
    return set;
  };
  const A = tri(a);
  const B = tri(b);
  if (!A.size || !B.size) return 0;
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  let hit = 0;
  for (const t of small) if (large.has(t)) hit++;
  return hit / small.size;
}
