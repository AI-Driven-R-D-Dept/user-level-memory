// ハイブリッド想起: FTS5(BM25, 字句) と 埋め込み(cosine, 意味) を融合する。
// 外部評価(作者非依存)の結果、等重み RRF は強い vector を弱い FTS が引き下げ hybrid<vector に
// なることが判明したため、融合は「vector の順位を完全保持し、FTS 固有ヒットだけ末尾に救済追加」する
// vector-primary 方式に変更した（RRF ではない）。埋め込みが無い環境では FTS のみ（degrade gracefully）。
//
// 字句一致(trigram)は「vocab_size」のような特異トークンに強いが同義語・言い換えに弱い。
// 埋め込みは「スタイルが反映されない⇄クラスが効かない」のような意味的近接を拾う。
import { embedAvailable, embedTexts, cosine } from './embed.js';
import { compileGate, detectHighEntropy } from './gate.js';

const RRF_K = 60; // FTS 固有ヒットの末尾並べ替えにのみ使用

/** 読み取り時ゲート: secret=0 でも本文が機密パターン/高エントロピーなら注入候補から除外（多層防御） */
function readSafe(gate, o) {
  return !gate.match(o.text) && !detectHighEntropy(o.text);
}

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
  // 二段の精度ガード（外部評価で minSim を下げると無関係クエリにノイズ注入される問題への対策）:
  //  - injectMin: 最良ヒットの sim がこれ未満なら「関連記憶なし」として全棄権（無関係プロンプトに注入しない）
  //  - minSim: 棄権しない場合に、候補として残す下限（最良ヒットからの相対バンドの床）
  // これで「強い一致があるときだけ、その近傍も含めて注入」「弱いだけのときは何も出さない」を両立。
  const injectMin = config.context?.recall_inject_min ?? 0.3;
  const minSim = config.context?.recall_min_sim ?? 0.22;
  // 読み取り時ゲート: secret=0 でも本文が機密なら除外。import/legacy/別書き込み経路で
  // secret フラグが付かなかった機密が注入チャネルに乗るのを機械的に止める（多層防御）。
  const gate = compileGate(config);
  const ftsOpts = { query: q, scopes, includeSecret: false, includeArchived: false, limit: candidateK };

  let ftsHits = store.searchObservations(ftsOpts).filter((o) => readSafe(gate, o));
  const ftsById = new Map(ftsHits.map((o) => [o.id, o]));
  const usedFts = ftsHits.length && ftsHits[0].rank != null;

  let vecHits = [];
  // M2 対策: クエリ（生プロンプト）が機密を含むなら外部 embeddings API に送らない。
  // 書込観測はゲート済みでも、ライブクエリは無検査だった＝プロンプト内の鍵が平文 exfil されうる。
  const querySafe = !gate.match(q) && !detectHighEntropy(q);
  if (querySafe && embedAvailable(config) && store.embeddingCount() > 0) {
    try {
      const [qv] = await embedTexts([q], config);
      const qvec = Float32Array.from(qv);
      vecHits = store.vectorSearch(qvec, { scopes, includeSecret: false, includeArchived: false, limit: candidateK, cosine });
      vecHits = vecHits.filter((o) => readSafe(gate, o));
      // 棄権: 最良 sim が injectMin 未満なら vector は「確信ある一致なし」として捨てる（ノイズ注入を防ぐ）
      if (!vecHits.length || vecHits[0].sim < injectMin) vecHits = [];
      else vecHits = vecHits.filter((o) => o.sim >= minSim); // 確信ありなら近傍バンドを残す
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

  // 融合: 外部評価(作者非依存)で、等重み RRF は強い vector の順位を弱い FTS が引き下げ
  // hybrid < vector になることが判明した。そこで「vector 主軸 + FTS は取りこぼし救済」にする:
  //  - 両方に出る項目は vector の順位を尊重（agreement で僅かに前進）
  //  - vector が拾えなかった FTS 固有ヒットだけ末尾に足す（exact/typo の救済。Recall は落とさない）
  // これで hybrid は ranking で vector を下回らず、かつ FTS 固有の救済も保てる。
  return { hits: fuseVectorPrimary(vecHits, ftsHits, ftsById).slice(0, limit), mode: 'hybrid' };
}

/**
 * 融合: vector の順位を完全保持し、FTS 固有ヒットだけ末尾に救済追加する。
 * 外部評価(作者非依存)で「等重み RRF は強い vector を弱い FTS が引き下げ hybrid<vector」
 * が判明したため、ranking で vector を下回らないことを構造的に保証する設計に変更。
 * @returns {object[]} 融合済み（vector 順 → FTS 固有の順）
 */
export function fuseVectorPrimary(vecHits, ftsHits, ftsById = new Map()) {
  const fScores = rrfScores(ftsHits.map((o) => o.id));
  const fused = [];
  const seen = new Set();
  vecHits.forEach((o, i) => {
    seen.add(o.id);
    fused.push({ ...o, fused: 1 / (i + 1), rank: ftsById.get(o.id)?.rank ?? null, sim: o.sim });
  });
  for (const o of ftsHits) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    fused.push({ ...o, fused: -1 + (fScores.get(o.id) || 0), rank: o.rank, sim: null });
  }
  return fused;
}
