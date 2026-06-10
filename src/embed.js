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
export function bufToVec(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
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
