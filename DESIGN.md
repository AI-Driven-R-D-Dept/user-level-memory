# ulm — user-level-memory 設計書

「作業で得たコツを、次の仕事で迷わず使う」ための、ユーザーレベル（プロジェクト横断）長期記憶レイヤー。
CLI `ulm` と Claude Code プラグインで構成する。

## 0. ポジション — 知識の置き場は4段

| 層 | 役割 | 性質 |
|---|---|---|
| CLAUDE.md | 常に守るルール | 常時注入・人が書く |
| ref | 人が吟味した正式規範 | 人間の承認済み・安定 |
| bd (beads) | 課題の構造（依存グラフ・タスク文脈） | セッション〜プロジェクト規模 |
| **ulm（本プロジェクト）** | **現場の勘所を育てる「生もの」の記憶** | **揺れている知識の中間層** |

ulm は ref の手前。まだ正式ルールにできない経験則を預かり、検証できたものだけを人間の承認で ref へ昇格させる。

## 1. 設計原則（PDF「Claude Code 長期記憶の設計」より）

1. **記憶は全部混ぜず、性質（腐り方）ごとに分けて扱う。**
2. **普段は隠し、関連する分だけ作業中に差し込む。**
3. **仮説は遊び場で育て、人間の承認で正式化する。**（自動採用は禁止）
4. **機密の門番は AI ではなく機械的ルール。**（パス・タグ・パターンで入口で止める）

## 2. 記憶の3分類

| 種類 | 例 | どう腐るか | 扱い方 | テーブル |
|---|---|---|---|---|
| A. 観測 (observation) | 「6月のA/Bで赤ボタンが+3pt」 | 腐らない（過去は変わらない） | 消さず追記するだけ | `observations` |
| B. 候補/クラフト規範 (candidate) | 「赤ボタンは "軽い操作のとき" 有効」 | 条件が本体（どこで効くか） | 人が吟味して ref に昇格 | `candidates` |
| C. 可変状態 (state) | 「今いる場所 / 今の担当」 | 新しい値が古い値を無効化 | 上書き + 期限切れは無視 | `states` |

加えて **ref ポインタ**（正式ルールの所在だけを持つ）を `refs` テーブルで管理する。

### ライフサイクル（神殿と遊び場）

```
① 観測がたまる        ulm obs add（追記のみ・削除しない）
② 突然変異 — AI       ulm mine: 観測 → 仮説+反例+条件 を inbox へ（candidates.status=inbox）
③ 自然選択 — 人間     ulm review/approve/reject: 反例込みで人間が判断
④ 昇格 — ref へ       ulm promote: 承認済み候補だけを ref ファイルへ追記（人間の操作）
```

- **神殿（厳格）**: ref・機密・現在状態。勝手な生成・統合は禁止。
- **遊び場（創発OK）**: candidates(inbox)。自由に生成してよいが、**普段の作業コンテキストには絶対に自動注入しない**（件数の通知のみ）。

## 3. ストレージ

- 本体: **ローカル SQLite**（`node:sqlite`、ネイティブ依存ゼロ）。`$ULM_HOME/memory.db`
- `ULM_HOME` 既定値: `~/.claude/user-memory`（環境変数で上書き可。テストはこれで分離）
- 控え: **JSONL エクスポート**（`ulm export` → `$ULM_HOME/export/*.jsonl`）。差分を git で追える。
  - secret な観測は `observations.secret.jsonl` に分離出力（gitignore しやすくする）
- 設定: `$ULM_HOME/config.json`（deny パターン、注入予算、miner プロバイダ等）

### スキーマ

