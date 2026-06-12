import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    const r = run(home, ['promote', id, '--yes', '--name', 'demo-rule'], { cwd: proj });
    assert.equal(r.status, 0, r.stderr);
    const skillPath = join(proj, '.claude', 'skills', 'demo-rule', 'SKILL.md');
    const body = readFileSync(skillPath, 'utf8');
    assert.match(body, /^---\nname: demo-rule\n/);
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

test('CLI: promote は不正な skill 名と既存 skill への上書きを拒否する', () => {
  const home = freshHome();
  const proj = freshProject('demo-proj');
  try {
    run(home, ['init']);
    run(home, ['cand', 'add', 'slug検証その1'], { cwd: proj });
    run(home, ['cand', 'add', 'slug検証その2'], { cwd: proj });
    const ids = JSON.parse(run(home, ['inbox', '--json']).stdout).map((c) => c.id);
    for (const id of ids) run(home, ['approve', id, '--yes']);
    // 不正 slug（traversal・大文字・空白）はすべて拒否
    for (const bad of ['../escape', 'Bad Name', 'UPPER']) {
      const r = run(home, ['promote', ids[0], '--yes', '--name', bad], { cwd: proj });
      assert.equal(r.status, 1, `slug "${bad}" が通ってしまった`);
      assert.match(r.stderr, /skill 名は/);
    }
    // 同名 skill が既にある場合は上書きせず拒否
    assert.equal(run(home, ['promote', ids[0], '--yes', '--name', 'same-name'], { cwd: proj }).status, 0);
    const r2 = run(home, ['promote', ids[1], '--yes', '--name', 'same-name'], { cwd: proj });
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
