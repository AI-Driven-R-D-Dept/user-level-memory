// SQLite ストレージ層（node:sqlite、ネイティブ依存ゼロ）
import { DatabaseSync } from 'node:sqlite';
import { newId, hypothesisHash } from './ids.js';
import { nowIso, parseJsonSafe } from './util.js';
import { dbPath } from './config.js';

const SCHEMA_VERSION = 2;

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

/** スキーマを最新版へ。BASE は IF NOT EXISTS なので新規/既存どちらでも安全。 */
function migrate(db) {
  db.exec(BASE_SCHEMA);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  let version = row ? Number(row.value) : 0;

  // v1 → v2: 既存 DB に後付けカラムを足す（新規 DB は BASE で既に揃っている）
  if (version < 2) {
    if (!columnExists(db, 'states', 'secret')) {
      db.exec("ALTER TABLE states ADD COLUMN secret INTEGER NOT NULL DEFAULT 0");
    }
    if (!columnExists(db, 'observations', 'pinned')) {
      db.exec("ALTER TABLE observations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    }
    if (!columnExists(db, 'observations', 'redacted')) {
      db.exec("ALTER TABLE observations ADD COLUMN redacted INTEGER NOT NULL DEFAULT 0");
    }
    if (!columnExists(db, 'observations', 'archived')) {
      db.exec("ALTER TABLE observations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    }
  }
  // 新規 DB の BASE_SCHEMA は v1 形なので、ここで pinned/redacted/archived を必ず保証
  for (const col of ['pinned', 'redacted', 'archived']) {
    if (!columnExists(db, 'observations', col)) {
      db.exec(`ALTER TABLE observations ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
    }
  }

  version = SCHEMA_VERSION;
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version));
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
    const where = `WHERE ${cond.join(' AND ')}`;
    const rows = this.db
      .prepare(`SELECT * FROM observations ${where} ORDER BY ts DESC, id LIMIT ?`)
      .all(...params, limit);
    let out = rows.map(rowToObs);
    if (tags && tags.length) out = out.filter((o) => o.tags.some((t) => tags.includes(t)));
    return out;
  }

  countObservations() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM observations WHERE redacted = 0').get().n;
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

  /** 候補の編集（条件を磨く / メモ追記）。inbox か approved のみ */
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
    const placeholders = cols.map(() => '?').join(', ');
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`);
    for (const r of rows) {
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