```sql
observations(
  id TEXT PRIMARY KEY,           -- obs-<hash6> ゼロコンフリクト
  ts TEXT NOT NULL,              -- ISO8601
  project TEXT,                  -- 例: "user-level-memory"（git root の basename）
  text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',  -- JSON array
  source TEXT NOT NULL DEFAULT 'manual',  -- manual | claude | import
  secret INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}'   -- cwd, session_id, bd issue 等
)
states(
  key TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',  -- global | <project>
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,               -- NULL = 無期限。期限切れは読み取り時に無視
  PRIMARY KEY (key, scope)
)
candidates(
  id TEXT PRIMARY KEY,           -- cand-<hash6>
  ts TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'inbox',  -- inbox | approved | rejected | promoted
  hypothesis TEXT NOT NULL,
  conditions TEXT NOT NULL DEFAULT '',   -- どこで効くか（条件が本体）
  counterexamples TEXT NOT NULL DEFAULT '[]',  -- JSON array
  evidence TEXT NOT NULL DEFAULT '[]',   -- JSON array of obs ids
  origin TEXT NOT NULL,          -- manual | miner:<model>（権威の偽装防止: 出自を常に表示）
  project TEXT,
  reviewed_at TEXT,
  promoted_to TEXT,              -- 昇格先 ref ファイルパス
  note TEXT NOT NULL DEFAULT ''
)
refs(
  id TEXT PRIMARY KEY,           -- ref-<hash6>
  path TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  project TEXT
)
```

## 4. CLI 仕様

```
ulm init                                  # ULM_HOME 初期化（db, config, export/）
ulm obs add <text> [--project P] [--tags a,b] [--secret] [--source S] [--meta json]
ulm obs list [--project P] [--tags t] [--days N] [--all] [--json]
ulm obs search <query> [--json]
ulm state set <key> <value> [--scope S] [--ttl 7d|24h|30m]
ulm state get <key> [--scope S]
ulm state list [--all]                    # 既定は有効なもののみ
ulm cand add <hypothesis> [--conditions C] [--counter x --counter y] [--evidence obs-..]
ulm inbox                                 # status=inbox の候補一覧（出自・反例込み）
ulm show <id>                             # obs/cand 詳細
ulm approve <id> [--note N]               # 人間の操作
ulm reject <id> [--note N]                # 人間の操作
ulm promote <id> [--ref <file>]           # approved → ref へ追記（人間の操作）
ulm ref add <path> [--note N] [--project P]
ulm ref list
ulm mine [--project P] [--days N] [--limit M] [--provider codex|opencode|openai] [--dry-run]
ulm context [--project P] [--hook] [--json]   # 注入用コンテキスト生成
ulm export [--quiet]                      # JSONL スナップショット
ulm doctor                                # 診断
```

### ID 規約
beads に倣いハッシュ ID（`obs-a1b2c3` / `cand-x9y8z7`）。並行追記でも衝突しない。

### `ulm context` — 思い出させ方

