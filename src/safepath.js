// promote / ref add の書込先を検証する。
// 脅威: 汚染観測→mine→人間承認→promote が CLAUDE.md 等の自動読込ファイルへ injection を追記する
// フルチェーンの遮断点。realpath 解決後に危険な書込先を機械的に拒否する。
import { realpathSync, existsSync, lstatSync } from 'node:fs';
import { resolve, dirname, basename, join, sep } from 'node:path';
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

/**
 * promote の skill 化専用の書込先検証。
 * .claude/ は checkWriteTarget が拒否する自動読込チャネルだが、promote に限り
 * 「検証済み slug から組み立てた <projectRoot>/.claude/skills/<slug>/SKILL.md」だけを許す。
 * 任意パスは受け取らない（slug 正規表現が / . を禁じるため traversal 不能）。
 * 人間ゲート（approve 済みのみ昇格可・--yes/TTY）が前段にある前提の経路。
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function checkSkillTarget(slug, projectRoot) {
  if (!SKILL_SLUG_RE.test(String(slug))) {
    return { ok: false, reason: 'skill 名は英小文字・数字・ハイフン（先頭は英数字）64 文字以内で指定してください' };
  }
  const root = realpathish(resolve(projectRoot));
  const dir = join(root, '.claude', 'skills', slug);
  const target = join(dir, 'SKILL.md');
  // 経路上の既存 symlink を拒否（リンク差し替えで作業ツリー外へ書かせない）
  for (const p of [join(root, '.claude'), join(root, '.claude', 'skills'), dir, target]) {
    try {
      if (lstatSync(p).isSymbolicLink()) {
        return { ok: false, reason: `シンボリックリンクを経由する書込は拒否します (${p})` };
      }
    } catch (e) {
      if (e.code !== 'ENOENT') return { ok: false, reason: 'パスを評価できません' };
    }
  }
  if (existsSync(target)) {
    return { ok: false, reason: `既に存在します: ${target}（--name で別名を指定してください）` };
  }
  return { ok: true, path: target };
}

/**
 * promote --pr（既存 skill 更新）専用の書込先検証。
 * checkSkillTarget と同じ slug 制約・symlink 拒否・.claude/skills/<slug>/SKILL.md 限定だが、
 * 「既に存在する SKILL.md への上書き（更新）」を許す点だけが異なる。
 * agent が更新先 slug を恣意的に作れないよう、呼び出し側は実在 skill の slug 集合に限定して使うこと。
 * 既存ファイルが通常ファイルでない（ディレクトリ等）場合は拒否（fail-closed）。
 * @returns {{ok: true, path: string, exists: boolean} | {ok: false, reason: string}}
 */
export function checkSkillUpdateTarget(slug, projectRoot) {
  if (!SKILL_SLUG_RE.test(String(slug))) {
    return { ok: false, reason: 'skill 名は英小文字・数字・ハイフン（先頭は英数字）64 文字以内で指定してください' };
  }
  // 更新は ulm が作った ref-* skill に限る（手書き・運用 skill を上書きさせない）
  if (!String(slug).startsWith('ref-')) {
    return { ok: false, reason: '既存 skill の更新は ref-* に限られます（手書き skill は更新対象外）' };
  }
  const root = realpathish(resolve(projectRoot));
  const dir = join(root, '.claude', 'skills', slug);
  const target = join(dir, 'SKILL.md');
  for (const p of [join(root, '.claude'), join(root, '.claude', 'skills'), dir, target]) {
    try {
      if (lstatSync(p).isSymbolicLink()) {
        return { ok: false, reason: `シンボリックリンクを経由する書込は拒否します (${p})` };
      }
    } catch (e) {
      if (e.code !== 'ENOENT') return { ok: false, reason: 'パスを評価できません' };
    }
  }
  if (existsSync(target)) {
    try {
      if (!lstatSync(target).isFile()) {
        return { ok: false, reason: `通常ファイルではない書込先は拒否します: ${target}` };
      }
    } catch {
      return { ok: false, reason: 'パスを評価できません' };
    }
    return { ok: true, path: target, exists: true };
  }
  return { ok: true, path: target, exists: false };
}

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
