# 再々評価: 意味的想起(埋め込みハイブリッド) 実測採点

## 結論

**新採点: 90/100（前回 82 から +8）**

90 には届いた、と判断する。前回の主要な壁だった「字句一致止まりで同義語・言い換えを取りこぼす」は、実測でかなり解消している。特に 2000 件の新しいノイズに古い relevant を混ぜた拡張ハーネスで、hybrid が全体 Recall@5 **97%**、MRR **0.931**、synonym Recall@5 **87%** まで出たのは大きい。

ただし 92-95 点帯にはまだ置かない。理由は、評価がまだ合成コーパス中心であること、埋め込みが外部 API と `reindex` 運用に依存すること、`vectorSearch` が SQLite から全ベクトルを読み JS で cosine 計算する設計で大規模化に弱いこと、`recall` がスコア閾値なしで低関連候補も混ぜうることが残るため。

## 実行結果

実行日: 2026-06-10  
環境: `OPENAI_API_KEY` 設定あり。キー文字列は記録しない。

### 拡張ハーネス

実行:

```bash
node test/eval/recall-eval-large.js 5 2000
```

結果:

```text
拡張評価: K=5 ノイズ=2000件 埋め込み=2015件

全体 Recall@5 / MRR:
  recency : Recall=0%  MRR=0.000
  FTSのみ : Recall=73%  MRR=0.725
  hybrid  : Recall=97%  MRR=0.931

カテゴリ別 Recall@5 (recency / FTS / hybrid):
  exact      :   0% / 100% / 100%
  paraphrase :   0% /  73% / 100%
  synonym    :   0% /  20% /  87%
  typo       :   0% / 100% / 100%

secret 漏洩(top-5): FTS=0 hybrid=0
```

カテゴリ別の hybrid MRR:

| category | n | recency Recall@5 | FTS Recall@5 | hybrid Recall@5 | hybrid MRR |
|---|---:|---:|---:|---:|---:|
| exact | 15 | 0.000 | 1.000 | 1.000 | 1.000 |
| paraphrase | 15 | 0.000 | 0.733 | 1.000 | 0.900 |
| synonym | 15 | 0.000 | 0.200 | 0.867 | 0.822 |
| typo | 15 | 0.000 | 1.000 | 1.000 | 1.000 |

評価: 前回指摘した「同義語・言い換えを取りこぼす」は本質改善されている。FTS が synonym 20% しか拾えない条件で hybrid 87% まで上げており、単なる微修正ではない。

### 旧ハーネス

実行:

```bash
node test/eval/recall-eval.js 5
```

結果:

```text
FTS=true  n=10  K=5
BM25    Recall@5=1  MRR=1  secret_leaks=0
recency Recall@5=0.2  MRR=0.163  secret_leaks=0
```

旧ハーネスでは BM25 が満点。これは前回同様、旧ハーネスが字句一致寄りで有利な設計であるため、今回の主判断材料は拡張ハーネス側とした。

### 通常テスト

実行:

```bash
npm test
```

結果:

```text
tests 96
pass 96
fail 0
```

### 一時環境 CLI 検証

実行内容:

```bash
ULM_HOME=$(mktemp -d)/ulm
node bin/ulm.js init
node bin/ulm.js obs add "...Tailwind CSS..." --project demo --tags frontend
node bin/ulm.js obs add "...Node sqlite..." --project demo --tags node
node bin/ulm.js obs add "...Postgres..." --project demo --tags db
node bin/ulm.js reindex
node bin/ulm.js recall "見た目が変わらない CSS が効いていない" --project demo --explain
```

結果要点:

```text
✓ 埋め込み作成: 3 件（model=text-embedding-3-small, 累計 3 件）
query="見た目が変わらない CSS が効いていない" project=demo mode=hybrid fts=true embeds=3 hits=3
  fused=0.0325 obs-156276 Tailwind CSS の content 設定が不足すると、クラスが生成されずスタイルが反映されない
```

`mode=hybrid` と `embeds=3` を確認。言い換えクエリで Tailwind の観測が 1 位に出た。一方、候補数が少ないと無関係な Postgres/Node 観測も後続に混ざったため、精度面の残課題は残る。

## 改善点ごとの判定

1. **意味的想起(埋め込みハイブリッド)**: 合格。`src/recall.js` の FTS + vector + RRF は、拡張ハーネスで synonym 20% → 87%、全体 73% → 97% を実測。
2. **キーなし degrade**: 設計上は `embedAvailable(config)` と例外時 FTS fallback で成立。通常テストにも API キーなしケースがある。
3. **searchObservations の SQL 側フィルタ**: コード上、FTS JOIN の `WHERE` に `project/global/scopes/tags/secret/archived` が入っており、LIMIT 前に効く。`npm test` のタグ LIMIT 回帰も通過。
4. **拡張評価ハーネス**: 旧 10 query よりかなり現実寄り。2000 noise、60 query、4カテゴリ、secret leak を見ている。
5. **UX 修正**: `npm test` 通過。`source=auto` を SessionStart 無条件注入しない実装も `src/context.js` 上で確認できる。

## 残る弱点

- **評価はまだ合成コーパス**: 60 query は前より良いが、実プロジェクトログ由来のブラインド評価ではない。90 点には届くが、95 点級の根拠には足りない。
- **外部 embeddings API 依存**: キーがないと FTS に落ちる。これは graceful だが、意味的想起の価値は環境依存。
- **`reindex` 運用が手動**: 新規観測が即ベクトル化されるわけではない。運用上、hook/cron/差分 reindex の設計が欲しい。
- **vectorSearch が全件 JS スキャン**: 数千件ならよいが、数万から先は遅くなる。SQLite 拡張や近似近傍、少なくとも project/tag prefilter + limit 戦略が必要。
- **スコア閾値・precision 制御が弱い**: CLI 検証で関連 1 件の後に無関係候補も出た。`limit` だけでなく fused/sim threshold や多様性抑制があると実利用のノイズが減る。
- **RRF の重みが固定**: FTS と vector の信頼度をクエリ種別で変えないため、英数字トークンが重要な障害調査では vector が邪魔するケースがありうる。

## 採点理由

前回 82 点の主な減点理由は、想起が字句一致止まり、評価が小規模、検索フィルタが LIMIT 後処理で取りこぼす、の 3 点だった。今回、それぞれに実装と実測が入った。

- 想起品質: +5。hybrid の synonym/paraphrase 改善が明確。
- 評価信頼性: +2。2000 noise + 4カテゴリの拡張評価で、旧ハーネス依存から脱した。
- 検索正確性/安全性: +1。SQL 側フィルタと secret leak 0 を確認。

合計で **82 → 90**。大台には乗ったが、まだ「ローカル長期記憶として大規模・長期運用しても強い」とまでは言い切れないため、90 ちょうどに留める。
