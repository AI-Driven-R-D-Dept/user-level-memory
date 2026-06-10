---
description: 蓄積した観測から仮説（クラフト規範の候補）を採掘して inbox に貯める
argument-hint: "[--project P] [--days N] [--dry-run]"
allowed-tools: "Bash(node:*)"
---

ulm の観測から「再利用できる経験則の候補」を LLM で採掘し、**inbox に置くだけ**にします（遊び場の機能）。

重要な原則:
- 採掘結果は**自動採用しません**。候補は inbox に隔離され、作業コンテキストには自動注入されません。
- 採用するかどうかは**人間が決めます**（`/ulm:review`）。あなた（Claude）は候補を勝手に approve / promote しないでください。
- 機密（secret）観測とパターン一致する観測は、LLM へ送る前に機械的に除外されます。

手順:
1. まず何を送るか確認したい場合は `--dry-run` で送信内容を提示する。
2. 実行する（`$ARGUMENTS` のフィルタを尊重）:

```!
node "${CLAUDE_PLUGIN_ROOT}/bin/ulm.js" mine $ARGUMENTS
```

3. 生成された候補（仮説・条件・反例・出自）を要約して報告する。出自が `miner:...` であること（=AIが作った未承認の候補であること）を明示し、レビューは `/ulm:review` で行うよう案内する。

プロバイダは codex（API キー不要）優先、なければ OpenAI 互換 API（環境変数のキー）を使います。
