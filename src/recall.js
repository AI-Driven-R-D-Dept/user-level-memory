// ハイブリッド想起: FTS5(BM25, 字句) と 埋め込み(cosine, 意味) を
// Reciprocal Rank Fusion で融合する。埋め込みが無い環境では FTS のみ（degrade gracefully）。
//
// 字句一致(trigram)は「vocab_size」のような特異トークンに強いが同義語・言い換えに弱い。
// 埋め込みは「スタイルが反映されない⇄クラスが効かない」のような意味的近接を拾う。
// 両者を融合することで、どちらの取りこぼしも補完する。
import { embedAvailable, embedTexts, cosine } from './embed.js';

const RRF_K = 60;

/** ランク配列(idの順)→ {id: rrf寄与} */
function rrfScores(rankedIds) {
  const m = new Map();
  rankedIds.forEach((id, i) => m.set(id, 1 / (RRF_K + i + 1)));
  return m;
}

/**
 * @returns {Promise<{hits: object[], mode: 'hybrid'|'fts'|'vector'|'like'}>}
 *  hits は観測 + {rank?, sim?, fused} を持つ（融合スコア降順）
 */
export async function recallObservations(store, config, { query, project, scopes: scopesIn, limit = 5, candidateK = 30 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { hits: [], mode: 'none' };
  const scopes = scopesIn || (project ? ['global', project] : null);
  const minSim = config.context?.recall_min_sim ?? 0.28; // 無関係な vector 候補の足切り（精度制御）
  const ftsOpts = { query: q, scopes, includeSecret: false, includeArchived: false, limit: candidateK };

  const ftsHits = store.searchObservations(ftsOpts);
  const ftsById = new Map(ftsHits.map((o) => [o.id, o]));
  const usedFts = ftsHits.length && ftsHits[0].rank != null;

  let vecHits = [];
  if (embedAvailable(config) && store.embeddingCount() > 0) {
    try {
      const [qv] = await embedTexts([q], config);
      const qvec = Float32Array.from(qv);
      vecHits = store.vectorSearch(qvec, { scopes, includeSecret: false, includeArchived: false, limit: candidateK, cosine });
      // 類似度が閾値未満の候補は落とす（cosine が低いものは無関係。tail のノイズ注入を防ぐ）
      vecHits = vecHits.filter((o) => o.sim >= minSim);
    } catch {
      vecHits = []; // 埋め込み失敗時は FTS のみ
    }
  }
  const vecById = new Map(vecHits.map((o) => [o.id, o]));

  // どちらも空: LIKE フォールバック結果（rank=null）をそのまま返す
  if (!ftsHits.length && !vecHits.length) return { hits: [], mode: 'none' };
  if (!vecHits.length) {
    return { hits: ftsHits.slice(0, limit).map((o) => ({ ...o, fused: null })), mode: usedFts ? 'fts' : 'like' };
  }
  if (!ftsHits.length) {
    return { hits: vecHits.slice(0, limit).map((o) => ({ ...o, fused: o.sim })), mode: 'vector' };
  }

  // RRF 融合
  const fScores = rrfScores(ftsHits.map((o) => o.id));
  const vScores = rrfScores(vecHits.map((o) => o.id));
  const ids = new Set([...fScores.keys(), ...vScores.keys()]);
  const fused = [];
  for (const id of ids) {
    const o = ftsById.get(id) || vecById.get(id);
    const score = (fScores.get(id) || 0) + (vScores.get(id) || 0);
    fused.push({ ...o, fused: score, rank: ftsById.get(id)?.rank ?? null, sim: vecById.get(id)?.sim ?? null });
  }
  fused.sort((a, b) => b.fused - a.fused);
  return { hits: fused.slice(0, limit), mode: 'hybrid' };
}
