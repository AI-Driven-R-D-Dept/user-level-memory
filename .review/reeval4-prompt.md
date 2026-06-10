# 最終確認: read-path の漏洩穴も塞いだ。90点に届いたか実測で

前回 89/100。あなたは「searchObservations が secret=0 だけで絞り、読み取り時に gate を再適用しないため、
importRows 等で入った secret=0 の機密が FTS recall 経由で漏れる」穴を PoC で示した。これを修正した。

## 修正点
1. `src/recall.js` と `src/context.js`: 注入候補に **読み取り時ゲート**（gate.match(text) || detectHighEntropy(text)）を適用。
2. `src/cli.js` cmdImport: 取込時に機密行を secret 化。
3. reindex: 機密疑いの secret=0 観測を secret=1 に昇格（legacy DB 修復）。

## 必ず実行して PoC を再試行
- `export OPENAI_API_KEY=***REDACTED-OPENAI-KEY-ROTATE-ME***`
- 一時 ULM_HOME で、Node から `openStore` を使い `importRows("observations",[{... secret:0, text に hf_トークン ...}])` を直接挿入（入口ゲート迂回）
- その後 `ulm recall "HuggingFace token"` と `ulm context --hook`（SessionStart）で **トークンが漏れないか**
- `node test/eval/recall-eval-large.js 5 2000`（hybrid 97%/synonym 87% 維持か）
- `npm test`（101テスト）

## 採点
新採点(0-100)。read-path の漏洩は塞がったか。想起品質は維持か。**90点に到達したか**。
残るなら何か。`.review/reeval4-codex.md` に。実測ベースで忖度なく。
