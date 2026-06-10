# 再評価依頼: ulm を改善した。実際に動かして 0-100 で再採点してほしい

あなた（または前任の評価者）は以前この ulm を 62/100 と採点し、最大の弱点として
「SessionStart 注入が関連度検索でなく recency 詰め込み」「検索が LIKE のみ」を挙げた。
それを本質的に改善したので、**実際にコードを読み・動かして** 再採点してほしい。忖度不要。

## 改善点（主張）。実際に検証して
1. **FTS5(trigram) による関連度想起**: `src/store.js` の searchObservations が BM25。
   日本語クエリをトライグラム分解して OR 検索。`ulm recall <query>` と obs search が BM25 化。
2. **UserPromptSubmit hook で動的注入**: `src/context.js` buildRecall + `hooks/hooks.json` の UserPromptSubmit。
   「いま聞かれたこと」に関連する記憶だけを注入（SessionStart の recency 詰め込みと別経路）。
3. **想起品質の評価ハーネス**: `node test/eval/recall-eval.js 5` を実行せよ。
   BM25 vs recency の Recall@5/MRR を実測する。relevant を古く・ノイズを新しく置いた罠つき。
4. **自動キャプチャ(Stop hook)**: `src/capture.js`。transcript から観測を自動抽出(source=auto)。
   機密ゲート2段（LLM 入力行の除去＋抽出結果の破棄）。dedup・上限・dry-run・無効化。
5. **UX 整流**: state に --global/--project、mine が project+global を統合、secret state を非対話でマスク。

## 検証手順（実行を推奨）
- `node test/eval/recall-eval.js 5`（想起品質の実測。BM25 と recency を比較）
- `node --test test/*.test.js`（91 テスト。recall_quality.test.js が回帰を守る）
- 一時 ULM_HOME で `ulm init && ulm obs add ... && ulm recall "<関連語>" --explain`
- `ulm capture --transcript <jsonl> --dry-run`

## 採点してほしい観点（以前と同じ軸で）
1. 想起品質は本当に改善したか（評価ハーネスの数値を見て）。これが最大論点。
2. 記録の習慣化（自動キャプチャ）は急所を解いたか。安全性は妥当か。
3. 設計・セキュリティの一貫性は保たれたか（注入無害化・機密ゲート・人間ゲート）。
4. 残る弱点・誇大広告。90点に届くか。届かないなら具体的に何が足りないか。

## 出力
`.review/reeval-codex.md` に: 新しい採点(0-100)、以前(62)からの増減と理由、評価ハーネスの実測値、
残る弱点、90点に必要なら次の一手。実コードの行番号で根拠を示すこと。
