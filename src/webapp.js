// ローカル Web UI サーバ — DB の閲覧・編集（依存ゼロ: node:http のみ）
//
// セキュリティ前提（DESIGN.md §7.5）:
//  - 127.0.0.1 バインドのみ。リモート公開はスコープ外。
//  - 起動ごとのランダムトークン必須: GET / は ?token=、/api/* は x-ulm-token ヘッダ。
//    トークンは起動した端末にだけ表示されるため、ブラウザ以外のローカルプロセス
//    （エージェント等）が API を直叩きして approve 等の人間操作を偽装するのを防ぐ
//    （`--yes` と同等の信頼境界: ulm web を起動した人間が操作している）。
//  - Host ヘッダ検証（DNS rebinding 対策）+ 変更系はカスタムヘッダ必須なので CSRF も成立しない。
//  - SQL タブは読み取り専用接続（readOnly）+ 単一 SELECT のみの二重の壁。
//  - promote は出さない（/ulm:promote の領分）。観測本文の編集も出さない（追記のみ・訂正は redact）。
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { dbPath } from './config.js';
import { compileGate, detectHighEntropy } from './gate.js';
import { checkWriteTarget } from './safepath.js';
import { parseTtl } from './util.js';

const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'webapp', 'index.html');
const MAX_BODY = 64 * 1024;
const SQL_ROW_CAP = 500;

/** cli.gateWrite と同じ入口ゲート（webapp は cli を import できないため最小再実装） */
function entryGate(config, text, { explicitSecret = false } = {}) {
  const gate = compileGate(config);
  let secret = explicitSecret;
  const notes = [];
  const hit = gate.match(text);
  if (hit && !secret) {
    secret = true;
    notes.push(`機密パターン (${hit}) に一致したため secret として保存しました`);
  }
  if (!secret && detectHighEntropy(text) && config.gate?.entropy_secret !== false) {
    secret = true;
    notes.push('高エントロピー文字列を検出したため安全側に secret 化しました');
  }
  return { secret, notes };
}

