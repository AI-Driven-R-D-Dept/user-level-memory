// プラグイン配布物の整合性テスト。
// Claude Code プラグイン仕様（plugin.json / hooks.json / commands / skills / marketplace）と
// リポジトリの実体がズレていないことを機械的に保証する。
// 仕様の根拠: https://code.claude.com/docs/en/plugins-reference.md / hooks.md / skills.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

/** SKILL.md / commands の YAML frontmatter を素朴に読む（依存ゼロを保つ） */
function readFrontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, `${file}: frontmatter が無い`);
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return { fields, body: text.slice(m[0].length) };
}

// --- plugin.json -----------------------------------------------------------

test('plugin.json: 必須フィールドと参照先の実在', () => {
  const manifest = readJson('.claude-plugin/plugin.json');
  assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'name は kebab-case');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'version は semver');
  assert.ok(manifest.description, 'description 必須ではないが配布物には欲しい');
  for (const key of ['commands', 'skills', 'hooks']) {
    const p = manifest[key];
    assert.ok(typeof p === 'string' && p.startsWith('./'), `${key} は ./ 始まりのパス`);
    assert.ok(fs.existsSync(path.join(ROOT, p)), `${key} の参照先 ${p} が存在しない`);
  }
});

test('marketplace.json: plugin.json と名前・バージョンが一致', () => {
  const manifest = readJson('.claude-plugin/plugin.json');
  const market = readJson('.claude-plugin/marketplace.json');
  assert.ok(market.name && market.owner?.name, 'marketplace の name/owner.name 必須');
  const entry = market.plugins.find((p) => p.name === manifest.name);
  assert.ok(entry, `marketplace に ${manifest.name} のエントリが無い`);
  assert.equal(entry.version, manifest.version, 'version が plugin.json とズレている');
  assert.equal(entry.source, './', 'source は単一リポジトリのルート');
});

// --- hooks ------------------------------------------------------------------

const KNOWN_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop',
  'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Setup',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'Notification',
  'ConfigChange', 'FileChanged', 'WorktreeCreate',
]);
// command 型 hook で仕様に存在するキーのみ（spec 外フィールドの混入を防ぐ回帰）
const COMMAND_HOOK_KEYS = new Set(['type', 'command', 'args', 'async', 'timeout', 'if']);

test('hooks.json: イベント名・フィールドが仕様内で、スクリプトが実在し実行可能', () => {
  const { hooks } = readJson('hooks/hooks.json');
  assert.ok(hooks && typeof hooks === 'object');
  for (const [event, groups] of Object.entries(hooks)) {
    assert.ok(KNOWN_EVENTS.has(event), `未知の hook イベント: ${event}`);
    for (const group of groups) {
      for (const key of Object.keys(group)) {
        assert.ok(['matcher', 'hooks'].includes(key), `${event}: 未知のグループキー ${key}`);
      }
      for (const h of group.hooks) {
        assert.equal(h.type, 'command');
        for (const key of Object.keys(h)) {
          assert.ok(COMMAND_HOOK_KEYS.has(key), `${event}: 仕様に無いフィールド ${key}`);
        }
        assert.ok(Number.isFinite(h.timeout) && h.timeout > 0, `${event}: timeout は正の秒数`);
        const m = h.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}([^"']+)/);
        assert.ok(m, `${event}: command は \${CLAUDE_PLUGIN_ROOT} 基準で書く`);
        const script = path.join(ROOT, m[1]);
        assert.ok(fs.existsSync(script), `${event}: ${m[1]} が存在しない`);
        assert.ok(fs.statSync(script).mode & 0o111, `${event}: ${m[1]} に実行権限が無い`);
        const src = fs.readFileSync(script, 'utf8');
        assert.match(src, /^#!\/usr\/bin\/env bash/, `${m[1]}: shebang`);
        assert.match(src, /\nexit 0\s*$/, `${m[1]}: fail-open（末尾 exit 0）を守る`);
      }
    }
  }
});

// --- commands ----------------------------------------------------------------

test('commands/*.md: frontmatter と bash 実行の許可が揃っている', () => {
  const dir = path.join(ROOT, 'commands');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 5, 'commands が想定より少ない');
  for (const f of files) {
    const { fields, body } = readFrontmatter(path.join(dir, f));
    assert.ok(fields.description, `${f}: description が無い`);
    const usesBash = body.includes('```!') || /(^|\s)!`/.test(body);
    if (usesBash) {
      assert.match(fields['allowed-tools'] ?? '', /Bash\(/, `${f}: bash 実行があるのに allowed-tools に Bash が無い`);
    }
    if (body.includes('${CLAUDE_PLUGIN_ROOT}/bin/ulm.js')) {
      assert.ok(fs.existsSync(path.join(ROOT, 'bin/ulm.js')), 'bin/ulm.js が存在しない');
    }
  }
});

// --- skills -------------------------------------------------------------------

test('skills/*/SKILL.md: name がディレクトリと一致し description が仕様内', () => {
  const dir = path.join(ROOT, 'skills');
  const skills = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  assert.ok(skills.length >= 3, 'skills が想定より少ない');
  for (const s of skills) {
    const file = path.join(dir, s.name, 'SKILL.md');
    assert.ok(fs.existsSync(file), `${s.name}: SKILL.md が無い`);
    const { fields } = readFrontmatter(file);
    assert.equal(fields.name, s.name, `${s.name}: frontmatter の name がディレクトリ名と不一致`);
    assert.ok(fields.description, `${s.name}: description が無い`);
    // description + when_to_use の合算上限は 1536 文字（仕様）。余裕を見て守る。
    const total = (fields.description ?? '').length + (fields['when_to_use'] ?? '').length;
    assert.ok(total <= 1536, `${s.name}: description が長すぎる (${total} > 1536)`);
  }
});

// --- 配布パッケージ -------------------------------------------------------------

test('package.json: files にプラグイン動作へ必要な一式が含まれる', () => {
  const pkg = readJson('package.json');
  for (const need of ['bin/', 'src/', 'commands/', 'skills/', 'hooks/', 'scripts/', '.claude-plugin/']) {
    assert.ok(pkg.files.includes(need), `files に ${need} が無い（npm 配布で hooks/CLI が欠ける）`);
  }
});
