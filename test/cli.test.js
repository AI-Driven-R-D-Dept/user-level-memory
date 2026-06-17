import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTailnetStatus, resolveWebBind, webBanner } from '../src/cli.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ulm.js');

/** ulm を子プロセスで実行。{ status, stdout, stderr } を返す（非TTY 環境）。
 *  spawnSync を使う: execFileSync は成功時に stderr を返せず、警告系（⚠）の検証ができない。 */
function run(home, args, { input, cwd } = {}) {
  const r = spawnSync('node', [BIN, ...args], {
    env: { ...process.env, ULM_HOME: home, NODE_NO_WARNINGS: '1' },
    input: input ?? '',
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function freshHome() {
  return join(mkdtempSync(join(tmpdir(), 'ulm-cli-')), 'ulm');
}

test('CLI: init → obs add → status の一連が動く', () => {
  const home = freshHome();
  try {
    assert.equal(run(home, ['init']).status, 0);
    const add = run(home, ['obs', 'add', 'テスト観測', '--tags', 'a,b', '--project', 'demo']);
    assert.equal(add.status, 0);
    assert.match(add.stdout, /観測を記録/);
    const status = run(home, ['status']);
    assert.match(status.stdout, /観測: 1 件/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: 機密パターンの観測は secret として保存される', () => {
  const home = freshHome();
  try {
    run(home, ['init']);
    const r = run(home, ['obs', 'add', 'key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX']);
    assert.match(r.stdout, /secret/);
    // 既定 list には出ない
    const list = run(home, ['obs', 'list']);
    assert.match(list.stdout, /secret 1 件を非表示/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: ゲートが hf_ トークンを自動 secret 化する（手動フラグ不要・漏洩バグ回帰）', () => {
  const home = freshHome();
  try {
    run(home, ['init']);
    const r = run(home, ['obs', 'add', 'token は hf_SHOULDNOTLEAK1234567890ABCD']);
    assert.match(r.stdout, /secret/); // 明示フラグ無しで自動 secret
    // 既定 list / search に出ない
    assert.match(run(home, ['obs', 'list']).stdout, /secret 1 件を非表示/);
    assert.ok(!run(home, ['obs', 'search', 'hf_SHOULDNOTLEAK']).stdout.includes('hf_SHOULDNOTLEAK'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: 未知形式の高エントロピートークンを fail-closed で secret 化', () => {
  const home = freshHome();
  try {
    run(home, ['init']);
    const r = run(home, ['obs', 'add', '内部トークンは xK9mPqR2vL8nW3tY6bH1jF4dZ7sA5cE0 だ']);
    assert.match(r.stdout, /secret/);
    // 普通の観測は誤検知しない
    const ok = run(home, ['obs', 'add', 'これは普通の日本語の観測テキストです']);
    assert.ok(!/secret/.test(ok.stdout));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: 不正な --source は拒否（C-1 防御）', () => {
  const home = freshHome();
  try {
    run(home, ['init']);
    const r = run(home, ['obs', 'add', 'x', '--source', 'bad)\nSYSTEM:']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /source/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: 非TTY の approve は --yes なしで拒否される（人間ゲート）', () => {
  const home = freshHome();
  try {
    run(home, ['init']);
    run(home, ['cand', 'add', 'テスト仮説']);
    const inbox = JSON.parse(run(home, ['inbox', '--json']).stdout);
    const id = inbox[0].id;
    const denied = run(home, ['approve', id]);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /人間の操作/);
    const allowed = run(home, ['approve', id, '--yes']);
    assert.equal(allowed.status, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** promote テスト用: git root を持つ仮 project ディレクトリを作る */
function freshProject(name) {
  const root = join(mkdtempSync(join(tmpdir(), 'ulm-proj-')), name);
  mkdirSync(join(root, '.git'), { recursive: true });
  return root;
}

test('CLI: promote は project の .claude/skills に SKILL.md を生成する', () => {
  const home = freshHome();
  const proj = freshProject('demo-proj');
  try {
    run(home, ['init']);
    run(home, ['cand', 'add', '昇格テスト仮説', '--conditions', 'デモ作業のとき'], { cwd: proj });
    const id = JSON.parse(run(home, ['inbox', '--json']).stdout)[0].id;
    run(home, ['approve', id, '--yes']);
    // --name は ref- 名前空間に強制される（昇格 skill は全て ref-*）
    const r = run(home, ['promote', id, '--yes', '--name', 'demo-rule'], { cwd: proj });
    assert.equal(r.status, 0, r.stderr);
    const skillPath = join(proj, '.claude', 'skills', 'ref-demo-rule', 'SKILL.md');
    const body = readFileSync(skillPath, 'utf8');
    assert.match(body, /^---\nname: ref-demo-rule\n/);
    assert.match(body, /description: .*デモ作業のとき/);
    assert.match(body, /# 昇格テスト仮説/);
    assert.match(body, new RegExp(`出自: .*\\(${id}\\)`));
    // DB 側にも昇格先が記録される
    const cand = JSON.parse(run(home, ['show', id, '--json']).stdout);
    assert.equal(cand.status, 'promoted');
    // checkSkillTarget は project root を realpath 解決する（macOS の /var → /private/var 等）
    assert.equal(cand.promoted_to, realpathSync(skillPath));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dirname(proj), { recursive: true, force: true });
  }
});

test('CLI: promote は --name なしで ref- プレフィックスの skill を生成する', () => {
  const home = freshHome();
  const proj = freshProject('demo-proj');
  try {
    run(home, ['init']);
    run(home, ['cand', 'add', 'ref-prefix テスト'], { cwd: proj });
    const id = JSON.parse(run(home, ['inbox', '--json']).stdout)[0].id;
    run(home, ['approve', id, '--yes']);
    const r = run(home, ['promote', id, '--yes'], { cwd: proj });
    assert.equal(r.status, 0, r.stderr);
    const slug = id.replace(/^cand-/, 'ref-');
    const skillPath = join(proj, '.claude', 'skills', slug, 'SKILL.md');
    assert.match(readFileSync(skillPath, 'utf8'), new RegExp(`^---\\nname: ${slug}\\n`));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dirname(proj), { recursive: true, force: true });
  }
});

test('CLI: promote --pr は非TTY+--yes なしで人間ゲートに掛かる（dry-run でも免除しない）', () => {
  const home = freshHome();
  const proj = freshProject('demo-proj');
  try {
    run(home, ['init']);
    run(home, ['cand', 'add', 'pr ゲートテスト'], { cwd: proj });
    const id = JSON.parse(run(home, ['inbox', '--json']).stdout)[0].id;
    run(home, ['approve', id, '--yes']);
    const denied = run(home, ['promote', id, '--pr', '--dry-run'], { cwd: proj });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /人間の操作/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dirname(proj), { recursive: true, force: true });
  }
});

test('CLI: promote --pr は機密疑い候補を LLM 送出前に中止する（再ゲート・provider 不要）', () => {
  const home = freshHome();
  const proj = freshProject('demo-proj');
  try {
    run(home, ['init']);
    run(home, ['cand', 'add', '内部トークンは xK9mPqR2vL8nW3tY6bH1jF4dZ7sA5cE0 を使う'], { cwd: proj });
    const id = JSON.parse(run(home, ['inbox', '--json']).stdout)[0].id;
    run(home, ['approve', id, '--yes']);
    const r = run(home, ['promote', id, '--pr', '--dry-run', '--yes'], { cwd: proj });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /機密の疑い/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dirname(proj), { recursive: true, force: true });
  }
});

test('CLI: ローカル promote も機密疑い候補は skill 生成前に再ゲートで中止（--pr と一貫・R5-should5）', () => {
  const home = freshHome();
  const proj = freshProject('demo-proj');
  try {
    run(home, ['init']);
    run(home, ['cand', 'add', '内部トークンは xK9mPqR2vL8nW3tY6bH1jF4dZ7sA5cE0 を使う'], { cwd: proj });
    const id = JSON.parse(run(home, ['inbox', '--json']).stdout)[0].id;
    run(home, ['approve', id, '--yes']);
    const r = run(home, ['promote', id, '--yes'], { cwd: proj }); // --pr 無しのローカル生成
    assert.equal(r.status, 1);
    assert.match(r.stderr, /機密の疑い/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dirname(proj), { recursive: true, force: true });
  }
});

test('CLI: promote --dry-run / --provider は --pr 無しだと使い方エラー（TEST-1）', () => {
  const home = freshHome();
  const proj = freshProject('demo-proj');
  try {
    run(home, ['init']);
    run(home, ['cand', 'add', 'pr 配線テスト'], { cwd: proj });
    const id = JSON.parse(run(home, ['inbox', '--json']).stdout)[0].id;
    run(home, ['approve', id, '--yes']);
    // パース段ガード（cli.js）は requireHuman・候補取得より前に発火する。--pr 無しでの併用を明確に弾く。
    const r1 = run(home, ['promote', id, '--yes', '--dry-run'], { cwd: proj });
    assert.equal(r1.status, 2);
    assert.match(r1.stderr, /--dry-run \/ --provider は --pr/);
    const r2 = run(home, ['promote', id, '--yes', '--provider', 'codex'], { cwd: proj });
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /--dry-run \/ --provider は --pr/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dirname(proj), { recursive: true, force: true });
  }
});

test('CLI: promote --pr --provider 空文字は使い方エラー（ROB-3）', () => {
  const home = freshHome();
  const proj = freshProject('demo-proj');
  try {
    run(home, ['init']);
    run(home, ['cand', 'add', 'provider 空テスト'], { cwd: proj });
    const id = JSON.parse(run(home, ['inbox', '--json']).stdout)[0].id;
    run(home, ['approve', id, '--yes']);
    const r = run(home, ['promote', id, '--yes', '--pr', '--provider', ''], { cwd: proj });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--provider が空/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dirname(proj), { recursive: true, force: true });
  }
});

test('CLI: promote --name 空文字は使い方エラー（R5-nit3）', () => {
  const home = freshHome();
  const proj = freshProject('demo-proj');
  try {
    run(home, ['init']);
    run(home, ['cand', 'add', '名前テスト'], { cwd: proj });
    const id = JSON.parse(run(home, ['inbox', '--json']).stdout)[0].id;
    run(home, ['approve', id, '--yes']);
    const r = run(home, ['promote', id, '--yes', '--name', ''], { cwd: proj });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--name が空/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dirname(proj), { recursive: true, force: true });
  }
});

test('CLI: promote は候補と現在地の project 不一致を拒否する', () => {
  const home = freshHome();
  const projA = freshProject('proj-a');
  const projB = freshProject('proj-b');
  try {
    run(home, ['init']);
    run(home, ['cand', 'add', '別projectの仮説'], { cwd: projA });
    const id = JSON.parse(run(home, ['inbox', '--json']).stdout)[0].id;
    run(home, ['approve', id, '--yes']);
    const r = run(home, ['promote', id, '--yes'], { cwd: projB });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /proj-a/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dirname(projA), { recursive: true, force: true });
    rmSync(dirname(projB), { recursive: true, force: true });
  }
});

test('CLI: promote は --name を ref- slug に正規化し traversal を無害化、既存は上書き拒否', () => {
  const home = freshHome();
  const proj = freshProject('demo-proj');
  try {
    run(home, ['init']);
    for (let i = 0; i < 3; i++) run(home, ['cand', 'add', `slug検証その${i}`], { cwd: proj });
    const ids = JSON.parse(run(home, ['inbox', '--json']).stdout).map((c) => c.id);
    for (const id of ids) run(home, ['approve', id, '--yes']);
    // traversal/大文字/空白入りの --name は --pr 経路と同じく sanitizeRefSlug で安全な ref-* に正規化される
    const r0 = run(home, ['promote', ids[0], '--yes', '--name', '../Bad Name'], { cwd: proj });
    assert.equal(r0.status, 0, r0.stderr);
    assert.ok(existsSync(join(proj, '.claude', 'skills', 'ref-bad-name', 'SKILL.md')), 'ref-bad-name に正規化されるべき');
    assert.ok(!existsSync(join(dirname(proj), 'escape')), '親ディレクトリへ脱出してはいけない');
    // 同名 skill が既にある場合は上書きせず拒否
    assert.equal(run(home, ['promote', ids[1], '--yes', '--name', 'dup'], { cwd: proj }).status, 0);
    const r2 = run(home, ['promote', ids[2], '--yes', '--name', 'dup'], { cwd: proj });
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /既に存在します/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dirname(proj), { recursive: true, force: true });
  }
});

test('CLI: context --hook は SessionStart JSON を stdout に出す', () => {
  const home = freshHome();
  try {
    run(home, ['init']);
    run(home, ['state', 'set', '担当', 'テスト']);
    const r = run(home, ['context', '--hook'], { input: JSON.stringify({ cwd: process.cwd(), hook_event_name: 'SessionStart' }) });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(out.hookSpecificOutput.additionalContext, /担当/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: context --hook は壊れた stdin でも exit 0・stdout を汚さない（fail-open）', () => {
  const home = freshHome();
  try {
    run(home, ['init']);
    const r = run(home, ['context', '--hook'], { input: '{壊れたJSON' });
    assert.equal(r.status, 0);
    // stdout は空か有効な JSON のみ（壊れた入力でも例外メッセージを stdout に出さない）
    if (r.stdout.trim()) JSON.parse(r.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: export → import のラウンドトリップ', () => {
  const home1 = freshHome();
  const home2 = freshHome();
  try {
    run(home1, ['init']);
    run(home1, ['obs', 'add', 'エクスポート対象', '--project', 'demo']);
    run(home1, ['export']);
    const imp = run(home2, ['import', join(home1, 'export')]);
    assert.equal(imp.status, 0);
    const list = run(home2, ['obs', 'list', '--project', 'demo']);
    assert.match(list.stdout, /エクスポート対象/);
  } finally {
    rmSync(home1, { recursive: true, force: true });
    rmSync(home2, { recursive: true, force: true });
  }
});

test('CLI: 不明なコマンドは exit 2', () => {
  const home = freshHome();
  try {
    assert.equal(run(home, ['bogus']).status, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('obs add: 類似観測の機械的警告（保存は止めない・判定はしない）', () => {
  const home = freshHome();
  const a = run(home, ['obs', 'add', 'ユーザーは野菜が嫌いと本人が明言（食べ物の好み）。食事・レシピ・店選びの話題に関連する', '--global']);
  assert.equal(a.status, 0);
  // 言い換えを追加 → 警告に既存 id が出る。ただし保存自体は行われる
  const b = run(home, ['obs', 'add', 'ユーザーは野菜が嫌い。食事・レシピ・店選びの提案時は、野菜中心の提案を避けるのが無難。', '--global']);
  assert.equal(b.status, 0);
  assert.match(b.stdout, /✓ 観測を記録/);
  assert.match(b.stderr, /似ている可能性のある既存観測/);
  assert.match(b.stderr, /obs-[0-9a-f]+/);
  // 無関係テキストでは警告なし
  const c = run(home, ['obs', 'add', 'Remotion のレンダリングは SFX を全コピーしないと404で失敗する', '--global']);
  assert.equal(c.status, 0);
  assert.ok(!c.stderr.includes('似ている可能性'), `無関係では警告しない: ${c.stderr}`);
});

test('obs add: 警告候補にも生成ゲート（後付け deny パターンの未フラグ機密を stderr に出さない）', () => {
  const home = freshHome();
  // 保存時点では deny に当たらない観測（secret フラグなし）
  const a = run(home, ['obs', 'add', 'デプロイ手順のコツ: 社内トークン ACMEXYZZY-9988-7766 を scripts/deploy.sh に渡す', '--global']);
  assert.equal(a.status, 0);
  // 後から deny パターンを追加（保存済み観測が読み取り時ゲートの対象になる状況を再現）
  const cfgPath = join(home, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.deny_patterns = ['ACMEXYZZY-\\d+'];
  writeFileSync(cfgPath, JSON.stringify(cfg));
  // 言い換えを追加 → 警告にはゲート一致の観測を出さない
  const b = run(home, ['obs', 'add', 'デプロイ手順のコツ: 社内トークンを scripts/deploy.sh に渡して実行する', '--global']);
  assert.equal(b.status, 0);
  assert.match(b.stdout, /✓ 観測を記録/);
  assert.ok(!b.stderr.includes('ACMEXYZZY'), `機密様テキストが警告に漏れない: ${b.stderr}`);
});

test('parseTailnetStatus: 正常な status から 100.x IPv4 と MagicDNS 名を取り出す', () => {
  const raw = JSON.stringify({
    BackendState: 'Running',
    Self: { TailscaleIPs: ['fd7a:1::1', '100.100.90.41'], DNSName: 'erenmac-mini.folk-viper.ts.net.' },
  });
  assert.deepEqual(parseTailnetStatus(raw), { ip: '100.100.90.41', dnsName: 'erenmac-mini.folk-viper.ts.net' });
});

test('parseTailnetStatus: 非JSON（macOS GUI headless）は --host フォールバックを案内する実用エラー', () => {
  // launchd/最小 env での実出力: GUI 起動失敗メッセージ（exit 0 だが非 JSON）
  const raw = 'The Tailscale GUI failed to start: The operation couldn’t be completed. (Tailscale.CLIError error 3.)\n';
  assert.throws(() => parseTailnetStatus(raw), (err) => {
    assert.match(err.message, /JSON を返しませんでした/);
    assert.match(err.message, /--host/); // 固定指定フォールバックを案内
    assert.match(err.message, /GUI/); // 原因に触れる
    return true;
  });
});

test('parseTailnetStatus: 未接続（BackendState!=Running）は接続を促すエラー', () => {
  const raw = JSON.stringify({ BackendState: 'NeedsLogin', Self: {} });
  assert.throws(() => parseTailnetStatus(raw), /未接続|tailscale up/);
});

test('parseTailnetStatus: 100.x が無ければ --host 手動指定を促す', () => {
  const raw = JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['fd7a:1::1'], DNSName: 'x.ts.net.' } });
  assert.throws(() => parseTailnetStatus(raw), /100\.x|--host/);
});

test('parseTailnetStatus: 非100.xのIPv4は採用せず fail-closed（fallbackで誤bindしない）', () => {
  const raw = JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['10.0.0.5', 'fd7a::1'], DNSName: 'x.ts.net.' } });
  assert.throws(() => parseTailnetStatus(raw), /100\.x|--host/);
});

// --- resolveWebBind: フラグ→bind/トークン要否の決定（feature の信頼境界ロジック） ---
function webValues(over = {}) {
  return { tailnet: false, host: undefined, 'allow-host': [], 'no-token': false, ...over };
}
const fakeDetect = () => ({ ip: '100.100.90.41', dnsName: 'node.tail.ts.net' });

test('resolveWebBind: 既定は loopback + トークン必須', () => {
  assert.deepEqual(resolveWebBind(webValues()), {
    host: '127.0.0.1', allowedHosts: [], requireToken: true, displayHost: null, kind: 'loopback',
  });
});

test('resolveWebBind: --no-token は loopback でもトークンを外す', () => {
  assert.equal(resolveWebBind(webValues({ 'no-token': true })).requireToken, false);
});

test('resolveWebBind: --tailnet は 100.x bind・MagicDNS 許可・トークン無し', () => {
  const r = resolveWebBind(webValues({ tailnet: true }), fakeDetect);
  assert.equal(r.host, '100.100.90.41');
  assert.equal(r.requireToken, false);
  assert.equal(r.kind, 'tailnet');
  assert.equal(r.displayHost, 'node.tail.ts.net');
  assert.ok(r.allowedHosts.includes('node.tail.ts.net'));
});

test('resolveWebBind: --tailnet と --host は併用不可', () => {
  assert.throws(() => resolveWebBind(webValues({ tailnet: true, host: '1.2.3.4' }), fakeDetect), /併用できません/);
});

test('resolveWebBind: loopback/100.x 以外の --host は一律拒否（0.0.0.0 別表記・LAN・IPv6・名前）', () => {
  // 0.0.0.0 のあらゆる別表記やワイルドカード、LAN、非100.x がすり抜けないこと
  for (const h of ['0.0.0.0', '0x0', '00.0.0.0', '000.000.000.000', '*', '0', '::', '::0', '192.168.1.5', '10.0.0.5', 'evil.example.com']) {
    assert.throws(() => resolveWebBind(webValues({ host: h })), /loopback か tailnet/, `host=${h}`);
  }
});

test('resolveWebBind: --host は loopback / 100.x のみ受理し [::1] の角括弧は外す', () => {
  assert.equal(resolveWebBind(webValues({ host: '127.0.0.1' })).kind, 'loopback');
  assert.equal(resolveWebBind(webValues({ host: '100.100.90.41' })).kind, 'tailnet');
  const r = resolveWebBind(webValues({ host: '[::1]' }));
  assert.equal(r.host, '::1'); // listen は裸 IP を要求するので角括弧を外す
  assert.equal(r.kind, 'loopback');
});

test('resolveWebBind: --host 100.x は既定トークン維持／--no-tokenで外す', () => {
  assert.equal(resolveWebBind(webValues({ host: '100.100.90.41' })).requireToken, true);
  assert.equal(resolveWebBind(webValues({ host: '100.100.90.41', 'no-token': true })).requireToken, false);
});

test('webBanner: tailnet トークン無しは tailnet(ACL) の警告と MagicDNS URL を出す', () => {
  const lines = webBanner({ host: '100.100.90.41', displayHost: 'node.ts.net', kind: 'tailnet' }, null, 8765).join('\n');
  assert.match(lines, /tailnet バインド/);
  assert.match(lines, /http:\/\/node\.ts\.net:8765\//);
  assert.match(lines, /token 無しで公開中/);
  assert.match(lines, /tailnet\(ACL\)/);
});

test('webBanner: loopback + token は端末限定の注意のみ（公開警告を出さない）', () => {
  const lines = webBanner({ host: '127.0.0.1', displayHost: null, kind: 'loopback' }, 'abc123', 8765).join('\n');
  assert.match(lines, /127\.0\.0\.1 のみ/);
  assert.match(lines, /\?token=abc123/);
  assert.match(lines, /この端末にだけ/);
  assert.doesNotMatch(lines, /公開中/);
});

test('webBanner: IPv6 displayHost は URL を角括弧で囲む', () => {
  const lines = webBanner({ host: '::1', displayHost: '::1', kind: 'loopback' }, null, 8765).join('\n');
  assert.match(lines, /http:\/\/\[::1\]:8765\//);
});

test('resolveWebBind: --allow-host 単独は死に設定として拒否', () => {
  assert.throws(() => resolveWebBind(webValues({ 'allow-host': ['x.ts.net'] })), /--allow-host は/);
});

test('resolveWebBind: --host(100.x) + --allow-host は表示に名前を優先し許可にも入る', () => {
  const r = resolveWebBind(webValues({ host: '100.100.90.41', 'allow-host': ['node.ts.net'] }));
  assert.equal(r.displayHost, 'node.ts.net');
  assert.ok(r.allowedHosts.includes('node.ts.net'));
});

test('resolveWebBind: loopback --host + --allow-host は死に設定として拒否（到達不能URLを出さない）', () => {
  // 127.0.0.1 にしか bind しないのに tailnet 名を許可しても到達できず、トークン入り偽URLを出すのを防ぐ
  assert.throws(() => resolveWebBind(webValues({ host: '127.0.0.1', 'allow-host': ['node.ts.net'] })), /loopback バインドでは到達できません/);
});

test('resolveWebBind: tailnet 判定は CGNAT 100.64.0.0/10 のみ（public な 100.x を tokenless 公開しない）', () => {
  // 範囲内は受理
  for (const h of ['100.64.0.0', '100.100.90.41', '100.127.255.255']) {
    assert.equal(resolveWebBind(webValues({ host: h })).kind, 'tailnet', `accept ${h}`);
  }
  // 範囲外の 100.x（public IPv4 空間）は拒否
  for (const h of ['100.0.0.1', '100.63.255.255', '100.128.0.1', '100.200.5.5']) {
    assert.throws(() => resolveWebBind(webValues({ host: h, 'no-token': true })), /loopback か tailnet/, `reject ${h}`);
  }
});

test('parseTailnetStatus: 非CGNATの 100.x は採用しない（fail-closed）', () => {
  const raw = JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['100.200.5.5'], DNSName: 'x.ts.net.' } });
  assert.throws(() => parseTailnetStatus(raw), /100\.x|CGNAT|--host/);
});

test('webBanner: name:port の displayHost を IPv6 と誤認して角括弧で囲まない', () => {
  const lines = webBanner({ host: '100.64.0.5', displayHost: 'node.ts.net:9000', kind: 'tailnet' }, 'abc', 8765).join('\n');
  assert.match(lines, /http:\/\/node\.ts\.net:9000:8765\//); // 角括弧無し
  assert.doesNotMatch(lines, /\[node\.ts\.net:9000\]/);
});

// --- cmdWeb のサブプロセス検証（resolveWebBind→startWebServer の配線まで通す） ---

test('ulm web: --port 範囲外は UsageError で即終了', () => {
  const home = freshHome();
  try {
    const r = run(home, ['web', '--port', '99999']);
    assert.equal(r.status, 2); // UsageError は exit 2
    assert.match(r.stderr, /--port/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ulm web: --host 0.0.0.0 / --allow-host 単独は起動前に弾く', () => {
  const home = freshHome();
  try {
    const wild = run(home, ['web', '--host', '0.0.0.0', '--no-token']);
    assert.equal(wild.status, 2); // UsageError は exit 2
    assert.match(wild.stderr, /loopback か tailnet/);
    const dead = run(home, ['web', '--allow-host', 'x.ts.net']);
    assert.equal(dead.status, 2);
    assert.match(dead.stderr, /--allow-host/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ulm web --no-token (loopback): tokenless バナーを出して起動する（cmdWeb 配線）', async () => {
  const home = freshHome();
  await new Promise((resolveTest, rejectTest) => {
    const child = spawn('node', [BIN, 'web', '--port', '0', '--no-token'], {
      env: { ...process.env, ULM_HOME: home, NODE_NO_WARNINGS: '1' },
    });
    let out = '';
    const finish = (err) => { try { child.kill('SIGKILL'); } catch { /* already gone */ } err ? rejectTest(err) : resolveTest(); };
    const timer = setTimeout(() => finish(new Error(`banner 未出力: ${out}`)), 8000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      // バナーは3つの console.log が別チャンクで届きうるので、最終行（token 無し警告）まで待ってから判定。
      if (out.includes('token 無しで起動中')) {
        clearTimeout(timer);
        try {
          assert.match(out, /127\.0\.0\.1 のみ/);
          assert.match(out, /http:\/\/127\.0\.0\.1:\d+\//);
          assert.doesNotMatch(out, /\?token=/); // --no-token なので URL に token は無い
          finish();
        } catch (e) { finish(e); }
      }
    });
    child.on('error', finish);
  });
  rmSync(home, { recursive: true, force: true });
});
