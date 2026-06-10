// SQLite ストレージ層（node:sqlite、ネイティブ依存ゼロ）
import { DatabaseSync } from 'node:sqlite';
import { newId, hypothesisHash } from './ids.js';
import { nowIso, parseJsonSafe } from './util.js';
import { dbPath } from './config.js';
import { bufToVec, cosineFromBuf, l2norm } from './embed.js';

const SCHEMA_VERSION = 4;

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  project TEXT,
  text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  secret INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_obs_project_ts ON observations(project, ts);
CREATE TABLE IF NOT EXISTS states (
  key TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  secret INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, scope)
);
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'inbox',
  hypothesis TEXT NOT NULL,
  hyp_hash TEXT NOT NULL,
  conditions TEXT NOT NULL DEFAULT '',
  counterexamples TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '[]',
  origin TEXT NOT NULL,
  project TEXT,
  reviewed_at TEXT,
  promoted_to TEXT,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_cand_status ON candidates(status);
CREATE TABLE IF NOT EXISTS refs (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  project TEXT
);
`;

export function openStore(home) {
  const db = new DatabaseSync(dbPath(home));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;'); // 並行セッションの SQLITE_BUSY 対策
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return new Store(db);
}

function columnExists(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

/**
 * スキーマを最新版へ。BASE_SCHEMA は v1 形（observations に pinned/redacted/archived を含まない）。
 * 新規 DB・既存 v1 DB のどちらでも、不足カラムを冪等に追加して v2 に揃える。
 */
function migrate(db) {
  db.exec(BASE_SCHEMA);

  // 後付けカラムを冪等に保証（columnExists ガードで二重実行されない）
  if (!columnExists(db, 'states', 'secret')) {
    db.exec('ALTER TABLE states ADD COLUMN secret INTEGER NOT NULL DEFAULT 0');
  }
  for (const col of ['pinned', 'redacted', 'archived']) {
    if (!columnExists(db, 'observations', col)) {
      db.exec(`ALTER TABLE observations ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
    }
  }

  // v3: FTS5(trigram) による関連度想起。fts5 が無い環境では握りつぶして LIKE にフォールバック。
  ensureFts(db);

  // v4: 意味的想起のための埋め込みベクトル置き場（任意。OpenAI 互換 embeddings がある時だけ使う）
  db.exec(`CREATE TABLE IF NOT EXISTS obs_vec (
    obs_id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL,
    FOREIGN KEY (obs_id) REFERENCES observations(id) ON DELETE CASCADE
  );`);

  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(SCHEMA_VERSION));
}

/** FTS5 仮想テーブルとトリガを冪等に用意。未対応ビルドでは false を返し LIKE 検索に退避。 */
export function ftsAvailable(db) {
  try {
    return db.prepare("SELECT 1 FROM meta WHERE key='fts_ready'").get()?.['1'] === 1
      ? true
      : !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='obs_fts'").get();
  } catch {
    return false;
  }
}

