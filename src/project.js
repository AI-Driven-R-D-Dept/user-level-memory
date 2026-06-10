// project 名の解決。
// 既定は git root の basename（人が読める表示名）。
// 衝突・改名に弱いという弱点があるため、doctor で同名異パスの衝突を検出できるよう
// 解決の根拠（root 絶対パス）も併せて返すヘルパを用意する。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';

/** cwd から git root を遡って探す。なければ cwd を返す。 */
export function findRoot(cwd) {
  let dir = resolve(cwd || process.cwd());
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(cwd || process.cwd());
}

/** project 表示名（git root の basename）。 */
export function resolveProject(cwd) {
  return basename(findRoot(cwd));
}

/**
 * project の安定キー候補。git remote origin URL があればそれを正規化して返す。
 * 改名やパス移動に強い識別に使える（現状は doctor の衝突検出に利用）。
 * @returns {{name: string, root: string, remote: string|null}}
 */
export function projectInfo(cwd) {
  const root = findRoot(cwd);
  const name = basename(root);
  let remote = null;
  const cfg = join(root, '.git', 'config');
  if (existsSync(cfg)) {
    try {
      const text = readFileSync(cfg, 'utf8');
      const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/s.exec(text);
      if (m) remote = m[1].replace(/\.git$/, '').replace(/^git@([^:]+):/, 'https://$1/');
    } catch {
      // ignore
    }
  }
  return { name, root, remote };
}