- **隠すのが既定**: 全部は見せない。予算（既定: 観測10件 / 全体4000字）内で関連分だけ。
- 含むもの: ①有効な state（global + 当該 project）②当該 project の最近の観測 + global タグ付き観測 ③ref ポインタ ④inbox 件数の通知のみ（中身は出さない）
- 含まないもの: secret な観測（機械的に除外）、candidates の中身、期限切れ state
- `--hook` 時: stdin の hook JSON（cwd 等）から project を自動解決し、SessionStart 用の
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}` を出力

## 5. 機密ゲート（機械的・入口で止める）

1. **入口ゲート**: `obs add` 時に deny パターン（`sk-…`, `AKIA…`, `ghp_…`, `password=` 等の組込み + config 追加分）に一致したら **自動で secret フラグ付与 + 警告**。`--secret` 手動指定も可。
2. **注入ゲート**: `context` は secret=1 を絶対に出さない。
3. **生成ゲート**: `mine` の LLM ペイロードから secret=1 とパターン一致行を機械的に除外。state 値は LLM に送らない。
4. **持出ゲート**: export は secret を別ファイルに分離。
- 判定に AI は使わない。すべて正規表現とフラグ（**判定のために機密を AI へ渡さない**）。

## 6. candidate miner（遊びは1機能だけ）

- `ulm mine`: ゲート通過後の観測（project/期間/件数で絞る）を LLM に渡し、
  `{hypothesis, conditions, counterexamples[], evidence[]}` の JSON 配列を生成 → **inbox に置くだけ**。
- プロバイダ抽象:
  - `codex`: `codex exec`（gpt-5.5, reasoning low）をサブプロセス起動。API キー不要。
  - `opencode`: `opencode run --agent plan`（読み取り専用エージェント）をサブプロセス起動。API キー不要
    （opencode CLI 側の認証 / OpenCode Go 等のサブスクに乗る）。モデルは `config.miner.opencode_model`。
  - `openai`: OpenAI 互換 chat/completions。`base_url`/`model` は config、キーは **環境変数のみ**（config・DB・リポジトリに保存しない）。
  - **auto 解決は codex → opencode の順**（どちらも定額側）。openai（従量課金 API）への**暗黙フォールバックはしない** —
    キーが設定されているだけで Stop hook ごとに従量課金が走る事故を防ぐため、`provider: "openai"` の明示時のみ使う。
- 重複防止: hypothesis の正規化ハッシュで既存候補と突合。
- **隠し命令対策**: 観測テキストは「データ」としてフェンス内に渡し、プロンプトで命令解釈を禁止。
  生成物はどのみち inbox 隔離（自動採用なし・自動注入なし）なので、汚染の影響範囲は人間レビューで遮断される。
- **権威の偽装対策**: origin（`miner:<model>`）と status を inbox/show/昇格文面に常に表示。

## 7. Claude Code プラグイン（plugin 名: `ulm`）

```
.claude-plugin/plugin.json     # マニフェスト
.claude-plugin/marketplace.json
hooks/hooks.json               # SessionStart → ulm context --hook / SessionEnd → ulm export
commands/note.md               # /ulm:note   観測を記録
commands/state.md              # /ulm:state  可変状態の更新
commands/mine.md               # /ulm:mine   仮説の採掘
commands/review.md             # /ulm:review inbox を人間レビュー（approve/reject/promote はユーザー指示時のみ）
commands/promote.md            # /ulm:promote approved を ref へ一括昇格（判断は approve 済み・機械的処理のみ）
commands/status.md             # /ulm:status 統計と doctor
skills/memory-recorder/SKILL.md  # 作業中に得た再利用可能なコツを自動で obs add する習慣づけ
bin/ulm.js (+src/)             # CLI 本体（プラグインに同梱、ビルド不要）
```

- hooks は `${CLAUDE_PLUGIN_ROOT}/bin/ulm.js` を参照（インストール先に依存しない）。
- **/ulm:review の契約**: Claude は inbox を提示し反例込みで説明するだけ。approve/reject/promote の実行は、ユーザーがその場で明示した指示があるときのみ。skill/command 本文に明記する。
- **/ulm:promote の契約**: 人間ゲートの本体は approve（inbox の選別）にある。approved → promoted は機械的処理なので、
  /ulm:promote は approved の候補を一括で `promote --yes` してよい（--yes はユーザーが command を起動したことの明示指示）。
  inbox には触れない。昇格先制限（safepath）と origin の常時記録は従来どおり機械的に効く。
- memory-recorder skill: 「条件付きで再利用できる知見」を見つけたら `ulm obs add --source claude` で記録するよう促す（記録は観測のみ。候補化は mine の仕事）。

## 8. セキュリティ脅威モデル（PDF の3つの落とし穴）

| 落とし穴 | 対策 |
|---|---|
| 生成時の漏れ（機密を外部送信） | §5 生成ゲート: 機械的除外を LLM 呼び出しの前段に固定 |
| 隠し命令の保存（prompt injection の永続化） | 候補は inbox 隔離・自動注入なし・人間レビュー必須。注入されるのは観測/state/ref のみで、observation はユーザー由来 or Claude が記録した事実テキスト |
| 権威の偽装（AI 仮説が育った知識の顔をする） | origin/status の常時表示。ref へ昇格できるのは人間が approve した候補のみ（昇格自体は /ulm:promote で一括処理可） |

## 9. テスト戦略

1. **ユニット**: `node --test`。storage CRUD・TTL・ゲート（パターン/フラグ）・context 予算・miner JSON パース・ID 衝突。
2. **CLI 統合**: `ULM_HOME=$(mktemp -d)` で bin を実行し stdout/exit code を検証。
3. **hook シミュレーション**: SessionStart の stdin JSON を流し additionalContext JSON を検証。
4. **tmux E2E**: `~/playground/user-test/ulm-e2e/` に擬似プロジェクトを作り、実際の操作フロー
   （init → obs add → state → mine → review → promote → context）を tmux ペインで実行・検証。
   可能なら実際の `claude` ヘッドレス/対話セッションでプラグイン読込みと hook 発火を確認。
5. **fresh-context subagent レビュー**: 設計・コード（正確性/セキュリティ）・UX/ドキュメントを
   それぞれ独立コンテキストの subagent が批判的にレビュー → 指摘を修正。

## 9.5. 想起（recall）— 字句 + 意味のハイブリッド

SessionStart の recency 詰め込みだけでは「古いが関連する記憶」を取りこぼす。想起品質を上げるため2層を持つ。

- **字句層（FTS5 trigram / BM25）**: `node:sqlite` の FTS5。日本語クエリはトライグラム分解して OR 検索。
  `vocab_size` のような特異トークンに強い。`obs_fts` 仮想テーブル + トリガで観測に同期。
- **意味層（埋め込み・任意）**: OpenAI 互換 embeddings を `obs_vec` に貯め、クエリベクトルと cosine。
  「スタイルが反映されない ⇄ クラスが効かない」のような**字面ゼロ一致の同義語**を拾う。キーが無ければ自動で無効化し字句層のみで動く（依存ゼロを崩さない）。
- **融合（RRF）**: 両層のランクを Reciprocal Rank Fusion で統合し、どちらの取りこぼしも補完する。
- **動的注入**: `UserPromptSubmit` hook で「いま聞かれたこと」に関連する観測だけを注入（`ulm recall --hook`）。
  SessionStart の無条件注入とは別経路で、source=auto（未レビュー）は SessionStart に出さず recall（関連時のみ）に委ねる。

評価: `test/eval/recall-eval-large.js`（2000件ノイズ・4カテゴリ）で recency 0% / FTS 73% / hybrid 97%、同義語 20%→87% を実測。回帰テストで固定。

## 9.6. 自動キャプチャ — 記録を「お願い」でなく「仕組み」に

`Stop` hook で、その回の作業 transcript から再利用可能な観測を LLM で抽出し `source=auto` で記録する。
機密ゲートを2段（LLM 入力行の除去 + 抽出結果の破棄）かけ、dedup・1セッション上限・dry-run・無効化を備える。

言い換え重複は2層で抑止する。第1層: 抽出プロンプトに直近の既存観測（ゲート済み）を見せて同義の再出力を抑止。
第2層: 保存前に FTS(trigram) で全DBから候補 top-K を引き（候補テキストにも生成ゲートを適用）、LLM のバッチ
1回呼び出しでペア単位の同一性を判定して重複をスキップする（retrieve-then-judge）。類似度の閾値分類は
「同事実の言い換え」と「同型文の別事実」を分離できないと実測済みのため、検索は候補生成のみに使い判定はしない。
判定不能・候補ID不一致（幻覚）は保存側に倒す。`capture.dedup_judge` で無効化可。

抽出物は未レビュー扱いで、無条件注入はせず recall の関連時のみ。人間は redact/promote で取捨。
LLM が無い環境では静かに no-op（degrade gracefully）。

手動経路（`obs add`）にもバックストップがある: 保存後に FTS + trigram 弱フィルタ（閾値0.4・警告専用）で
似た既存観測を stderr に警告する（保存は止めない・断定もしない・取りこぼしあり）。警告の stderr は
skill/command 経由で Claude のコンテキストに載るため実質 LLM ペイロードであり、候補には judge と同じ
二条件ゲート（deny + 高エントロピー）を一様に適用する。

## 10. 非スコープ（MVP では作らない）

- 自動統合・自動要約・セマンティック減衰（「重い自動整理」はしない設計）
- チーム同期・リモートストレージ（ローカル第一。export を git 管理すれば足りる）
- bd 本体との双方向連携（meta に bd issue id を書ける、までに留める）
- ローカル完結の埋め込み（量子化モデル同梱）。現状は外部 embeddings API が任意で要る（無くても字句層で動く）。

## 11. 技術選定

- **ランタイム**: Node.js >= 22.5（`node:sqlite`）。依存パッケージ **ゼロ**・ビルド不要（plain ESM JS + JSDoc）。
  プラグイン配布時に npm install 不要であることを最優先。
- **テスト**: `node --test`（追加依存なし）
