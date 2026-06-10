#!/usr/bin/env bash
# SessionEnd hook: JSONL 控えを更新し、未ベクトル化の観測を埋め込む（キーがあれば）。
# fail-open。export と reindex は ULM_HOME 内で完結（push しない）。
set +e
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CLI="$PLUGIN_ROOT/bin/ulm.js"
command -v node >/dev/null 2>&1 || exit 0
[ -f "$CLI" ] || exit 0
node "$CLI" export --quiet >/dev/null 2>&1
node "$CLI" reindex >/dev/null 2>&1   # キーが無ければ no-op
exit 0
