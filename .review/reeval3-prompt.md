# 最終確認の再評価: 前回の唯一のブロッカー(機密ゲートの穴)を修正した。90点に届いたか実測で

前回、想起の意味化(埋め込みハイブリッド)で 89-90 まで来たが、唯一のブロッカーとして
「HuggingFace hf_ トークンが BUILTIN パターンに無く、高エントロピー検出が警告のみ→secret化されず
埋め込み→recall で漏洩する。『機密の門番は機械的ルール』原則の穴」が指摘された。これを修正した。

## 修正点（実測で検証）
1. `src/gate.js`: hf_/r8_/dop_v1_ 等のトークンパターンを BUILTIN に追加。
2. `src/cli.js` gateWrite: 高エントロピー文字列を **警告→fail-closed(自動secret化)** に格上げ（config.gate.entropy_secret）。
3. 多層防御: capture と reindex が高エントロピー観測を抽出・埋め込みから除外。
4. ゲートの**自動**検出を回帰テスト化（手動 secret:true に頼らない）。

## 必ず実行して確認
- `export OPENAI_API_KEY=***REDACTED-OPENAI-KEY-ROTATE-ME***`
- 一時 ULM_HOME で:
  - `ulm init && ulm obs add "token は hf_SHOULDNOTLEAK1234567890ABCD"` → **自動で secret 化されるか**（手動フラグ無し）
  - `ulm reindex` → 機密が埋め込まれないか
  - `ulm recall "HuggingFace token" ` → トークンが漏れないか
  - 普通の観測「decimal.js は precision 未指定で20桁丸め」は secret 化されない（誤検知しない）か
- `node test/eval/recall-eval-large.js 5 2000`（想起品質は維持されているか: hybrid 97%/synonym 87%）
- `npm test`（99テスト）

## 採点
新採点(0-100)。漏洩バグは塞がったか。誤検知(過剰 secret化)の副作用は許容範囲か。想起品質は維持か。
**90点に到達したか**。`.review/reeval3-codex.md` に。実測ベースで忖度なく。
