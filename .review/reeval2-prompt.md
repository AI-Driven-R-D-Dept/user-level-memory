# 再々評価: 意味的想起(埋め込みハイブリッド)を追加した。実測で 0-100 採点を

前回あなた(または前任)は ulm を 82/100 と採点し、90 への壁を「想起が字句一致(trigram)止まりで
同義語・言い換えを取りこぼす」「評価ハーネスが小規模・有利設計」「searchObservations がBM25上位を
取ってからJS側フィルタで取りこぼす」と指摘した。これらを本質改善した。**実際に動かして**再採点せよ。

## 改善点（実測で検証）
1. **意味的想起(埋め込みハイブリッド)**: `src/embed.js`(OpenAI互換 embeddings) + `src/recall.js`(FTS字句 と 埋め込み意味 を RRF 融合)。
   キーが無ければ FTS のみに degrade。`src/store.js` の obs_vec / vectorSearch。
2. **searchObservations のフィルタを SQL 側へ**: `src/store.js` の WHERE で project/global/tags/secret/archived を適用（取りこぼしバグ修正）。
3. **拡張評価ハーネス**: `OPENAI_API_KEY` を設定して `node test/eval/recall-eval-large.js 5 2000` を実行せよ。
   2000件ノイズ(新しい)＋relevant(古い)、4カテゴリ(exact/paraphrase/synonym/typo)、recency/FTS/hybrid を比較。
4. UX: state --global、source=auto は SessionStart 無条件注入しない(recall 関連時のみ)、npm test 修正。

## 必ず実行
- `export OPENAI_API_KEY=...`（このプロンプト末尾のキー）して `node test/eval/recall-eval-large.js 5 2000`
- `node test/eval/recall-eval.js 5`（旧ハーネス）
- `npm test`（96テスト）
- 一時環境で `ulm init && obs add 数件 && reindex && recall "<同義語クエリ>" --explain`（mode=hybrid/vector を確認）

OPENAI_API_KEY=***REDACTED-OPENAI-KEY-ROTATE-ME***

## 採点
新採点(0-100)、82からの増減と理由、拡張ハーネスの実測値(カテゴリ別)、残る弱点、90に届いたか。
`.review/reeval2-codex.md` に書け。忖度せず、実測ベースで。
