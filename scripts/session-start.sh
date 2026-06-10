#!/usr/bin/env bash
# SessionStart hook: ULM の長期記憶を additionalContext として注入する。
# 失敗してもセッション起動を壊さない（fail-open）: 常に exit 0、stdout は JSON か空のみ。
set +e

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CLI="$PLUGIN_ROOT/bin/ulm.js"

# node が無ければ静かに諦める
if ! command -v node >/dev/null 2>&1; then
  exit 0
fi
if [ ! -f "$CLI" ]; then
  exit 0
fi

# stdin の hook JSON（cwd 等）をそのまま CLI に渡す。CLI 側で project を解決する。
node "$CLI" context --hook 2>/dev/null
exit 0
