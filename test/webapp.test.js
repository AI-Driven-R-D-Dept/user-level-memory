import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWebServer, runReadonlyQuery, normalizeHost, hostOk } from '../src/webapp.js';
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

/** 生の http.request で Host ヘッダを偽装して status を得る（fetch は Host を上書きできない） */
async function statusWithHost(port, hostHeader, token) {
  const { request } = await import('node:http');
  return new Promise((resolveStatus, reject) => {
    const headers = { host: hostHeader };
    if (token) headers['x-ulm-token'] = token;
    const req = request({ host: '127.0.0.1', port, path: '/api/summary', headers }, (res) => {
      res.resume();
      resolveStatus(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

test('webapp: allowedHosts に渡した MagicDNS 名は Host 検証を通る（tailnet 直アクセス）', async () => {
  await withFreshStoreAsync(async (store, home) => {
    const { server, port, token } = await startWebServer(store, testConfig(), home, {
      port: 0,
      allowedHosts: ['node.tailnet.ts.net'],
    });
    try {
      assert.equal(await statusWithHost(port, 'node.tailnet.ts.net:8765', token), 200); // ポート付きでも一致
      assert.equal(await statusWithHost(port, 'NODE.TAILNET.TS.NET', token), 200); // 大小無視
      assert.equal(await statusWithHost(port, 'evil.example.com', token), 403); // 非許可は依然 403
    } finally {
      server.close();
    }
  });
});

test('webapp: normalizeHost は 末尾ドット/:port/[ipv6]/大小を正規化し、裸IPv6を壊さない', () => {
  assert.equal(normalizeHost('Node.TS.net:8765'), 'node.ts.net');
  assert.equal(normalizeHost('node.ts.net.'), 'node.ts.net'); // 絶対FQDNの末尾ドット
  assert.equal(normalizeHost('[fd7a::1]:8765'), 'fd7a::1');
  assert.equal(normalizeHost('[fd7a::1]'), 'fd7a::1');
  assert.equal(normalizeHost('fd7a::1'), 'fd7a::1'); // 裸IPv6: 末尾を :port と誤認しない
  assert.equal(normalizeHost('100.100.90.41:9000'), '100.100.90.41');
});

test('webapp: hostOk は loopback Host を「実接続が loopback のときだけ」信頼（ヘッダ偽装を拒否）', () => {
  const allow = new Set(['node.ts.net']);
  // 偽装: 非loopback の peer から Host: localhost / 127.0.0.1 を送っても拒否
  assert.equal(hostOk({ headers: { host: 'localhost' }, socket: { remoteAddress: '100.64.0.5' } }, allow), false);
  assert.equal(hostOk({ headers: { host: '127.0.0.1:8765' }, socket: { remoteAddress: '100.64.0.5' } }, allow), false);
  // 実 loopback からの loopback Host は許可
  assert.equal(hostOk({ headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } }, allow), true);
  assert.equal(hostOk({ headers: { host: '[::1]:8765' }, socket: { remoteAddress: '::1' } }, allow), true);
  // allowlist 一致は peer に依らず許可（末尾ドットも吸収）／非許可は拒否
  assert.equal(hostOk({ headers: { host: 'node.ts.net' }, socket: { remoteAddress: '100.64.0.5' } }, allow), true);
  assert.equal(hostOk({ headers: { host: 'node.ts.net.' }, socket: { remoteAddress: '100.64.0.5' } }, allow), true);
  assert.equal(hostOk({ headers: { host: 'evil.example.com' }, socket: { remoteAddress: '100.64.0.5' } }, allow), false);
});

test('webapp: 許可ホストは :port/大小を正規化して一致する（allowlist と hostOk のズレ防止）', async () => {
  await withFreshStoreAsync(async (store, home) => {
    // :port や大文字混じりで登録しても、Host 名部分で一致すること
    const { server, port, token } = await startWebServer(store, testConfig(), home, { port: 0, allowedHosts: ['Node.TS.net:9000'] });
    try {
      assert.equal(await statusWithHost(port, 'node.ts.net', token), 200); // port無し
      assert.equal(await statusWithHost(port, 'node.ts.net:1234', token), 200); // 別port
      assert.equal(await statusWithHost(port, 'other.ts.net', token), 403);
    } finally {
      server.close();
    }
  });
});

test('webapp: config.webapp.trusted_hosts も Host 許可に反映される', async () => {
  await withFreshStoreAsync(async (store, home) => {
    const config = testConfig({ webapp: { trusted_hosts: ['box.tnet.ts.net'] } });
    const { server, port, token } = await startWebServer(store, config, home, { port: 0 });
    try {
      assert.equal(await statusWithHost(port, 'box.tnet.ts.net', token), 200);
      assert.equal(await statusWithHost(port, 'other.tnet.ts.net', token), 403);
    } finally {
      server.close();
    }
  });
});

test('webapp: requireToken=false はトークン無しで通る（tailnet ACL を信頼境界にする選択）', async () => {
  await withFreshStoreAsync(async (store, home) => {
    const { server, port, token } = await startWebServer(store, testConfig(), home, { port: 0, requireToken: false });
    const base = `http://127.0.0.1:${port}`;
    try {
      assert.equal(token, null); // トークンは発行されない
      assert.equal((await fetch(`${base}/api/summary`)).status, 200); // token 無しの API も通る
      assert.equal((await fetch(`${base}/`)).status, 200); // GET / も token 不要
      // Host 検証は外れない: loopback 以外の未許可 Host は requireToken=false でも 403
      assert.equal(await statusWithHost(port, 'evil.example.com', null), 403);
    } finally {
      server.close();
    }
  });
});

/** Host を偽装して POST /api/* を投げ status を返す（fetch は Host を上書きできない） */
async function postWithHost(port, hostHeader, path, bodyObj) {
  const { request } = await import('node:http');
  const body = JSON.stringify(bodyObj);
  return new Promise((resolveStatus, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { host: hostHeader, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => { res.resume(); resolveStatus(res.statusCode); },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('webapp: requireToken=false でも POST mutation はトークン無しで通る（tailnet 公開の核心挙動・回帰ガード）', async () => {
  await withFreshStoreAsync(async (store, home) => {
    const cand = store.addCandidate({ hypothesis: 'tokenless 承認テスト', origin: 'manual' });
    // 許可ホストありで起動（tailnet 相当）。loopback からの allowlist Host アクセスを許す。
    const { server, port } = await startWebServer(store, testConfig(), home, { port: 0, requireToken: false, allowedHosts: ['node.test.ts.net'] });
    try {
      // token 無しで承認が通る（--tailnet/--no-token の信頼境界そのもの）
      const ok = await fetch(`http://127.0.0.1:${port}/api/cand/review`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: cand.id, status: 'approved' }),
      });
      assert.equal(ok.status, 200);
      assert.equal(store.getCandidate(cand.id).status, 'approved');
      // 許可 Host からの mutation も通る
      assert.equal(await postWithHost(port, 'node.test.ts.net', '/api/obs', { text: 'tokenless 観測' }), 200);
      // ただし Host 検証は外れない: 非許可 Host からの mutation は 403
      assert.equal(await postWithHost(port, 'evil.example.com', '/api/cand/review', { id: cand.id, status: 'rejected' }), 403);
    } finally {
      server.close();
    }
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

test('webapp/index.html: textarea と script の開閉が対応し script が飲み込まれない（構造ガード）', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'webapp', 'index.html'), 'utf8');
  const open = (re) => (html.match(re) || []).length;
  assert.equal(open(/<textarea\b/g), open(/<\/textarea>/g), 'textarea の開閉数が一致');
  assert.equal(open(/<script\b/g), open(/<\/script>/g), 'script の開閉数が一致');
  // 最後の </textarea> は <script> より前にある（script が未閉 textarea に飲まれない）
  assert.ok(html.lastIndexOf('</textarea>') < html.indexOf('<script>'), 'script の前に textarea が閉じている');
  // クライアントの要となる識別子が script ブロック内に存在
  assert.ok(/const TOKEN = new URLSearchParams/.test(html), 'クライアント JS が含まれる');
});
