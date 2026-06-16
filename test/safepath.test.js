import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { checkWriteTarget, checkSkillUpdateTarget, checkSkillTarget } from '../src/safepath.js';

function sandbox(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ulm-safe-'));
  const refRoot = join(root, 'ref');
  const work = join(root, 'work');
  mkdirSync(refRoot, { recursive: true });
  mkdirSync(work, { recursive: true });
  try {
    return fn({ root, refRoot, work });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('safepath: refRoot 配下の .md は許可', () => {
  sandbox(({ refRoot }) => {
    const r = checkWriteTarget(join(refRoot, 'promoted.md'), { refRoot });
    assert.equal(r.ok, true);
  });
});

test('safepath: 作業ツリー配下の .md は許可', () => {
  sandbox(({ refRoot, work }) => {
    const r = checkWriteTarget(join(work, 'notes.md'), { refRoot, allowRoots: [work] });
    assert.equal(r.ok, true);
  });
});

test('safepath: allow-root 内で中間ディレクトリ未存在でも許可（LOW-2 回帰: /var→/private/var）', () => {
  sandbox(({ refRoot, work }) => {
    // work/newsub はまだ存在しない。macOS では mkdtemp が /var/...(→/private/var) を返すため、
    // 親未存在時に素の path を使うと allow-root(解決済み)と不一致で過剰拒否していた。
    const r = checkWriteTarget(join(work, 'newsub', 'note.md'), { refRoot, allowRoots: [work] });
    assert.equal(r.ok, true);
  });
});

test('safepath: .md 以外は拒否', () => {
  sandbox(({ refRoot }) => {
    const r = checkWriteTarget(join(refRoot, 'evil.sh'), { refRoot });
    assert.equal(r.ok, false);
  });
});

test('safepath: CLAUDE.md など自動読込ファイル名は拒否', () => {
  sandbox(({ refRoot, work }) => {
    const r = checkWriteTarget(join(work, 'CLAUDE.md'), { refRoot, allowRoots: [work] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /自動読込/);
  });
});

test('safepath: 許可ルート外（パストラバーサル）は拒否', () => {
  sandbox(({ refRoot }) => {
    const r = checkWriteTarget(join(homedir(), '.zshrc'), { refRoot });
    assert.equal(r.ok, false);
  });
});

test('safepath: .. による脱出は拒否', () => {
  sandbox(({ refRoot, root }) => {
    const r = checkWriteTarget(join(refRoot, '..', '..', 'escape.md'), { refRoot });
    assert.equal(r.ok, false);
  });
});

test('safepath: symlink への追記は拒否', () => {
  sandbox(({ refRoot }) => {
    const target = join(refRoot, 'link.md');
    const real = join(refRoot, 'real.md');
    writeFileSync(real, '');
    symlinkSync(real, target);
    const r = checkWriteTarget(target, { refRoot });
    assert.equal(r.ok, false);
    assert.match(r.reason, /シンボリックリンク/);
  });
});

test('safepath: dangling symlink（ターゲット未存在）も拒否（回帰: existsSync ガード穴）', () => {
  sandbox(({ refRoot, work }) => {
    // 作業ツリー内に、ツリー外の未存在ファイルを指す symlink を置く。
    // existsSync はリンクを辿るので false を返し、以前は symlink 検査を素通りしていた。
    const target = join(work, 'innocent.md');
    const outside = join(refRoot, '..', 'outside-nonexistent.md');
    symlinkSync(outside, target);
    const r = checkWriteTarget(target, { refRoot, allowRoots: [work] });
    assert.equal(r.ok, false, 'dangling symlink は許可してはならない');
    assert.match(r.reason, /シンボリックリンク/);
  });
});

test('safepath: 小文字の claude.md も拒否（M-3 回帰: case-insensitive FS）', () => {
  sandbox(({ refRoot, work }) => {
    assert.equal(checkWriteTarget(join(work, 'claude.md'), { refRoot, allowRoots: [work] }).ok, false);
    assert.equal(checkWriteTarget(join(work, 'Agents.MD'), { refRoot, allowRoots: [work] }).ok, false);
  });
});

test('safepath: .git 配下は拒否', () => {
  sandbox(({ refRoot, work }) => {
    mkdirSync(join(work, '.git', 'hooks'), { recursive: true });
    const r = checkWriteTarget(join(work, '.git', 'hooks', 'post-checkout.md'), { refRoot, allowRoots: [work] });
    assert.equal(r.ok, false);
  });
});

test('safepath: checkSkillTarget は未存在の ref- 先を許可し既存・非ref-・裸 ref- を拒否（NEW 書込先の唯一の砦）', () => {
  sandbox(({ work }) => {
    // 未存在 → ok
    const ok = checkSkillTarget('ref-new', work);
    assert.equal(ok.ok, true);
    assert.equal(ok.path, join(realpathSync(work), '.claude', 'skills', 'ref-new', 'SKILL.md'));
    // 既存 → 拒否（update との差）
    const dir = join(work, '.claude', 'skills', 'ref-dup');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'x');
    assert.match(checkSkillTarget('ref-dup', work).reason, /既に存在します/);
    // 非 ref- / 裸 ref- は拒否
    assert.match(checkSkillTarget('foo', work).reason, /ref-/);
    assert.match(checkSkillTarget('ref-', work).reason, /ref-/);
    assert.equal(checkSkillTarget('../escape', work).ok, false);
  });
});

test('safepath: 裸 ref- / ref-- は update でも拒否', () => {
  sandbox(({ work }) => {
    assert.equal(checkSkillUpdateTarget('ref-', work).ok, false);
    assert.equal(checkSkillUpdateTarget('ref--x', work).ok, false);
  });
});

test('safepath: checkSkillUpdateTarget は既存 SKILL.md の更新を許可する（checkSkillTarget と違う点）', () => {
  sandbox(({ work }) => {
    const dir = join(work, '.claude', 'skills', 'ref-foo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: ref-foo\n---\nold');
    const r = checkSkillUpdateTarget('ref-foo', work);
    assert.equal(r.ok, true);
    assert.equal(r.exists, true);
    assert.equal(r.path, realpathSync(join(dir, 'SKILL.md')));
  });
});

test('safepath: checkSkillUpdateTarget は未存在でも ok（exists:false）', () => {
  sandbox(({ work }) => {
    const r = checkSkillUpdateTarget('ref-new', work);
    assert.equal(r.ok, true);
    assert.equal(r.exists, false);
  });
});

test('safepath: checkSkillUpdateTarget は SKILL.md がディレクトリなら拒否（fail-closed・TEST-1）', () => {
  sandbox(({ work }) => {
    // SKILL.md の位置を実ディレクトリにして、非通常ファイルへの上書き誘発を弾けるか
    mkdirSync(join(work, '.claude', 'skills', 'ref-dir', 'SKILL.md'), { recursive: true });
    const r = checkSkillUpdateTarget('ref-dir', work);
    assert.equal(r.ok, false);
    assert.match(r.reason, /通常ファイルではない/);
  });
});

test('safepath: checkSkillUpdateTarget は不正 slug を拒否（traversal 不能）', () => {
  sandbox(({ work }) => {
    for (const bad of ['../escape', 'Bad Name', 'UPPER', 'a/b']) {
      assert.equal(checkSkillUpdateTarget(bad, work).ok, false, `slug "${bad}" が通った`);
    }
  });
});

test('safepath: checkSkillUpdateTarget は非 ref- skill の更新を拒否（手書き skill 保護）', () => {
  sandbox(({ work }) => {
    const dir = join(work, '.claude', 'skills', 'memory-recorder');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: memory-recorder\n---\nx');
    const r = checkSkillUpdateTarget('memory-recorder', work);
    assert.equal(r.ok, false);
    assert.match(r.reason, /ref-/);
  });
});

test('safepath: checkSkillUpdateTarget は symlink 経由の書込を拒否', () => {
  sandbox(({ work, root }) => {
    const skillsDir = join(work, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(skillsDir, 'ref-evil'));
    const r = checkSkillUpdateTarget('ref-evil', work);
    assert.equal(r.ok, false);
    assert.match(r.reason, /シンボリックリンク/);
  });
});
