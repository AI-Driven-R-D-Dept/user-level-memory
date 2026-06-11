---
name: memory-export
description: ユーザーレベル長期記憶 (ulm) の中身を JSONL 控えとしてエクスポート（バックアップ/別マシンへの移行/git 差分追跡）する。ユーザーが「記憶をバックアップ/エクスポート/控えを取りたい/別の環境へ移したい/同期したい」と言ったとき、または危険な一括操作（大量削除・reindex・スキーマ移行）の前に控えを取りたいときに使う。復元は import。
allowed-tools: "Bash(node:*)"
---

# memory-export — 長期記憶を JSONL 控えにエクスポート/復元する

ユーザーレベル長期記憶 (ulm) の DB を、安定した順序の JSONL 控えに書き出すスキル。
DB が正本、JSONL は受動的なミラー（差分を git で追える形）。

## なぜ必要か

- 本体は `~/.claude/user-memory/memory.db`（SQLite）。SessionEnd フックが `ulm export --quiet` を
  自動実行しているので、通常は控えが勝手に更新される。
- だが「**今すぐ控えを取りたい**」「**別マシンへ移したい**」「**危険な一括操作の前に保全したい**」
  「**記憶の変化を git で差分追跡したい**」ときは、明示的に export する。

## いつ使うか

- ユーザーが「記憶をバックアップ / エクスポート / 控え / 別環境へ移行 / 同期」と言ったとき
- 大量削除・`reindex`・スキーマ移行・モデル変更など、戻せない操作をする前
- 別マシン/別アカウントへ記憶を持っていきたいとき（export → 転送 → import）

## やり方（エクスポート）

CLI は `${CLAUDE_PLUGIN_ROOT}/bin/ulm.js`。

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ulm.js" export
```

- 出力先は固定で **`$ULM_HOME/export/`**（既定 `~/.claude/user-memory/export/`）。出力先指定オプションは無い。
- 書き出されるファイル:
  - `observations.jsonl` / `states.jsonl` / `candidates.jsonl` / `refs.jsonl`（公開分）
  - `observations.secret.jsonl` / `states.secret.jsonl`（**機密分・別ファイル**）
  - `meta.json`（スキーマ版・統計・エクスポート時刻）
  - `.gitignore`（secret ファイルを除外するよう自動生成）
- スクリプトや自動処理では `--quiet` でファイル一覧を抑制。
- 実行後に `⚠ … 機密の疑い …` 警告が出たら、その観測を `obs secret <id>` で secret 化してから再 export する。

## やり方（復元/移行）

別マシンや復旧時は、export ディレクトリを渡して取り込む:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ulm.js" import <export-dir>
```

- 既存 ID は INSERT OR IGNORE でスキップ（重複は安全に無視）。
- 不正 id / 長すぎる本文 / 不正 status / 壊れた JSON 行は**可視的にスキップ**（件数を表示）するので、出力の `スキップ` 行を確認する。
- 取り込んだ行は取込時ゲートで機密を再判定し secret 化される。`source` 表示で出自を区別できる。

## セキュリティ（最重要）

- **`*.secret.jsonl` は機密そのもの**。自動生成の `.gitignore` で除外されるが、**export ディレクトリを別の場所へコピー/転送/共有するときは secret ファイルを絶対に含めない**（git に add しない・クラウドに上げない）。
- 出力先 `$ULM_HOME/export/` は既定でリポジトリ外（`~/.claude` 配下）。`ULM_HOME` をリポジトリ内に向けている場合は、secret ファイルがコミットされないか必ず確認する。
- 機密の疑い警告は「取りこぼし前提の多層防御」の一環。無視せず対応する。
- 別マシンへ移すときは、転送経路（USB/クラウド/scp 等）でも secret ファイルの扱いに注意する。

## 実行後

エクスポート先のパスと、警告が出たかどうかを簡潔に伝える。機密分が含まれることと、その取り扱い注意を必ず添える。
