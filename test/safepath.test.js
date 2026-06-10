import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { checkWriteTarget } from '../src/safepath.js';

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
