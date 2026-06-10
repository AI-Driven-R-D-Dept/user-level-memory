---
description: ulm の統計と環境診断を表示する
allowed-tools: "Bash(node:*)"
---

ユーザーレベル長期記憶 (ulm) の状態を表示します。

```!
node "${CLAUDE_PLUGIN_ROOT}/bin/ulm.js" status
```

```!
node "${CLAUDE_PLUGIN_ROOT}/bin/ulm.js" doctor
```

統計（観測・state・候補・ref の件数）と環境診断（Node バージョン、ULM_HOME、機密ゲート、miner プロバイダの利用可否）を要約して報告してください。警告（⚠）があれば対処法（archive / review など）を案内します。
