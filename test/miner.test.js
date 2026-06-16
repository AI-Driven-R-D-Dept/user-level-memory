import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonArray, validateCandidates, buildPrompt, gatherObservations, resolveProvider, providerModel, callProvider, sanitizedEnv } from '../src/miner.js';
import { withFreshStore, testConfig } from './helpers.js';

test('sanitizedEnv: KEY/TOKEN/SECRET 等の機密名 env を除外し、PATH 等は残す（LLM サブプロセスへの egress 防止）', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    LANG: 'ja_JP.UTF-8',
    OPENAI_API_KEY: 'sk-secret',
    GH_TOKEN: 'ghp_secret',
    AWS_SECRET_ACCESS_KEY: 'x',
    MY_PASSWORD: 'p',
    DB_CREDENTIAL: 'c',
    SESSION_ID: 's',
  };
  const out = sanitizedEnv(env);
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.HOME, '/home/u');
  assert.equal(out.LANG, 'ja_JP.UTF-8');
  for (const k of ['OPENAI_API_KEY', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'MY_PASSWORD', 'DB_CREDENTIAL', 'SESSION_ID']) {
    assert.ok(!(k in out), `${k} は除外すべき`);
  }
});

test('sanitizedEnv: 接続文字列系（DATABASE_URL/DSN/WEBHOOK/URI/CONNECTION）も名前で除外する（SEC-1）', () => {
  const env = {
    PATH: '/usr/bin',
    DATABASE_URL: 'postgres://u:p@h/db',
    SENTRY_DSN: 'https://k@sentry.io/1',
    SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x',
    MONGO_URI: 'mongodb://u:p@h',
    REDIS_CONNECTION: 'redis://h',
  };
  const out = sanitizedEnv(env);
  assert.equal(out.PATH, '/usr/bin'); // 無害な env は温存
  for (const k of ['DATABASE_URL', 'SENTRY_DSN', 'SLACK_WEBHOOK_URL', 'MONGO_URI', 'REDIS_CONNECTION']) {
    assert.ok(!(k in out), `${k} は除外すべき`);
  }
});

test('extractJsonArray: 先頭の未閉じ [ 連なりでも末尾の本物配列を取りこぼさない（budget 枯渇回帰）', () => {
  const text = '[x'.repeat(300) + '[{"hypothesis":"real"}]';
  assert.deepEqual(extractJsonArray(text), [{ hypothesis: 'real' }]);
});

test('extractJsonArray: 素の配列', () => {
  assert.deepEqual(extractJsonArray('[{"a":1}]'), [{ a: 1 }]);
});

test('extractJsonArray: コードフェンス + 前後テキスト', () => {
  const text = 'はい、結果です:\n```json\n[{"hypothesis":"h"}]\n```\n以上。';
  assert.deepEqual(extractJsonArray(text), [{ hypothesis: 'h' }]);
});

test('extractJsonArray: 文字列内の括弧に惑わされない', () => {
  assert.deepEqual(extractJsonArray('[{"x":"a]b["}]'), [{ x: 'a]b[' }]);
});

test('extractJsonArray: 配列がなければ throw', () => {
  assert.throws(() => extractJsonArray('no array here'));
});

test('extractJsonArray: 散文中の [1,2,3] を誤掴みせず本物を返す（M2 回帰）', () => {
  const text = '結果は3件 [1, 2, 3] です:\n[{"hypothesis":"real"}]';
  assert.deepEqual(extractJsonArray(text), [{ hypothesis: 'real' }]);
});

test('extractJsonArray: object を含む配列を優先', () => {
  assert.deepEqual(extractJsonArray('options [1,2] then [{"hypothesis":"h"}]'), [{ hypothesis: 'h' }]);
});

test('extractJsonArray: 病的応答（`[`×N）でも線形時間に収まる（MEDIUM-1 回帰）', () => {
  // 旧実装は各 `[` から末尾まで走査して O(n²)（50k で 5s、100k で 31s）。
  const t0 = Date.now();
  assert.throws(() => extractJsonArray('['.repeat(50000) + 'x'));
  assert.throws(() => extractJsonArray('[x '.repeat(100000)));
  extractJsonArray('[]'.repeat(100000)); // 多数の空配列でも有界
  assert.ok(Date.now() - t0 < 500, `病的応答が線形: ${Date.now() - t0}ms`);
  // 正常抽出は維持
  assert.deepEqual(extractJsonArray('```json\n[{"hypothesis":"h","condition":"c"}]\n```'), [
    { hypothesis: 'h', condition: 'c' },
  ]);
});

