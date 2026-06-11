// promote / ref add の書込先を検証する。
// 脅威: 汚染観測→mine→人間承認→promote が CLAUDE.md 等の自動読込ファイルへ injection を追記する
// フルチェーンの遮断点。realpath 解決後に危険な書込先を機械的に拒否する。
import { realpathSync, existsSync, lstatSync } from 'node:fs';
import { resolve, dirname, basename, sep } from 'node:path';
import { homedir } from 'node:os';

// 追記すると次セッション以降に自動で読み込まれ/実行されうるファイル・ディレクトリ
const DANGEROUS_BASENAMES = new Set([
  'CLAUDE.md', 'AGENTS.md', '.bashrc', '.zshrc', '.bash_profile', '.zprofile',
  '.profile', '.gitconfig', '.npmrc', 'authorized_keys', '.netrc', 'config',
]);
const DANGEROUS_DIR_SEGMENTS = ['.git', '.ssh', '.claude', 'node_modules', '.config'];

function realpathish(p) {
  try {
    return existsSync(p) ? realpathSync(p) : resolve(p);
  } catch {
    return resolve(p);
  }
}

// 最近接の「存在する」祖先を realpath 解決し、未存在の末尾セグメントを繋ぎ直す。
// 親が未存在のとき素の path を使うと、macOS の /var→/private/var 等のシンボリック差で
// allow-root(解決済み)と isInside 不一致になり正当な書込みを過剰拒否する問題を防ぐ。
function realpathNearest(p) {
  let cur = resolve(p);
  let suffix = '';
  while (cur && cur !== dirname(cur)) {
    if (existsSync(cur)) {
      try {
        return realpathSync(cur) + suffix;
      } catch {
        return cur + suffix;
      }
    }
    suffix = sep + basename(cur) + suffix;
    cur = dirname(cur);
  }
  return resolve(p);
}

function isInside(child, root) {
  if (!root) return false;
  const r = root.endsWith(sep) ? root : root + sep;
  return child === root || child.startsWith(r);
}

/**
 * 追記先として安全なパスかを判定する。
 * 許可: refRoot(ULM_HOME/ref) 配下、または allowRoots(作業ツリー)配下の .md ファイルのみ。
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
const DANGEROUS_LOWER = new Set([...DANGEROUS_BASENAMES].map((s) => s.toLowerCase()));

export function checkWriteTarget(targetPath, { refRoot, allowRoots = [] } = {}) {
  const abs = resolve(targetPath);

  // case-insensitive FS（macOS/Windows 既定）では note.MD と note.md が同一ファイル。
  // 拡張子・危険ファイル名の判定は小文字化して行う。
  if (!abs.toLowerCase().endsWith('.md')) {
    return { ok: false, reason: '.md ファイルのみ追記できます' };
  }
  // symlink 追従の悪用を防ぐ。lstat はリンク自身を見るので、ターゲットが未存在の
  // dangling symlink（existsSync が false を返す）でも確実に検出できる。
  // 以前は existsSync(abs) ガード下で lstat していたため、dangling symlink が
  // 検査を素通りし作業ツリー外へ追記できる穴があった（回帰: safepath dangling）。
  try {
    if (lstatSync(abs).isSymbolicLink()) {
      return { ok: false, reason: 'シンボリックリンクへの追記は拒否します' };
    }
  } catch (e) {
    // ENOENT = そこに何も無い純粋な新規ファイル。後段の根/危険判定に委ねる。
    // それ以外（EACCES 等）は評価不能として拒否（fail-closed）。
    if (e.code !== 'ENOENT') return { ok: false, reason: 'パスを評価できません' };
  }
  // 親ディレクトリを realpath 解決（.. やリンク経由の脱出を無効化）
  const parent = dirname(abs);
  let realParent;
  try {
    // 最近接の存在する祖先で解決（未存在の中間ディレクトリでも allow-root と正しく比較できる）
    realParent = realpathNearest(parent);
  } catch {
    return { ok: false, reason: '親ディレクトリを評価できません' };
  }
  const realAbs = realParent + sep + basename(abs);
  const refReal = refRoot ? realpathish(refRoot) : null;

  if (DANGEROUS_LOWER.has(basename(abs).toLowerCase())) {
    return { ok: false, reason: `自動読込される可能性が高いファイル名 (${basename(abs)}) には追記できません` };
  }
  const segs = realAbs.split(sep);
  for (const d of DANGEROUS_DIR_SEGMENTS) {
    // ULM_HOME(~/.claude/user-memory) 配下は .claude を含むので、refRoot 配下なら除外しない
    if (segs.includes(d) && !isInside(realAbs, refReal)) {
      return { ok: false, reason: `危険なディレクトリ (${d}/) 配下には追記できません` };
    }
  }
  // ホームディレクトリ直下のドットファイルを広く拒否
  if (realParent === realpathish(homedir()) && basename(abs).startsWith('.')) {
    return { ok: false, reason: 'ホーム直下の隠しファイルには追記できません' };
  }

  const roots = [refRoot, ...allowRoots].filter(Boolean).map(realpathish);
  if (roots.some((root) => isInside(realAbs, root))) {
    return { ok: true, path: abs };
  }
  return {
    ok: false,
    reason: `許可された場所の外です（許可: ${roots.join(', ')}）。ULM_HOME/ref 配下か作業ツリー配下の .md を指定してください`,
  };
}
