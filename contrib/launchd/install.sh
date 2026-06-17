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
    # ラベル(service-target)で bootout する。パス形式は plist が消えていると Label を読めず失敗するため。
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    # bootout は非同期（SIGTERM→SIGKILL）。unload 完了まで待ってから判定する（install と同じ猶予）。
    local j
    for j in $(seq 1 50); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.2; done
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      die "bootout に失敗し agent がまだ動いています（tokenless 公開中）。手動: launchctl bootout $DOMAIN/$LABEL"
    fi
    echo "✓ bootout: $LABEL"
  fi
  [ -f "$PLIST" ] && rm -f "$PLIST" && echo "✓ 削除: $PLIST"
  if [ "${1:-}" = "--purge-log" ]; then
    rm -f "$LOG" && echo "✓ ログ削除: $LOG"
  else
    echo "完了。ログは残してあります（消すには $0 uninstall --purge-log）: $LOG"
  fi
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
# 自分の agent が握る host:port の pid（無ければ空）。agent は具体 IP に bind するので @IP で確認できる。
listen_pid() { lsof -nP -iTCP@"$1":"$2" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2; exit}' || true; }
# bind(ip:port) と競合する listener の pid 群。具体 IP 一致 + ワイルドカード(*/0.0.0.0/[::])。
# 別の具体 IP（127.0.0.1 等）は競合しないので除外する。@IP フィルタはワイルドカード bind を取りこぼすため :port 全件から判定。
conflict_pids() {
  lsof -nP -iTCP:"$2" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2, $9}' | while read -r p name; do
    host="${name%:*}" # NAME の最後の :port を除いたローカルアドレス
    case "$host" in "$1"|'*'|'0.0.0.0'|'[::]'|'::') printf '%s\n' "$p" ;; esac
  done | sort -u || true
}

