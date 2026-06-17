#!/usr/bin/env bash
# ulm web を tailnet 直アクセスで常時起動する LaunchAgent を導入/削除する（macOS 専用）。
#
# サービスでは tailscale CLI を使わない（--tailnet を使わない）。macOS App Store 版 CLI は
# GUI セッション依存で launchd 下では動かないため、導入時にこのノードの 100.x IP と MagicDNS 名を
# 検出して plist に固定指定する。検出は対話環境（このスクリプト実行時）でのみ行う。
#
# 使い方:
#   contrib/launchd/install.sh            # 導入（検出→plist生成→bootstrap→疎通確認）
#   contrib/launchd/install.sh uninstall  # 解除（bootout + plist 削除）
#   contrib/launchd/install.sh status     # 状態表示
#
# 環境変数で上書き可: ULM_PORT(=8765) ULM_HOME(=~/.claude/user-memory)
set -euo pipefail

LABEL="co.bond-ai.ulm.web-tailnet"
PORT="${ULM_PORT:-8765}"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG="$HOME/Library/Logs/ulm-web-tailnet.log"
DOMAIN="gui/$(id -u)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
ULM_JS="$REPO/bin/ulm.js"
TEMPLATE="$SCRIPT_DIR/ulm-web-tailnet.plist.template"
ULM_HOME_VAL="${ULM_HOME:-$HOME/.claude/user-memory}"

die() { echo "✗ $*" >&2; exit 1; }

uninstall() {
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
    echo "✓ bootout: $LABEL"
  fi
  [ -f "$PLIST" ] && rm -f "$PLIST" && echo "✓ 削除: $PLIST"
  echo "完了。ログは残してあります: $LOG"
}

show_status() {
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state =|pid =|runs =|last exit" || echo "未ロード"
}

resolve_node() {
  command -v node >/dev/null 2>&1 || die "node が見つかりません（PATH を確認）"
  node -e 'process.stdout.write(process.execPath)'  # シムでなく実体の絶対パス
}

resolve_tailscale() {
  local c
  for c in "${ULM_TAILSCALE_BIN:-}" tailscale /opt/homebrew/bin/tailscale /usr/local/bin/tailscale \
           "/Applications/Tailscale.app/Contents/MacOS/Tailscale"; do
    [ -n "$c" ] || continue
    if "$c" version >/dev/null 2>&1; then echo "$c"; return 0; fi
  done
  die "tailscale CLI が見つかりません（Tailscale を起動しているか確認、または ULM_TAILSCALE_BIN を設定）"
}

# launchctl が把握している agent の pid（未ロードなら空）。pipefail 下でも落ちないよう末尾 || true。
managed_pid() { launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^[[:space:]]*pid =' | grep -oE '[0-9]+' | head -1 || true; }
# $PORT を LISTEN しているプロセスの pid（無ければ空）。
listen_pid() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2; exit}' || true; }

