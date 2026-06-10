// 意味的想起のための埋め込み層（任意・依存ゼロ）。
// OpenAI 互換 embeddings API が使えるとき、観測ベクトルを SQLite に貯め、
// クエリベクトルとの cosine で「字面ゼロ一致でも関連する記憶」を拾う。
// API キーが無い環境では一切呼ばず、FTS(BM25) のみで動く（degrade gracefully）。
//
// セキュリティ: 埋め込みに送るのは secret=0 の観測テキストのみ（呼び出し側で保証）。
// base_url は miner と同じ allowlist 検証を流用する。
import { assertEmbedAllowed } from './miner.js';

const MODEL_DIM = { 'text-embedding-3-small': 1536, 'text-embedding-3-large': 3072 };

export function embedConfig(config) {
  const e = config.embed || {};
  return {
    enabled: e.enabled !== false, // 既定 ON（ただしキーが無ければ自動で無効）
    model: e.model || 'text-embedding-3-small',
    base_url: e.base_url || config.miner.base_url,
    api_key_env: e.api_key_env || config.miner.api_key_env || 'OPENAI_API_KEY',
    allowed_hosts: e.allowed_hosts || config.miner.allowed_hosts || [],
    batch: e.batch || 64,
  };
}

export function embedAvailable(config) {
  const ec = embedConfig(config);
  return ec.enabled && !!process.env[ec.api_key_env];
}

/** Float32 配列 ⇄ Buffer */
export function vecToBuf(arr) {
  return Buffer.from(Float32Array.from(arr).buffer);
}
/**
 * Buffer/Uint8Array → 独立した Float32Array。
 * SQLite が返す BLOB は byteOffset が 4 整列とは限らず、またプールされた ArrayBuffer の
 * ビューになりうる。常にアライン済みのコピーを作り、例外と参照共有の両方を防ぐ。
 */
export function bufToVec(buf) {
  const n = Math.floor(buf.byteLength / 4);
  const out = new Float32Array(n);
  const view = new DataView(buf.buffer, buf.byteOffset, n * 4);
  for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, true); // little-endian で復元
  return out;
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** ベクトルの L2 ノルム */
export function l2norm(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}

/**
 * Buffer から Float32 を読み、事前計算済みのクエリ(q, qNorm)との cosine を返す。
 * 中間 Float32Array を作らず Buffer を直接 dot するスケール最適化版。
 */
export function cosineFromBuf(q, qNorm, buf) {
  const n = Math.min(q.length, Math.floor(buf.byteLength / 4));
  let dot = 0, nb = 0;
  // 4 整列なら直接 Float32 ビュー（コピーなし・最速）。非整列時のみ DataView。
  if (buf.byteOffset % 4 === 0) {
    const f = new Float32Array(buf.buffer, buf.byteOffset, n);
    for (let i = 0; i < n; i++) { const v = f[i]; dot += q[i] * v; nb += v * v; }
  } else {
    const dv = new DataView(buf.buffer, buf.byteOffset, n * 4);
    for (let i = 0; i < n; i++) { const v = dv.getFloat32(i * 4, true); dot += q[i] * v; nb += v * v; }
  }
  if (qNorm === 0 || nb === 0) return 0;
  return dot / (qNorm * Math.sqrt(nb));
}

/** テキスト配列を埋め込む。失敗時は例外。 */
export async function embedTexts(texts, config) {
  const ec = embedConfig(config);
  const apiKey = process.env[ec.api_key_env];
  if (!apiKey) throw new Error(`埋め込みに ${ec.api_key_env} が必要です`);
  // base_url の allowlist 検証（exfil 防止、miner と共通ルール）
  assertEmbedAllowed(ec);
  const url = `${ec.base_url.replace(/\/$/, '')}/embeddings`;
  const out = [];
  for (let i = 0; i < texts.length; i += ec.batch) {
    const batch = texts.slice(i, i + ec.batch);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: ec.model, input: batch }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`embeddings API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = await res.json();
      for (const d of json.data) out.push(d.embedding);
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

export { MODEL_DIM };