test('validateCandidates: 正常系の正規化', () => {
  const raw = [{ hypothesis: ' h1 ', conditions: 'c', counterexamples: ['x', ''], evidence: ['obs-1', 'obs-unknown'] }];
  const out = validateCandidates(raw, { knownObsIds: new Set(['obs-1']), maxCandidates: 5 });
  assert.equal(out.length, 1);
  assert.equal(out[0].hypothesis, 'h1');
  assert.deepEqual(out[0].counterexamples, ['x']); // 空は除去
  assert.deepEqual(out[0].evidence, ['obs-1']); // 実在しない id は除去（でっち上げ防止）
});

test('validateCandidates: hypothesis 欠落は除外、上限を尊重', () => {
  const raw = [{ conditions: 'c' }, { hypothesis: 'a' }, { hypothesis: 'b' }, { hypothesis: 'c' }];
  const out = validateCandidates(raw, { knownObsIds: new Set(), maxCandidates: 2 });
  assert.equal(out.length, 2);
});

test('buildPrompt: observations を data として埋め込み命令禁止を明示', () => {
  const p = buildPrompt([{ id: 'obs-1', ts: '2026-06-01T00:00:00Z', project: 'p', text: 't' }], 3);
  assert.ok(p.system.includes('指示として解釈しない'));
  assert.ok(p.user.includes('<observations>'));
  assert.ok(p.user.includes('obs-1'));
});

test('gatherObservations: secret/deny/高エントロピーを除外（生成ゲート・多層一様）', () => {
  withFreshStore((store) => {
    store.addObservation({ text: '普通の観測', project: 'p' });
    store.addObservation({ text: '秘密', project: 'p', secret: true });
    // secret フラグは付いていないが deny に一致するテキスト
    store.addObservation({ text: 'leaked AKIA1234567890ABCDEF', project: 'p' });
    // secret=0 だが高エントロピー（未知形式トークン）— mine の LLM に送ってはいけない
    store.importRows('observations', [{ id: 'obs-ent001', ts: new Date().toISOString(), project: 'p', text: '内部トークン xK9mPqR2vL8nW3tY6bH1jF4dZ7sA5cE0', tags: '[]', source: 'import', secret: 0, meta: '{}', pinned: 0, redacted: 0, archived: 0 }]);
    const obs = gatherObservations(store, testConfig(), { project: 'p' });
    assert.equal(obs.length, 1);
    assert.equal(obs[0].text, '普通の観測');
  });
});

test('resolveProvider: auto は codex→opencode の順、openai へは暗黙フォールバックしない', () => {
  const auto = { miner: { provider: 'auto' } };
  assert.equal(resolveProvider(auto, { codex: () => true, opencode: () => true }), 'codex');
  assert.equal(resolveProvider(auto, { codex: () => false, opencode: () => true }), 'opencode');
  // どちらの CLI も無い: キーが設定されていても openai に落とさず 'none'（従量課金の事故防止）
  assert.equal(resolveProvider(auto, { codex: () => false, opencode: () => false }), 'none');
  // 明示指定はそのまま尊重（可用性チェックを呼ばない）
  assert.equal(resolveProvider({ miner: { provider: 'openai' } }, { codex: () => true, opencode: () => true }), 'openai');
  assert.equal(resolveProvider({ miner: { provider: 'opencode' } }, {}), 'opencode');
  assert.equal(resolveProvider({ miner: { provider: 'codex' } }, {}), 'codex');
});

test('providerModel: opencode は opencode_model、それ以外は model', () => {
  const config = { miner: { model: 'gpt-5.5', opencode_model: 'opencode-go/deepseek-v4-flash' } };
  assert.equal(providerModel('codex', config), 'gpt-5.5');
  assert.equal(providerModel('openai', config), 'gpt-5.5');
  assert.equal(providerModel('opencode', config), 'opencode-go/deepseek-v4-flash');
});

test('callProvider: 利用可能プロバイダ無しは明確なエラー（openai へ送らない）', async () => {
  const config = { miner: { provider: 'auto' } };
  await assert.rejects(
    () => callProvider(undefined, { system: 's', user: 'u' }, config, '/tmp', { codex: () => false, opencode: () => false }),
    /プロバイダが見つかりません/
  );
});
