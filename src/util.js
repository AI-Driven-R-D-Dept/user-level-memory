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