install_agent() {
  [ -f "$ULM_JS" ] || die "ulm 本体が見つかりません: $ULM_JS"
  [ -f "$TEMPLATE" ] || die "テンプレートが見つかりません: $TEMPLATE"
  case "$PORT" in ''|*[!0-9]*) die "ULM_PORT は整数で指定してください: $PORT" ;; esac
  { [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]; } || die "ULM_PORT が範囲外です: $PORT"

  local NODE TS DETECT IP NAME
  NODE="$(resolve_node)"
  TS="$(resolve_tailscale)"

  # tailscale status --json を node で解析（app 本体と同じ取り出し方）。非JSON/未接続は明確に失敗。
  DETECT="$(node -e '
    const { execFileSync } = require("node:child_process");
    let raw;
    try { raw = execFileSync(process.argv[1], ["status","--json"], { encoding:"utf8" }); }
    catch { console.error("tailscale status を実行できません"); process.exit(1); }
    let s; try { s = JSON.parse(raw); }
    catch { console.error("tailscale が JSON を返しません（GUI 未起動など）: " + String(raw).trim().split("\n")[0]); process.exit(1); }
    if (s.BackendState && s.BackendState !== "Running") { console.error("Tailscale 未接続: BackendState=" + s.BackendState); process.exit(1); }
    const self = s.Self || {};
    const ip = (self.TailscaleIPs||[]).find(a => /^100\./.test(a));
    const name = String(self.DNSName||"").replace(/\.$/,"").toLowerCase();
    if (!ip) { console.error("100.x IPv4 が取得できません"); process.exit(1); }
    process.stdout.write(ip + "\t" + name);
  ' "$TS")" || die "tailnet 情報の検出に失敗しました"
  IP="${DETECT%%$'\t'*}"
  NAME="${DETECT#*$'\t'}"
  [ -n "$IP" ] || die "100.x IP を検出できませんでした"
  # MagicDNS 無効環境では NAME が空。その場合は IP を表示/疎通/allow-host に使う（IP は常に許可される）。
  [ -n "$NAME" ] || { NAME="$IP"; echo "⚠ MagicDNS 名が無いため IP でアクセスします（tailnet で MagicDNS 無効？）"; }

  echo "検出: IP=$IP  MagicDNS=$NAME  node=$NODE  repo=$REPO  port=$PORT"

  # 別プロセスが既に $PORT を握っていないか（自分の agent 未ロード時のみ fail-fast）。
  local existing
  existing="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2 || true)"
  if [ -n "$existing" ] && ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    echo "$existing" >&2
    die "ポート $PORT は別プロセスが LISTEN 中です。停止するか ULM_PORT=別ポートを指定してください"
  fi

  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"

  # テンプレートは node で安全に埋める（sed のデリミタ |・メタ文字 &/\ の事故を回避）。
  # 一時ファイル → lint → atomic mv。失敗時は既存 plist を温存して fail-closed。
  local TMP; TMP="$(mktemp "${TMPDIR:-/tmp}/ulm-plist.XXXXXX")"
  node -e '
    const fs = require("node:fs");
    const [tpl, out, ...kv] = process.argv.slice(1);
    let s = fs.readFileSync(tpl, "utf8");
    for (let i = 0; i < kv.length; i += 2) s = s.split(kv[i]).join(kv[i + 1]);
    fs.writeFileSync(out, s);
  ' "$TEMPLATE" "$TMP" \
    __LABEL__ "$LABEL" __NODE__ "$NODE" __ULM_JS__ "$ULM_JS" \
    __TAILNET_IP__ "$IP" __MAGICDNS__ "$NAME" __PORT__ "$PORT" \
    __REPO__ "$REPO" __ULM_HOME__ "$ULM_HOME_VAL" __LOG__ "$LOG" \
    || { rm -f "$TMP"; die "plist の生成に失敗しました"; }
  plutil -lint "$TMP" >/dev/null || { rm -f "$TMP"; die "生成した plist が不正です"; }
  mv "$TMP" "$PLIST"  # ここで初めて既存を置換（ここまでの失敗では元 plist が残る）

  # 既存をクリーンに入れ直す（冪等）。bootout は非同期なので未ロードになるまで待ってから bootstrap。
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
    local j
    for j in $(seq 1 25); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.2; done
  fi
  launchctl bootstrap "$DOMAIN" "$PLIST" || die "bootstrap に失敗しました"

  # listen を待つ。port を握るのが本当に agent か確認するため launchctl pid と lsof pid を突合。
  echo -n "起動待ち"
  local i ap lp ok=""
  for i in $(seq 1 40); do
    ap="$(managed_pid)"; lp="$(listen_pid)"
    if [ -n "$ap" ] && [ "$ap" = "$lp" ]; then ok=1; break; fi
    echo -n "."; sleep 0.5
  done
  echo
  if [ -n "$ok" ]; then
    local code
    code="$(curl -s -o /dev/null -w "%{http_code}" "http://$NAME:$PORT/api/summary" || echo 000)"
    echo "✓ 常時起動を導入しました: http://$NAME:$PORT/  (pid $ap / 疎通 HTTP $code)"
  else
    echo "⚠ まだ listen していません（Tailscale 接続後に自動起動します）。ログ: $LOG ／ 状態: $0 status"
  fi
  echo "  ⚠ token 無し公開: tailnet(ACL)内デバイス + このマシン上の任意プロセスが閲覧・承認できます"
  echo "  停止/削除: $0 uninstall ／ 状態: $0 status ／ 反映: launchctl kickstart -k $DOMAIN/$LABEL"
}

case "${1:-install}" in
  install) install_agent ;;
  uninstall) uninstall ;;
  status) show_status ;;
  *) die "使い方: $0 [install|uninstall|status]" ;;
esac
