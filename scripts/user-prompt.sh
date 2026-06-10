#!/usr/bin/env bash
# UserPromptSubmit hook: プロンプトに関連する記憶を BM25 で動的注入する。
# 失敗してもセッションを壊さない（fail-open）: 常に exit 0、stdout は JSON か空のみ。
set +e
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CLI="$PLUGIN_ROOT/bin/ulm.js"
command -v node >/dev/null 2>&1 || exit 0
[ -f "$CLI" ] || exit 0
node "$CLI" recall --hook 2>/dev/null
exit 0