function tokenOk(expected, got) {
  if (typeof got !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hostOk(req) {
  const host = String(req.headers.host || '');
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolveBody(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

/** SELECT のみ・単一文に制限した読み取り専用クエリ */
export function runReadonlyQuery(home, query) {
  const q = String(query || '').trim().replace(/;\s*$/, '');
  if (!/^select\b/i.test(q)) throw new Error('SELECT 文のみ実行できます');
  if (q.includes(';')) throw new Error('複数文は実行できません');
  const ro = new DatabaseSync(dbPath(home), { readOnly: true });
  try {
    const t0 = process.hrtime.bigint();
    const stmt = ro.prepare(q);
    const rows = stmt.all().slice(0, SQL_ROW_CAP);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { columns, rows, ms: Math.round(ms * 10) / 10, capped: rows.length === SQL_ROW_CAP };
  } finally {
    ro.close();
  }
}

/**
 * Web UI サーバを起動する。
 * @returns {{server: import('node:http').Server, url: string, token: string, port: number}}
 */
export function startWebServer(store, config, home, { host = '127.0.0.1', port = 8765 } = {}) {
  const token = randomBytes(16).toString('hex');
  let html = null; // 起動後の初回アクセス時に読む（テストでは API のみ使うことがある）

  const routes = {
    'GET /api/summary': () => {
      let dbBytes = 0;
      try { dbBytes = statSync(dbPath(home)).size; } catch { /* db 未作成 */ }
      return { home, dbBytes, schema: store.schemaVersion(), stats: store.stats() };
    },
    'GET /api/obs': () => ({
      // 人間オペレータ専用 UI（トークン保持者）なので secret も返す。表示側で既定マスク。
      obs: store.listObservations({ includeSecret: true, includeArchived: true, limit: 1000 }),
    }),
    'POST /api/obs': (body) => {
      const text = String(body.text || '').trim();
      if (!text) throw new Error('text が空です');
      const tags = (Array.isArray(body.tags) ? body.tags : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 10);
      const { secret, notes } = entryGate(config, text);
      const obs = store.addObservation({
        text,
        project: body.project ? String(body.project) : null,
        tags,
        source: 'web',
        secret,
        pinned: !!body.pin,
      });
      return { obs, notes };
    },
    'POST /api/obs/flags': (body) => {
      const flags = {};
      for (const k of ['secret', 'pinned', 'archived']) if (typeof body[k] === 'boolean') flags[k] = body[k];
      // store 側は対象が無ければ throw（→ 400 で返る）
      return { obs: store.setObservationFlags(String(body.id), flags) };
    },
    'POST /api/obs/redact': (body) => {
      const id = String(body.id);
      store.redactObservation(id); // 対象が無ければ throw
      return { obs: store.getObservation(id) };
    },
    'POST /api/obs/tags': (body) => {
      const tags = (Array.isArray(body.tags) ? body.tags : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 10);
      return { obs: store.setObservationTags(String(body.id), tags) };
    },
    'GET /api/states': () => ({ states: store.listStates({ includeExpired: true, includeSecret: true }) }),
    'POST /api/state': (body) => {
      const key = String(body.key || '').trim();
      const value = String(body.value ?? '');
      if (!key) throw new Error('key が空です');
      const ttlMs = body.ttl ? parseTtl(body.ttl) : null;
      if (body.ttl && ttlMs == null) throw new Error('TTL は 30m / 24h / 7d / 2w の形式です');
      const { secret } = entryGate(config, `${key}\n${value}`);
      const scope = body.scope ? String(body.scope) : 'global';
      store.setState(key, value, { scope, ttlMs, secret }); // setState は戻り値なし
      return { state: store.getState(key, { scope }) };
    },
    'POST /api/state/delete': (body) => {
      store.deleteState(String(body.key), { scope: body.scope ? String(body.scope) : 'global' });
      return {};
    },
    'GET /api/cands': () => ({ cands: store.listCandidates({}) }),
    'POST /api/cand/review': (body) => {
      const status = String(body.status);
      if (!['approved', 'rejected'].includes(status)) throw new Error('status は approved | rejected のみ');
      const cand = store.getCandidate(String(body.id));
      if (!cand) throw new Error('候補が見つかりません');
      if (cand.status !== 'inbox') throw new Error(`inbox の候補のみレビューできます（現在: ${cand.status}）`);
      // 人間ゲート: トークンは起動端末にだけ表示されるため、この操作は --yes と同等の明示指示とみなす
      return { cand: store.reviewCandidate(cand.id, status, String(body.note || '')) };
    },
    'POST /api/cand/edit': (body) => {
      const cand = store.editCandidate(String(body.id), {
        conditions: body.conditions !== undefined ? String(body.conditions) : undefined,
        note: body.note !== undefined ? String(body.note) : undefined,
      });
      if (!cand) throw new Error('候補が見つかりません');
      return { cand };
    },
    'GET /api/refs': () => ({
      refs: store.listRefs().map((r) => ({ ...r, missing: !existsSync(r.path) })),
    }),
    'POST /api/ref/add': (body) => {
      const target = resolve(String(body.path || ''));
      // cli ref add と同一の機械的パス検証（CLAUDE.md 等の自動読込ファイル・.git/.ssh・traversal を拒否）
      const check = checkWriteTarget(target, { refRoot: join(home, 'ref'), allowRoots: [process.cwd()] });
      if (!check.ok) throw new Error(`ref パスを拒否: ${check.reason}`);
      return { ref: store.addRef({ path: check.path, note: String(body.note || ''), project: body.project ? String(body.project) : null }) };
    },
    'POST /api/ref/rm': (body) => {
      const removed = store.removeRef(String(body.id));
      if (!removed) throw new Error('ref が見つかりません');
      return {};
    },
    'POST /api/sql': (body) => runReadonlyQuery(home, body.query),
  };

  const server = createServer(async (req, res) => {
    try {
      if (!hostOk(req)) return json(res, 403, { error: 'host が不正です（localhost のみ）' });
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && url.pathname === '/') {
        if (!tokenOk(token, url.searchParams.get('token'))) {
          return json(res, 401, { error: 'token が必要です。`ulm web` が表示した URL から開いてください' });
        }
        if (html === null) html = readFileSync(HTML_PATH, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }

      if (url.pathname.startsWith('/api/')) {
        if (!tokenOk(token, req.headers['x-ulm-token'])) return json(res, 401, { error: 'token が不正です' });
        const handler = routes[`${req.method} ${url.pathname}`];
        if (!handler) return json(res, 404, { error: 'not found' });
        const body = req.method === 'POST' ? await readBody(req) : {};
        const result = handler(body);
        return json(res, 200, { ok: true, ...result });
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  });

  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolveStart({ server, port: actual, token, url: `http://${host}:${actual}/?token=${token}` });
    });
  });
}