function ensureFts(db) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE name='obs_fts'").get();
  if (exists) return true;
  try {
    db.exec(`CREATE VIRTUAL TABLE obs_fts USING fts5(obs_id UNINDEXED, text, tags, tokenize='trigram');`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS obs_fts_ai AFTER INSERT ON observations BEGIN
        INSERT INTO obs_fts(obs_id, text, tags) VALUES (new.id, new.text, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS obs_fts_ad AFTER DELETE ON observations BEGIN
        DELETE FROM obs_fts WHERE obs_id = old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS obs_fts_au AFTER UPDATE ON observations BEGIN
        DELETE FROM obs_fts WHERE obs_id = old.id;
        INSERT INTO obs_fts(obs_id, text, tags) VALUES (new.id, new.text, new.tags);
      END;`);
    // 既存行をバックフィル
    db.exec(`INSERT INTO obs_fts(obs_id, text, tags) SELECT id, text, tags FROM observations;`);
    return true;
  } catch {
    return false; // fts5 非対応ビルド: LIKE 検索のまま
  }
}

/** LIKE のワイルドカード（% _ \）をエスケープする（ESCAPE '\' と併用） */
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

/** trigram は3文字以上の連なりが必要。クエリが検索可能か。 */
function hasTrigramTerm(q) {
  return q.replace(/\s+/g, '').length >= 3;
}

/**
 * FTS5(trigram) の MATCH 文字列を作る。
 * trigram は「3文字の連続部分一致」なので、自然文クエリ（特に日本語=分かち書きなし）は
 * 重複トライグラムに分解して OR 連結する。BM25 が希少なトライグラムを高く重み付けるので、
 * 共通語（"します"等）でのノイズは順位で沈む。Latin の語(>=3)はフレーズとしても加える。
 */
function buildFtsMatch(q) {
  const norm = String(q).normalize('NFKC');
  const segs = norm.split(/\s+/).filter(Boolean);
  const phrases = new Set();
  const MAX = 50;
  for (const seg of segs) {
    const clean = seg.replace(/"/g, '');
    if (/^[\x20-\x7E]+$/.test(clean) && clean.replace(/[^\p{L}\p{N}]/gu, '').length >= 3) {
      phrases.add('"' + clean + '"'); // 英数語はそのままフレーズ化（より特異）
    }
    const chars = [...clean];
    for (let i = 0; i + 3 <= chars.length && phrases.size < MAX; i++) {
      const tri = chars.slice(i, i + 3).join('');
      if (/[\s"]/.test(tri)) continue;
      phrases.add('"' + tri + '"');
    }
    if (phrases.size >= MAX) break;
  }
  return phrases.size ? [...phrases].join(' OR ') : null;
}


function rowToObs(r) {
  return {
    ...r,
    tags: parseJsonSafe(r.tags, []),
    meta: parseJsonSafe(r.meta, {}),
    secret: !!r.secret,
    pinned: !!r.pinned,
    redacted: !!r.redacted,
    archived: !!r.archived,
  };
}

function rowToCand(r) {
  return {
    ...r,
    counterexamples: parseJsonSafe(r.counterexamples, []),
    evidence: parseJsonSafe(r.evidence, []),
  };
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  // ---- observations（追記が基本。訂正は redact=墓石化で表現） ----

  addObservation({ text, project = null, tags = [], source = 'manual', secret = false, meta = {}, pinned = false }) {
    if (!text || !String(text).trim()) throw new Error('観測テキストが空です');
    const stmt = this.db.prepare(
      'INSERT INTO observations (id, ts, project, text, tags, source, secret, meta, pinned, redacted, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)'
    );
    for (let i = 0; i < 5; i++) {
      const id = newId('obs');
      try {
        stmt.run(id, nowIso(), project, String(text).trim(), JSON.stringify(tags), source, secret ? 1 : 0, JSON.stringify(meta), pinned ? 1 : 0);
        return this.getObservation(id);
      } catch (err) {
        if (!/UNIQUE/.test(String(err))) throw err;
      }
    }
    throw new Error('ID 採番に失敗しました');
  }

  getObservation(id) {
    const r = this.db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
    return r ? rowToObs(r) : null;
  }

  /**
   * @param {object} opts
   *  project / days / tags / includeSecret / includeArchived / pinnedOnly / global / limit / query
   */
  listObservations({ project, days, tags, includeSecret = false, includeArchived = false, pinnedOnly = false, global: globalOnly = false, limit = 1000, query } = {}) {
    const cond = ['redacted = 0'];
    const params = [];
    if (globalOnly) cond.push('project IS NULL');
    else if (project) cond.push('project = ?'), params.push(project);
    if (days) {
      cond.push('ts >= ?');
      params.push(new Date(Date.now() - days * 86_400_000).toISOString());
    }
    if (!includeSecret) cond.push('secret = 0');
    if (!includeArchived) cond.push('archived = 0');
    if (pinnedOnly) cond.push('pinned = 1');
    if (query) {
      cond.push("LOWER(text) LIKE '%' || LOWER(?) || '%'");
      params.push(query);
    }
    // tags フィルタは LIMIT の前（SQL 側）で適用する。さもないとマッチが LIMIT で切り捨てられる。
    // tags は JSON 配列テキスト（例 ["a","b"]）なので、各タグを "tag" 形で LIKE 照合する。
    if (tags && tags.length) {
      const ors = [];
      for (const t of tags) {
        ors.push("tags LIKE ? ESCAPE '\\'");
        params.push(`%"${escapeLike(t)}"%`);
      }
      cond.push(`(${ors.join(' OR ')})`);
    }
    const where = `WHERE ${cond.join(' AND ')}`;
    const rows = this.db
      .prepare(`SELECT * FROM observations ${where} ORDER BY ts DESC, id LIMIT ?`)
      .all(...params, limit);
    return rows.map(rowToObs);
  }

  countObservations() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM observations WHERE redacted = 0').get().n;
  }

  hasFts() {
    return !!this.db.prepare("SELECT name FROM sqlite_master WHERE name='obs_fts'").get();
  }

  /**
   * 関連度（BM25）順の観測検索。FTS5(trigram) を使い、未対応なら LIKE にフォールバック。
   * クエリからトリグラム化できる語（>=3文字の連なり）を抽出して OR 検索する。
   * 返り値は listObservations と同形 + rank（小さいほど関連度高、LIKE 時は null）。
   */
  searchObservations({ query, project, global: globalOnly = false, tags, includeSecret = false, includeArchived = false, scopes = null, limit = 20 } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const useFts = this.hasFts() && hasTrigramTerm(q);
    if (useFts) {
      const match = buildFtsMatch(q);
      if (match) {
        try {
          // フィルタは SQL 側（WHERE）で適用。さもないと BM25 上位がスコープ外で埋まり
          // 本来のヒットが LIMIT で切られる（codex 指摘の取りこぼしバグ）。
          const cond = ['obs_fts MATCH ?', 'o.redacted = 0'];
          const params = [match];
          if (scopes && scopes.length) {
            cond.push(`(o.project IS NULL OR o.project IN (${scopes.map(() => '?').join(',')}))`);
            params.push(...scopes);
          } else if (globalOnly) cond.push('o.project IS NULL');
          else if (project) cond.push('o.project = ?'), params.push(project);
          if (!includeSecret) cond.push('o.secret = 0');
          if (!includeArchived) cond.push('o.archived = 0');
          if (tags && tags.length) {
            const ors = tags.map(() => "o.tags LIKE ? ESCAPE '\\'");
            cond.push(`(${ors.join(' OR ')})`);
            for (const t of tags) params.push(`%"${escapeLike(t)}"%`);
          }
          const rows = this.db
            .prepare(
              `SELECT o.*, bm25(obs_fts) AS rank
               FROM obs_fts JOIN observations o ON o.id = obs_fts.obs_id
               WHERE ${cond.join(' AND ')}
               ORDER BY rank LIMIT ?`
            )
            .all(...params, limit);
          return rows.map((r) => ({ ...rowToObs(r), rank: r.rank }));
        } catch {
          // FTS クエリ構文エラー時は LIKE へ
        }
      }
    }
    // フォールバック: LIKE 部分一致（関連度なし、recency 順）。
    // M5: scopes を必ず尊重する。FTS 経路は WHERE で scopes を絞るのに、ここで全 project を
    // 返すとプロジェクト分離が壊れる（短いクエリ/ fts5 非対応ビルドで常時この経路）。
    let out;
    if (scopes && scopes.length) {
      const seen = new Set();
      out = [];
      const wantGlobal = scopes.includes('global');
      const projScopes = scopes.filter((s) => s !== 'global');
      if (wantGlobal) {
        for (const o of this.listObservations({ global: true, tags, includeSecret, includeArchived, query: q, limit })) {
          if (!seen.has(o.id)) (seen.add(o.id), out.push(o));
        }
      }
      for (const p of projScopes) {
        for (const o of this.listObservations({ project: p, tags, includeSecret, includeArchived, query: q, limit })) {
          if (!seen.has(o.id)) (seen.add(o.id), out.push(o));
        }
      }
      out = out.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);
    } else {
      out = this.listObservations({ project: globalOnly ? undefined : project, global: globalOnly, tags, includeSecret, includeArchived, query: q, limit });
    }
    return out.map((o) => ({ ...o, rank: null }));
  }

  // ---- 埋め込み（意味的想起。任意） ----

  upsertEmbedding(obsId, model, vecBuf) {
    const dim = Math.floor(vecBuf.byteLength / 4);
    this.db
      .prepare('INSERT INTO obs_vec (obs_id, model, dim, vec) VALUES (?, ?, ?, ?) ON CONFLICT(obs_id) DO UPDATE SET model=excluded.model, dim=excluded.dim, vec=excluded.vec')
      .run(obsId, model, dim, vecBuf);
  }

  /** 埋め込み未作成・かつ非 secret・非 redacted の観測（埋め込み対象） */
  observationsNeedingEmbedding({ limit = 1000 } = {}) {
    return this.db
      .prepare(`SELECT o.id, o.text FROM observations o LEFT JOIN obs_vec v ON v.obs_id = o.id
                WHERE v.obs_id IS NULL AND o.secret = 0 AND o.redacted = 0 LIMIT ?`)
      .all(limit);
  }

  embeddingCount() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM obs_vec').get().n;
  }

  /** secret=0・非 redacted の全観測（id, text）。reindex の機密スキャン（修復）用。 */
  allNonSecretObs({ limit = 100000 } = {}) {
    return this.db.prepare('SELECT id, text FROM observations WHERE secret = 0 AND redacted = 0 LIMIT ?').all(limit);
  }

  deleteEmbedding(obsId) {
    return this.db.prepare('DELETE FROM obs_vec WHERE obs_id = ?').run(obsId).changes;
  }

  /** 全ベクトルを読み、cosine 上位を返す。フィルタは observations と JOIN して適用。 */
  vectorSearch(queryVec, { project, global: globalOnly, tags, includeSecret = false, includeArchived = false, scopes = null, limit = 20, cosine } = {}) {
    const cond = ['o.redacted = 0', 'v.obs_id = o.id'];
    const params = [];
    if (scopes && scopes.length) {
      cond.push(`(o.project IS NULL OR o.project IN (${scopes.map(() => '?').join(',')}))`);
      params.push(...scopes);
    } else if (globalOnly) cond.push('o.project IS NULL');
    else if (project) cond.push('o.project = ?'), params.push(project);
    if (!includeSecret) cond.push('o.secret = 0');
    if (!includeArchived) cond.push('o.archived = 0');
    if (tags && tags.length) {
      cond.push(`(${tags.map(() => "o.tags LIKE ? ESCAPE '\\'").join(' OR ')})`);
      for (const t of tags) params.push(`%"${escapeLike(t)}"%`);
    }
    const rows = this.db
      .prepare(`SELECT o.*, v.vec AS _vec, v.dim AS _dim FROM obs_vec v JOIN observations o ON ${cond.join(' AND ')}`)
      .all(...params);
    const qNorm = l2norm(queryVec); // クエリのノルムは全行共通なので一度だけ計算
    const scored = [];
    for (const r of rows) {
      // M6: 次元が一致しないベクトル（モデル変更で混在）は cosine を歪めるのでスキップ
      if (r._dim !== queryVec.length) continue;
      const { _vec, _dim, ...rest } = r;
      // 中間配列を作らず Buffer を直接 dot（スケール最適化）
      scored.push({ ...rowToObs(rest), sim: cosineFromBuf(queryVec, qNorm, _vec) });
    }
    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, limit);
  }

  /** 墓石化（追記専用を保ちつつ訂正・機密の事後消去を可能にする） */
  redactObservation(id) {
    const o = this.getObservation(id);
    if (!o) throw new Error(`観測が見つかりません: ${id}`);
    this.db.prepare("UPDATE observations SET redacted = 1, text = '[redacted]', meta = '{}' WHERE id = ?").run(id);
    return true;
  }

  setObservationFlags(id, { secret, pinned, archived } = {}) {
    const o = this.getObservation(id);
    if (!o) throw new Error(`観測が見つかりません: ${id}`);
    const sets = [];
    const params = [];
    if (secret !== undefined) sets.push('secret = ?'), params.push(secret ? 1 : 0);
    if (pinned !== undefined) sets.push('pinned = ?'), params.push(pinned ? 1 : 0);
    if (archived !== undefined) sets.push('archived = ?'), params.push(archived ? 1 : 0);
    if (!sets.length) return o;
    this.db.prepare(`UPDATE observations SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return this.getObservation(id);
  }

  archiveObservationsBefore(iso) {
    return this.db.prepare("UPDATE observations SET archived = 1 WHERE ts < ? AND archived = 0 AND redacted = 0").run(iso).changes;
  }

  setObservationTags(id, tags) {
    const o = this.getObservation(id);
    if (!o) throw new Error(`観測が見つかりません: ${id}`);
    this.db.prepare('UPDATE observations SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id);
    return this.getObservation(id);
  }

  // ---- states（上書き + TTL。期限切れは読み取り時に無視。secret 列あり） ----

  setState(key, value, { scope = 'global', ttlMs = null, secret = false } = {}) {
    if (!key || !String(key).trim()) throw new Error('state キーが空です');
    const expires = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null;
    this.db
      .prepare(
        `INSERT INTO states (key, scope, value, updated_at, expires_at, secret) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key, scope) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, expires_at = excluded.expires_at, secret = excluded.secret`
      )
      .run(String(key).trim(), scope, String(value), nowIso(), expires, secret ? 1 : 0);
  }

  getState(key, { scope = 'global' } = {}) {
    const r = this.db.prepare('SELECT * FROM states WHERE key = ? AND scope = ?').get(String(key).trim(), scope);
    if (!r) return null;
    if (r.expires_at && r.expires_at <= nowIso()) return null;
    return { ...r, secret: !!r.secret };
  }

  listStates({ includeExpired = false, includeSecret = true, scopes = null } = {}) {
    let rows = this.db.prepare('SELECT * FROM states ORDER BY scope, key').all().map((r) => ({ ...r, secret: !!r.secret }));
    if (!includeExpired) rows = rows.filter((r) => !r.expires_at || r.expires_at > nowIso());
    if (!includeSecret) rows = rows.filter((r) => !r.secret);
    if (scopes) rows = rows.filter((r) => scopes.includes(r.scope));
    return rows;
  }

  deleteState(key, { scope = 'global' } = {}) {
    return this.db.prepare('DELETE FROM states WHERE key = ? AND scope = ?').run(String(key).trim(), scope).changes;
  }

  // ---- candidates（遊び場。inbox 隔離・自動注入なし） ----

  addCandidate({ hypothesis, conditions = '', counterexamples = [], evidence = [], origin = 'manual', project = null, note = '' }) {
    if (!hypothesis || !String(hypothesis).trim()) throw new Error('仮説が空です');
    const hash = hypothesisHash(hypothesis);
    const dup = this.db.prepare('SELECT id, status FROM candidates WHERE hyp_hash = ?').get(hash);
    if (dup) return { duplicateOf: dup.id, status: dup.status };
    const stmt = this.db.prepare(
      `INSERT INTO candidates (id, ts, status, hypothesis, hyp_hash, conditions, counterexamples, evidence, origin, project, note)
       VALUES (?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < 5; i++) {
      const id = newId('cand');
      try {
        stmt.run(
          id, nowIso(), String(hypothesis).trim(), hash, String(conditions),
          JSON.stringify(counterexamples), JSON.stringify(evidence), origin, project, note
        );
        return this.getCandidate(id);
      } catch (err) {
        if (!/UNIQUE/.test(String(err))) throw err;
      }
    }
    throw new Error('ID 採番に失敗しました');
  }

  getCandidate(id) {
    const r = this.db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
    return r ? rowToCand(r) : null;
  }

  listCandidates({ status, project } = {}) {
    const cond = [];
    const params = [];
    if (status) cond.push('status = ?'), params.push(status);
    if (project) cond.push('project = ?'), params.push(project);
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM candidates ${where} ORDER BY ts DESC`).all(...params).map(rowToCand);
  }

  /** 候補の編集（条件を磨く / メモ追記）。promoted（昇格済み）以外なら編集可 */
  editCandidate(id, { conditions, note, counterexamples } = {}) {
    const c = this.getCandidate(id);
    if (!c) throw new Error(`候補が見つかりません: ${id}`);
    if (c.status === 'promoted') throw new Error(`昇格済みの候補は編集できません: ${id}`);
    const sets = [];
    const params = [];
    if (conditions !== undefined) sets.push('conditions = ?'), params.push(String(conditions));
    if (note !== undefined) sets.push('note = ?'), params.push(String(note));
    if (counterexamples !== undefined) sets.push('counterexamples = ?'), params.push(JSON.stringify(counterexamples));
    if (!sets.length) return c;
    this.db.prepare(`UPDATE candidates SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return this.getCandidate(id);
  }

  reviewCandidate(id, status, note = '') {
    const cand = this.getCandidate(id);
    if (!cand) throw new Error(`候補が見つかりません: ${id}`);
    if (!['approved', 'rejected'].includes(status)) throw new Error(`不正な status: ${status}`);
    if (cand.status === 'promoted') throw new Error(`昇格済みの候補は変更できません: ${id}`);
    this.db
      .prepare('UPDATE candidates SET status = ?, reviewed_at = ?, note = ? WHERE id = ?')
      .run(status, nowIso(), note || cand.note, id);
    return this.getCandidate(id);
  }

  markPromoted(id, promotedTo) {
    this.db.prepare("UPDATE candidates SET status = 'promoted', promoted_to = ? WHERE id = ?").run(promotedTo, id);
    return this.getCandidate(id);
  }

  rejectStale(days) {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.db.prepare("UPDATE candidates SET status = 'rejected', reviewed_at = ?, note = note || ' [stale auto-reject]' WHERE status = 'inbox' AND ts < ?").run(nowIso(), cutoff).changes;
  }

  inboxCount() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE status = 'inbox'").get().n;
  }

  oldestInboxDays() {
    const r = this.db.prepare("SELECT MIN(ts) AS t FROM candidates WHERE status = 'inbox'").get();
    if (!r || !r.t) return null;
    return Math.floor((Date.now() - new Date(r.t).getTime()) / 86_400_000);
  }

  // ---- refs（正式ルールへのポインタだけを持つ） ----

  addRef({ path, note = '', project = null }) {
    const existing = this.db.prepare('SELECT * FROM refs WHERE path = ?').get(path);
    if (existing) return existing;
    for (let i = 0; i < 5; i++) {
      const id = newId('ref');
      try {
        this.db.prepare('INSERT INTO refs (id, path, note, project) VALUES (?, ?, ?, ?)').run(id, path, note, project);
        return this.db.prepare('SELECT * FROM refs WHERE id = ?').get(id);
      } catch (err) {
        if (!/UNIQUE/.test(String(err))) throw err;
      }
    }
    throw new Error('ID 採番に失敗しました');
  }

  listRefs({ project } = {}) {
    if (project) {
      return this.db.prepare('SELECT * FROM refs WHERE project IS NULL OR project = ? ORDER BY id').all(project);
    }
    return this.db.prepare('SELECT * FROM refs ORDER BY id').all();
  }

  removeRef(idOrPath) {
    return this.db.prepare('DELETE FROM refs WHERE id = ? OR path = ?').run(idOrPath, idOrPath).changes;
  }

  // ---- export 用 ----

  allRows(table) {
    const order = {
      observations: 'ts, id',
      states: 'scope, key',
      candidates: 'ts, id',
      refs: 'id',
    }[table];
    if (!order) throw new Error(`unknown table: ${table}`);
    return this.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
  }

  importRows(table, rows) {
    let inserted = 0;
    const cols = {
      observations: ['id', 'ts', 'project', 'text', 'tags', 'source', 'secret', 'meta', 'pinned', 'redacted', 'archived'],
      states: ['key', 'scope', 'value', 'updated_at', 'expires_at', 'secret'],
      candidates: ['id', 'ts', 'status', 'hypothesis', 'hyp_hash', 'conditions', 'counterexamples', 'evidence', 'origin', 'project', 'reviewed_at', 'promoted_to', 'note'],
      refs: ['id', 'path', 'note', 'project'],
    }[table];
    if (!cols) throw new Error(`unknown table: ${table}`);
    // id/source の形式を検証する（取込データが注入チャネルに乗る前段の防御）
    const idRe = { observations: /^obs-[0-9a-z]{4,12}$/, candidates: /^cand-[0-9a-z]{4,12}$/, refs: /^ref-[0-9a-z]{4,12}$/ }[table];
    const placeholders = cols.map(() => '?').join(', ');
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`);
    for (const r of rows) {
      if (idRe && !idRe.test(String(r.id ?? ''))) continue; // 不正 id の行は捨てる
      if (table === 'observations' && r.source !== undefined && !/^[a-zA-Z0-9:_-]{1,40}$/.test(String(r.source))) {
        r.source = 'import'; // 不正 source は固定値に矯正
      }
      const vals = cols.map((c) => (r[c] === undefined ? null : r[c]));
      try {
        if (stmt.run(...vals).changes) inserted++;
      } catch {
        // 壊れた行はスキップ
      }
    }
    return inserted;
  }

  stats() {
    const obsTotal = this.db.prepare('SELECT COUNT(*) AS n FROM observations WHERE redacted = 0').get().n;
    return {
      observations: obsTotal,
      secret_observations: this.db.prepare('SELECT COUNT(*) AS n FROM observations WHERE secret = 1 AND redacted = 0').get().n,
      pinned_observations: this.db.prepare('SELECT COUNT(*) AS n FROM observations WHERE pinned = 1 AND redacted = 0').get().n,
      archived_observations: this.db.prepare('SELECT COUNT(*) AS n FROM observations WHERE archived = 1 AND redacted = 0').get().n,
      states: this.listStates().length,
      secret_states: this.db.prepare('SELECT COUNT(*) AS n FROM states WHERE secret = 1').get().n,
      candidates_inbox: this.inboxCount(),
      candidates_approved: this.db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE status = 'approved'").get().n,
      candidates_promoted: this.db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE status = 'promoted'").get().n,
      candidates_rejected: this.db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE status = 'rejected'").get().n,
      refs: this.db.prepare('SELECT COUNT(*) AS n FROM refs').get().n,
    };
  }

  schemaVersion() {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return r ? Number(r.value) : 0;
  }
}