install_agent() {
  [ -f "$ULM_JS" ] || die "ulm 本体が見つかりません: $ULM_JS"
  [ -f "$TEMPLATE" ] || die "テンプレートが見つかりません: $TEMPLATE"
  case "$PORT" in ''|*[!0-9]*) die "ULM_PORT は整数で指定してください: $PORT" ;; esac
  { [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]; } || die "ULM_PORT が範囲外です: $PORT"

  local NODE TS DETECT IP NAME
  NODE="$(resolve_node)"
  TS="$(resolve_tailscale)"

  # tailscale status --json を node で解析（app 本体と同じ取り出し方）。非JSON/未接続は明確に失敗。
  # cli.js detectTailnet と同じく 5s でタイムアウト（wedge した CLI で無限ハングしない）。
  DETECT="$(node -e '
    const { execFileSync } = require("node:child_process");
    let raw;
    try { raw = execFileSync(process.argv[1], ["status","--json"], { encoding:"utf8", timeout: 5000 }); }
    catch { console.error("tailscale status を実行できません（タイムアウト/未起動）"); process.exit(1); }
    let s; try { s = JSON.parse(raw); }
    catch { console.error("tailscale が JSON を返しません（GUI 未起動など）: " + String(raw).trim().split("\n")[0]); process.exit(1); }
    if (s.BackendState && s.BackendState !== "Running") { console.error("Tailscale 未接続: BackendState=" + s.BackendState); process.exit(1); }
    const self = s.Self || {};
    // CGNAT 100.64.0.0/10 のみ（cli.js isCgnatIp と一致。public な 100.x を tokenless 公開しない）
    const isCgnat = (ip) => { const o = String(ip).split("."); return o.length===4 && Number(o[0])===100 && Number(o[1])>=64 && Number(o[1])<=127; };
    const ip = (self.TailscaleIPs||[]).find(a => isCgnat(a));
    const name = String(self.DNSName||"").replace(/\.$/,"").toLowerCase();
    if (!ip) { console.error("CGNAT(100.64.0.0/10) の IPv4 が取得できません"); process.exit(1); }
    process.stdout.write(ip + "\t" + name);
  ' "$TS")" || die "tailnet 情報の検出に失敗しました"
  IP="${DETECT%%$'\t'*}"
  NAME="${DETECT#*$'\t'}"
  [ -n "$IP" ] || die "100.x IP を検出できませんでした"
  # MagicDNS 無効環境では NAME が空。その場合は IP を表示/疎通/allow-host に使う（IP は常に許可される）。
  [ -n "$NAME" ] || { NAME="$IP"; echo "⚠ MagicDNS 名が無いため IP でアクセスします（tailnet で MagicDNS 無効？）"; }

  echo "検出: IP=$IP  MagicDNS=$NAME  node=$NODE  repo=$REPO  port=$PORT"

  # bind(IP:$PORT) と競合する listener（具体IP一致 + ワイルドカード）を、自分の管理下 agent 以外で検出したら fail-fast。
  # 別 IF（127.0.0.1:$PORT 等）の無関係な listener では誤って止めない。0.0.0.0:$PORT も取りこぼさない。
  local mpid foreign
  mpid="$(managed_pid)"
  foreign="$(conflict_pids "$IP" "$PORT" | grep -v -x -F "${mpid:-__none__}" || true)"
  if [ -n "$foreign" ]; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null >&2 || true
    die "ポート $PORT は別プロセス（pid: $(printf '%s' "$foreign" | tr '\n' ' ')）が LISTEN 中です。停止するか ULM_PORT=別ポートを指定してください"
  fi

  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"

  # テンプレートは node で安全に埋める（sed のデリミタ/メタ文字を回避）。値は XML エスケープして
  # <string> に入れる（パスや ULM_HOME に & < > が含まれても妥当な plist になる）。
  # 一時ファイル → lint → atomic mv。失敗時は既存 plist を温存して fail-closed。
  local TMP; TMP="$(mktemp "${TMPDIR:-/tmp}/ulm-plist.XXXXXX")"
  node -e '
    const fs = require("node:fs");
    const [tpl, out, ...kv] = process.argv.slice(1);
    const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const map = {};
    for (let i = 0; i < kv.length; i += 2) map[kv[i]] = esc(kv[i + 1]);
    // 単一パス置換: 置換後テキストを再走査しない（値に __PORT__ 等が含まれても壊さない）。
    const s = fs.readFileSync(tpl, "utf8").replace(/__[A-Z_]+__/g, (m) => (m in map ? map[m] : m));
    fs.writeFileSync(out, s);
  ' "$TEMPLATE" "$TMP" \
    __LABEL__ "$LABEL" __NODE__ "$NODE" __ULM_JS__ "$ULM_JS" \
    __TAILNET_IP__ "$IP" __MAGICDNS__ "$NAME" __PORT__ "$PORT" \
    __REPO__ "$REPO" __ULM_HOME__ "$ULM_HOME_VAL" __LOG__ "$LOG" \
    || { rm -f "$TMP"; die "plist の生成に失敗しました"; }
  plutil -lint "$TMP" >/dev/null || { rm -f "$TMP"; die "生成した plist が不正です"; }
  # ここで初めて既存を置換（ここまでの失敗では元 plist が残る）。失敗時も temp を残さず案内する。
  mv "$TMP" "$PLIST" || { rm -f "$TMP"; die "plist の設置に失敗しました（$PLIST に書き込めません）"; }

  # 既存をクリーンに入れ直す（冪等）。bootout は非同期なので未ロードになるまで待ってから bootstrap。
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true  # ラベル形式（plist 消失でも Label 不要）
    local j
    for j in $(seq 1 50); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.2; done
    # まだ残っていれば bootstrap は確実に失敗する。古い agent を動かしたまま fail-closed で止める。
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      die "既存 agent の unload がタイムアウトしました。少し待って再実行してください（$0 install）"
    fi
  fi
  launchctl bootstrap "$DOMAIN" "$PLIST" || die "bootstrap に失敗しました（少し待って $0 install を再実行してください）"

  # listen を待つ。port を握るのが本当に agent か確認するため launchctl pid と lsof pid を突合。
  echo -n "起動待ち"
  local i ap lp ok=""
  for i in $(seq 1 40); do
    ap="$(managed_pid)"; lp="$(listen_pid "$IP" "$PORT")"
    if [ -n "$ap" ] && [ "$ap" = "$lp" ]; then ok=1; break; fi
    echo -n "."; sleep 0.5
  done
  echo
  if [ -n "$ok" ]; then
    # 疎通は参考表示（成功判定は pid 突合で確定済み）。bind は IPv4 100.x なので IP 直・v4 固定・短timeout で
    # 叩く（MagicDNS の v6 race や名前未解決によるハング/誤 000 を避ける）。Host=IP は allowlist に含まれる。
    # curl は失敗時に %{http_code} へ自分で 000 を出すので、|| echo 000 で二重化しない。
    local code
    code="$(curl -4 -s --connect-timeout 2 --max-time 5 -o /dev/null -w "%{http_code}" "http://$IP:$PORT/api/summary" || true)"
    code="${code:-000}"
    echo "✓ 常時起動を導入しました: http://$NAME:$PORT/  (pid $ap / 疎通 HTTP $code)"
  else
    # listen 未確認の原因は Tailscale 未接続とは限らない（ポート競合・--host IP 陳腐化・node 異常等）。
    # 実 exit code を出して断定を避ける。
    local lec
    lec="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -i 'last exit' | head -1 | tr -s ' ' || true)"
    echo "⚠ まだ listen していません（${lec:-状態不明}）。原因: Tailscale 未接続 / ポート競合 / --host IP 陳腐化 など。ログ確認: $LOG ／ 状態: $0 status"
  fi
  echo "  ⚠ token 無し公開: tailnet(ACL)内デバイス + このマシン上の任意プロセスが閲覧・承認できます"
  echo "  停止/削除: $0 uninstall ／ 状態: $0 status ／ 反映: launchctl kickstart -k $DOMAIN/$LABEL"
}

case "${1:-install}" in
  install) install_agent ;;
  uninstall) uninstall "${2:-}" ;;
  status) show_status ;;
  *) die "使い方: $0 [install|uninstall [--purge-log]|status]" ;;
esac
