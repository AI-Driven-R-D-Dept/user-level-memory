import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWebServer, runReadonlyQuery } from '../src/webapp.js';
import { withFreshStoreAsync, testConfig } from './helpers.js';

/** サーバを立てて fn(ctx) を実行し、確実に閉じる */
async function withServer(store, home, fn, config = testConfig()) {
  const { server, port, token, url } = await startWebServer(store, config, home, { port: 0 });
  const base = `http://127.0.0.1:${port}`;
  const call = (path, { method = 'GET', body, headers = {} } = {}) =>
    fetch(base + path, {
      method,
      headers: { 'x-ulm-token': token, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    await fn({ base, token, url, call });
  } finally {
    server.close();
  }
}

test('webapp: token 無し/不正は 401（API 直叩きで人間操作を偽装できない）', async () => {
  await withFreshStoreAsync(async (store, home) => {
    await withServer(store, home, async ({ base }) => {
      const noToken = await fetch(`${base}/api/obs`);
      assert.equal(noToken.status, 401);
      const badToken = await fetch(`${base}/api/obs`, { headers: { 'x-ulm-token': 'ff'.repeat(16) } });
      assert.equal(badToken.status, 401);
      const page = await fetch(`${base}/`);
      assert.equal(page.status, 401);
      // 変更系も同様
      const mut = await fetch(`${base}/api/cand/review`, { method: 'POST', body: '{}' });
      assert.equal(mut.status, 401);
    });
  });
});

test('webapp: Host ヘッダ検証（DNS rebinding 対策）', async () => {
  await withFreshStoreAsync(async (store, home) => {
    await withServer(store, home, async ({ base, token }) => {
      // fetch は Host を偽装できないため生の http.request で再現する
      const { request } = await import('node:http');
      const port = Number(new URL(base).port);
      const status = await new Promise((resolveStatus, reject) => {
        const req = request(
          { host: '127.0.0.1', port, path: '/api/obs', headers: { host: 'evil.example.com', 'x-ulm-token': token } },
          (res) => { res.resume(); resolveStatus(res.statusCode); }
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 403);
    });
  });
});

test('webapp: obs の追加は入口ゲートを通る（機密パターンは自動 secret）', async () => {
  await withFreshStoreAsync(async (store, home) => {
    await withServer(store, home, async ({ call }) => {
      const r = await (await call('/api/obs', { method: 'POST', body: { text: 'key は sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX だ' } })).json();
      assert.equal(r.obs.secret, true);
      assert.ok(r.notes.length >= 1);
      const ok = await (await call('/api/obs', { method: 'POST', body: { text: '普通の観測テキストです', tags: ['a'] } })).json();
      assert.equal(ok.obs.secret, false);
      assert.equal(ok.obs.source, 'web');
    });
  });
});

test('webapp: フラグ・redact・タグ・state・ref の編集 API が動く', async () => {
  await withFreshStoreAsync(async (store, home) => {
    const o = store.addObservation({ text: '編集対象の観測', project: null });
    store.setState('担当', 'デモ', { scope: 'global' });
    await withServer(store, home, async ({ call }) => {
      // フラグ
      const pin = await (await call('/api/obs/flags', { method: 'POST', body: { id: o.id, pinned: true } })).json();
      assert.equal(pin.obs.pinned, true);
      // タグ
      const tag = await (await call('/api/obs/tags', { method: 'POST', body: { id: o.id, tags: ['x', 'y'] } })).json();
      assert.deepEqual(tag.obs.tags, ['x', 'y']);
      // redact
      const red = await (await call('/api/obs/redact', { method: 'POST', body: { id: o.id } })).json();
      assert.equal(red.obs.redacted, true);
      assert.equal(red.obs.text, '[redacted]');
      // state 上書き + 削除
      const st = await (await call('/api/state', { method: 'POST', body: { key: '担当', value: '新値', scope: 'global' } })).json();
      assert.equal(st.state.value, '新値');
      assert.equal((await call('/api/state/delete', { method: 'POST', body: { key: '担当', scope: 'global' } })).status, 200);
      // ref: 危険パスは拒否、正当パスは追加できる
      const bad = await call('/api/ref/add', { method: 'POST', body: { path: `${home}/../CLAUDE.md` } });
      assert.equal(bad.status, 400);
      const good = await (await call('/api/ref/add', { method: 'POST', body: { path: `${home}/ref/rules.md`, note: 'n' } })).json();
      assert.ok(good.ref.id.startsWith('ref-'));
      assert.equal((await call('/api/ref/rm', { method: 'POST', body: { id: good.ref.id } })).status, 200);
    });
  });
});

test('webapp: 候補レビューは inbox のみ・promote エンドポイントは存在しない', async () => {
  await withFreshStoreAsync(async (store, home) => {
    const c1 = store.addCandidate({ hypothesis: '仮説A', origin: 'manual' });
    const c2 = store.addCandidate({ hypothesis: '仮説B', origin: 'manual' });
    await withServer(store, home, async ({ call }) => {
      const ok = await (await call('/api/cand/review', { method: 'POST', body: { id: c1.id, status: 'approved' } })).json();
      assert.equal(ok.cand.status, 'approved');
      // approved を再レビューは拒否
      const again = await call('/api/cand/review', { method: 'POST', body: { id: c1.id, status: 'rejected' } });
      assert.equal(again.status, 400);
      // promoted へは遷移できない（status 制限）
      const promo = await call('/api/cand/review', { method: 'POST', body: { id: c2.id, status: 'promoted' } });
      assert.equal(promo.status, 400);
      // promote 用エンドポイント自体が無い
      const ep = await call('/api/cand/promote', { method: 'POST', body: { id: c2.id } });
      assert.equal(ep.status, 404);
      // 条件編集
      const ed = await (await call('/api/cand/edit', { method: 'POST', body: { id: c2.id, conditions: '条件C' } })).json();
      assert.equal(ed.cand.conditions, '条件C');
    });
  });
});

test('webapp: SQL は SELECT のみ・読み取り専用接続（書込はどの経路でも失敗）', async () => {
  await withFreshStoreAsync(async (store, home) => {
    store.addObservation({ text: 'SQLタブから見える観測', project: null });
    await withServer(store, home, async ({ call }) => {
      const ok = await (await call('/api/sql', { method: 'POST', body: { query: 'SELECT id, text FROM observations' } })).json();
      assert.equal(ok.rows.length, 1);
      assert.deepEqual(ok.columns, ['id', 'text']);
      // 非 SELECT・複数文は拒否
      for (const q of ['DELETE FROM observations', 'PRAGMA journal_mode=DELETE', "SELECT 1; DELETE FROM observations", 'INSERT INTO refs VALUES (1,2,3,4)']) {
        const r = await call('/api/sql', { method: 'POST', body: { query: q } });
        assert.equal(r.status, 400, `拒否されるべき: ${q}`);
      }
    });
  });
});

test('runReadonlyQuery: readOnly 接続なので SELECT を装った書込も DB 層で失敗する', async () => {
  await withFreshStoreAsync(async (store, home) => {
    store.addObservation({ text: 'x', project: null });
    // CTE 等で書込はそもそも構文的に SELECT 始まりにできないが、readOnly の保証も確認
    const r = runReadonlyQuery(home, 'SELECT count(*) AS n FROM observations');
    assert.equal(r.rows[0].n, 1);
    assert.throws(() => runReadonlyQuery(home, 'select 1 attach database \'/tmp/x\' as y'), /./);
  });
});

test('webapp: GET /api/obs は本文が機密の観測に sensitive を立てる（読み取り時ゲート）', async () => {
  await withFreshStoreAsync(async (store, home) => {
    // secret フラグ無しで保存された機密本文（import/legacy 経路を再現）
    store.importRows('observations', [{ id: 'obs-leak99', ts: new Date().toISOString(), project: null, text: '鍵は sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX', tags: '[]', source: 'import', secret: 0, meta: '{}', pinned: 0, redacted: 0, archived: 0 }]);
    const safe = store.addObservation({ text: '普通の観測テキスト', project: null });
    await withServer(store, home, async ({ call }) => {
      const r = await (await call('/api/obs')).json();
      const leak = r.obs.find((o) => o.id === 'obs-leak99');
      const ok = r.obs.find((o) => o.id === safe.id);
      assert.equal(leak.sensitive, true, 'secret=0 でも本文が機密なら sensitive');
      assert.equal(ok.sensitive, false, '無害な観測は sensitive=false');
    });
  });
});

test('webapp: readBody は TCP 分割された UTF-8 マルチバイトを壊さない（記憶完全性）', async () => {
  await withFreshStoreAsync(async (store, home) => {
    await withServer(store, home, async ({ base, token }) => {
      const { request } = await import('node:http');
      const port = Number(new URL(base).port);
      const payload = Buffer.from(JSON.stringify({ text: 'A日本語のメモB', tags: ['x'] }), 'utf8');
      // 「日」(UTF-8 3バイト) の途中で2つの TCP write に分割する
      const splitAt = payload.indexOf(Buffer.from('日', 'utf8')) + 1;
      const obs = await new Promise((res, rej) => {
        const req = request(
          { host: '127.0.0.1', port, path: '/api/obs', method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ulm-token': token, 'content-length': payload.length } },
          (r) => { let d = ''; r.on('data', (x) => (d += x)); r.on('end', () => res(JSON.parse(d))); }
        );
        req.on('error', rej);
        req.write(payload.subarray(0, splitAt));
        setTimeout(() => req.end(payload.subarray(splitAt)), 20);
      });
      assert.equal(obs.obs.text, 'A日本語のメモB', '分割された日本語が壊れずに保存される');
    });
  });
});

test('webapp: GET /api/states も本文機密に sensitive を立てる（obs と一様な読み取り時ゲート）', async () => {
  await withFreshStoreAsync(async (store, home) => {
    // secret フラグ無しで機密値が入った state（import/後付け deny を再現）
    store.setState('leaked', '鍵は sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX', { scope: 'global' });
    store.setState('safe', '東京・自宅', { scope: 'global' });
    await withServer(store, home, async ({ call }) => {
      const r = await (await call('/api/states')).json();
      const leak = r.states.find((x) => x.key === 'leaked');
      const safe = r.states.find((x) => x.key === 'safe');
      assert.equal(leak.sensitive, true, 'secret=0 でも機密値なら sensitive');
      assert.equal(safe.sensitive, false, '無害な値は sensitive=false');
    });
  });
});
