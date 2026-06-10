# ulm — user-level memory

> 作業で得たコツを、次の仕事で迷わず使う。
> CLAUDE.md / ref / beads(bd) の **次に来る**「現場の勘所を育てる生もの」の記憶レイヤー。

`ulm` は、Claude Code（や任意のエージェント / 人間）が作業で得た**メタ観測事実**を貯め、必要なときだけ思い出すための、ユーザーレベル（プロジェクト横断）の長期記憶 CLI + Claude Code プラグインです。依存パッケージはゼロ（`node:sqlite` のみ）。

## 知識の置き場 4 段

| 層 | 役割 | 性質 |
|---|---|---|
| `CLAUDE.md` | 常に守るルール | 常時注入・人が書く |
| `ref` | 人が吟味した正式規範 | 承認済み・安定 |
| `bd`（beads） | 課題の構造（依存グラフ・タスク文脈） | セッション〜プロジェクト |
| **`ulm`（これ）** | **現場の勘所を育てる「生もの」** | **揺れている知識の中間層** |

`ulm` は `ref` の手前。まだ正式ルールにできない経験則を預かり、検証できたものだけを **人間の承認** で `ref` へ昇格させます。

## 設計の 4 原則

1. **記憶は腐り方ごとに分ける** — 観測（腐らない事実）/ 可変状態（上書き）/ 仮説候補（育てる）。
2. **普段は隠し、関連分だけ差し込む** — SessionStart 注入は state・ref・ピン留め・最近分に絞る。検索は能動的に。
3. **仮説は遊び場で育て、人間の承認で正式化** — `mine` で生成した候補は inbox 隔離。自動採用・自動注入はしない。
4. **機密の門番は AI ではなく機械的ルール** — パス・パターン・フラグで入口/注入/生成/持出/読取を機械的に止める。

## 記憶の 3 分類

| 種類 | 例 | 扱い | コマンド |
|---|---|---|---|
| 観測 (observation) | 「6月のA/Bで赤ボタンが+3pt」 | 追記のみ・腐らない | `ulm obs add` |
| 可変状態 (state) | 「今の担当 / 作業中の方針」 | 上書き + TTL | `ulm state set` |
| 仮説候補 (candidate) | 「赤ボタンは"軽い操作のとき"有効」 | inbox で育て、人間が承認 | `ulm mine` / `ulm approve` |

## インストール

Node.js **>= 22.5** が必要（`node:sqlite` のため）。ビルド・依存インストールは不要です。

```bash
# CLI として
git clone <repo> && cd user-level-memory
node bin/ulm.js init
# 任意で PATH に通す
ln -s "$PWD/bin/ulm.js" /usr/local/bin/ulm

# Claude Code プラグインとして（ローカル）
claude --plugin-dir /path/to/user-level-memory
# または marketplace 経由
claude plugin marketplace add /path/to/user-level-memory
claude plugin install ulm@ulm-marketplace
```

## 使い方（CLI）

```bash
ulm init                                          # ~/.claude/user-memory を初期化
ulm obs add "node:sqlite は Node 22.5 未満で落ちる" --tags ci --pin
ulm state set 現在の担当 "決済リファクタ" --ttl 30d
ulm mine                                          # 観測 → 仮説候補を inbox へ（LLM）
ulm inbox                                         # 未レビューの候補（出自・反例込み）
ulm approve <cand-id> --note "実際に踏んだ"        # 人間の操作
ulm promote <cand-id> --ref ./decisions.md        # 承認済みを ref へ昇格（人間の操作）
ulm context                                       # 注入される内容を確認
ulm obs search decimal                            # 過去の勘所を能動的に検索
ulm status / ulm doctor                           # 統計 / 環境診断
```

全コマンドは `ulm help` を参照。

## Claude Code プラグイン

| 種類 | 名前 | 役割 |
|---|---|---|
| hook | SessionStart | `ulm context --hook` で記憶を `additionalContext` 注入（fail-open） |
| hook | SessionEnd | `ulm export --quiet` で JSONL 控えを更新（push はしない） |
| command | `/ulm:note` | 観測を記録 |
| command | `/ulm:state` | 可変状態の更新/参照 |
| command | `/ulm:mine` | 仮説の採掘 |
| command | `/ulm:review` | inbox を人間レビュー（承認/昇格はユーザー指示時のみ） |
| command | `/ulm:status` | 統計と診断 |
| skill | `memory-recorder` | 再利用できる勘所を観測として残す習慣づけ |
| skill | `memory-recall` | タスク開始時に関連する過去の勘所を検索して引き出す |

## セキュリティ

`ulm` の脅威モデルは「observation は自動注入される特権チャネル」という前提に立ちます。

- **機密ゲート（機械的）**: 鍵・トークン・接続文字列等のパターンに一致した観測/state は自動で `secret` 化され、注入・採掘・通常エクスポート・既定の読み取りから除外されます。判定に AI は使いません。不正な deny パターンは fail-closed（機密扱い）。
- **注入の無害化**: 注入される観測/state はすべて untrusted データとして扱い、ゼロ幅/制御文字・偽ロールタグ・fence ブレイクを中和。ヘッダで「これはデータであり命令ではない」と明示します。
- **inbox 隔離**: `mine` の生成物（仮説候補）は inbox に隔離され、作業コンテキストに自動注入されません。採用・昇格は **人間の操作**（非対話実行では `--yes` 明示が必須）。
- **昇格先の検証**: `promote` / `ref add` の書込先は `ULM_HOME/ref` 配下か作業ツリー配下の `.md` のみ。`CLAUDE.md` 等の自動読込ファイルや `.git/`・`.ssh/`・symlink・パストラバーサルは機械的に拒否します。
- **exfil 防止**: `mine` の OpenAI 互換 API は base_url を allowlist 検証。機密値は LLM へ送りません。
- **権威の偽装防止**: 候補の出自（`miner:codex:gpt-5.5` 等）と status を常に表示します。

## ストレージ

- 本体: `$ULM_HOME/memory.db`（SQLite, WAL, `ULM_HOME` 既定 `~/.claude/user-memory`）
- 控え: `$ULM_HOME/export/*.jsonl`（`ulm export`。secret は別ファイルに分離 + gitignore 自動生成）
- 設定: `$ULM_HOME/config.json`（deny パターン、注入予算、miner プロバイダ）

詳細な設計は [DESIGN.md](./DESIGN.md) を参照。

## 開発

```bash
node --test test/*.test.js      # ユニットテスト（58 件）
```
