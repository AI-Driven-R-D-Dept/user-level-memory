#!/usr/bin/env bash
# SessionEnd hook: ULM の控え（JSONL）を更新する。
# 注意: export は ULM_HOME/export（リポジトリ外）に書くだけ。git push は行わない（人間の確認を残す）。
set +e

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CLI="$PLUGIN_ROOT/bin/ulm.js"

if ! command -v node >/dev/null 2>&1; then exit 0; fi
if [ ! -f "$CLI" ]; then exit 0; fi

node "$CLI" export --quiet >/dev/null 2>&1
exit 0
