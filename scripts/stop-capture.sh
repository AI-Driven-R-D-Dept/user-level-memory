#!/usr/bin/env bash
# Stop hook: その回の作業から再利用可能な観測を自動抽出して記録する（source=auto）。
# 非同期・fail-open。LLM 呼び出しを伴うため async:true で応答完了をブロックしない。
set +e
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CLI="$PLUGIN_ROOT/bin/ulm.js"
command -v node >/dev/null 2>&1 || exit 0
[ -f "$CLI" ] || exit 0
node "$CLI" capture --hook >/dev/null 2>&1
exit 0
