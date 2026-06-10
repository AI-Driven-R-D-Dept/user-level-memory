---
description: 可変状態（今の担当・現在地など、上書きされる値）を ulm に記録/参照する
argument-hint: "<key> <value> [--ttl 7d] | get <key> | list"
allowed-tools: "Bash(node:*)"
---

ユーザーレベル長期記憶 (ulm) の**可変状態**を操作します。

可変状態とは「新しい値が古い値を無効化する」種類の記憶です（今の担当タスク、作業中のブランチ方針、一時的な決定など）。観測（腐らない事実）とは別物で、上書きされます。期限切れは自動で無視されます。

入力 `$ARGUMENTS` を解釈して操作してください:
- `<key> <value>` → 設定。揮発的な値には `--ttl 7d` のような期限を付けるとよい。project 固有にするなら `--scope project`。
- `get <key>` → 取得
- `list` → 一覧

例:
```!
node "${CLAUDE_PLUGIN_ROOT}/bin/ulm.js" state list
```

設定する場合（$ARGUMENTS から key と value を組み立てて実行）:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/ulm.js" state set "<key>" "<value>" --ttl 30d
```

機密値（トークン入り URL 等）は記録しないでください。やむを得ない場合のみ `--secret` を付け、注入・エクスポートから除外されることを伝えます。
