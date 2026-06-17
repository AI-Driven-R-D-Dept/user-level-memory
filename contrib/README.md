# contrib — ulm web を tailnet で常時起動する

`ulm web --tailnet` は、closed な Tailscale tailnet 上で Web UI を
`http://<node>.<tailnet>.ts.net:<port>/` のまま開けるようにする（`tailscale serve` の HTTPS 終端は使わず、
100.x インターフェースに直バインド）。ここではそれを **OS のサービスとして常時起動**する補助ファイルを置く。

- `launchd/` — macOS（LaunchAgent）。`install.sh` が検出→生成→導入まで自動でやる。
- `systemd/` — Linux（user unit）テンプレート。

## 前提とセキュリティ（必読）

- **トークン無しで公開する**。`--tailnet`（および常時起動）は `--no-token` 前提なので、
  **tailnet(ACL) 内のデバイス＋そのホスト上の任意プロセス**が観測の閲覧・候補 approve をできる。
  自分の closed VPN・信頼できるマシンでのみ使うこと。public へ出す `tailscale funnel` とは併用しない。
- バインドは **100.x（tailnet IF）固定**。`0.0.0.0` にはしない（Wi-Fi/LAN へ漏らさないため）。
- DB は `ULM_HOME`（既定 `~/.claude/user-memory`）を共有する。常時起動プロセスは DB 接続を握り続けるが、
  SQLite なので CLI からの並行追記とは共存する。

## macOS（launchd）

```bash
# 導入（このノードの 100.x IP と MagicDNS 名を検出して plist に固定 → 即起動＋ログイン時自動）
contrib/launchd/install.sh

# 状態 / 解除 / コード変更の反映
contrib/launchd/install.sh status
contrib/launchd/install.sh uninstall
launchctl kickstart -k gui/$(id -u)/co.bond-ai.ulm.web-tailnet
```

ポートを変えるなら `ULM_PORT=9000 contrib/launchd/install.sh`。

**IP 変更時**: 固定した 100.x IP はノードの Tailscale IPv4 が変わると陳腐化して bind 失敗で再起動ループになる。
徴候は `status` の `last exit code` が 0 以外（bind 失敗時は 2）になること、ログ ($LOG) に「バインドできません」が出ること。
`install.sh install` を再実行すれば再検出して直る。

**IPv4 のみ listen**: tailnet バインドは 100.x（IPv4）のみ。MagicDNS の URL は AAAA も引くため、v6 優先クライアントは
Happy Eyeballs の v4 フォールバックで繋がるが、フォールバックしないツール（`curl -6` 等）は接続拒否になる。確実にするなら
`http://100.x.y.z:<port>/`（100.x IP 直）を使う。

**ログ**: `~/Library/Logs/ulm-web-tailnet.log`（単一ファイル・無回転）。Tailscale 断のあいだ再起動ログが
溜まり得る。`install.sh uninstall --purge-log` で消せる。定常運用で気になるなら `newsyslog.d`（macOS）/
`logrotate`（Linux/journald は自動回転）でローテートを。

### なぜ launchd では `--tailnet` を使わないのか

macOS の **App Store / GUI 版 Tailscale CLI は GUI セッションに依存**する。launchd / cron / 最小 env から
`tailscale status --json` を呼ぶと、JSON ではなく
`The Tailscale GUI failed to start ...`（exit 0 だが非 JSON）を返すため、CLI 依存の `--tailnet` は
サービスでは動かない。そこで `install.sh` は**導入時（対話環境で CLI が動くうち）に 100.x IP と
MagicDNS 名を一度だけ検出**し、`--host <IP> --allow-host <name> --no-token` として plist に固定する。
動き続けるサービスは tailscale CLI を一切呼ばない。

> Tailscale 接続前（再起動直後など）は 100.x がまだ無く bind に失敗するが、`KeepAlive` + `ThrottleInterval`
> で 10 秒おきに再試行し、接続が確立すると自動で listen する。

## Linux（systemd, user unit）

リポジトリのルートで実行（プレースホルダを実パスに置換してから enable する）:

```bash
mkdir -p ~/.config/systemd/user
cp contrib/systemd/ulm-web-tailnet.service ~/.config/systemd/user/
# __NODE__/__ULM_JS__ を実パスへ置換（node で安全に。sed だと値中の & や # でパスが壊れる）。
# __NODE__ = node の実体（process.execPath）。asdf/volta/fnm の shim は systemd 下で版を解決できず不可。
# node/repo パスを埋める（パスに空白を含む環境は systemd 側では非対応）。
# ポート/ULM_HOME を変えるなら、置換後にユニットの `--port` と `Environment=ULM_HOME=` を直接編集する
# （ULM_PORT/ULM_HOME 環境変数は launchd の install.sh のみが解釈し、systemd ユニットは固定値）。
node -e 'const fs=require("fs"),f=process.argv[1];fs.writeFileSync(f,fs.readFileSync(f,"utf8").split("__NODE__").join(process.execPath).split("__ULM_JS__").join(process.cwd()+"/bin/ulm.js").split("__REPO__").join(process.cwd()))' \
  ~/.config/systemd/user/ulm-web-tailnet.service
loginctl enable-linger "$USER"   # 常時起動には必須: headless/再起動後も起動させる（無いとログインセッション中のみ稼働）
systemctl --user daemon-reload
systemctl --user enable --now ulm-web-tailnet
```

> `loginctl enable-linger` を省くと、user systemd はログイン中しか動かず**再起動後に上がらない**（headless で特に問題）。

Linux の tailscaled は unix socket 経由なので `--tailnet` が headless でも動く。検出が不安定なら
ユニット内の `ExecStart` を固定指定版（`--host ... --allow-host ... --no-token`）に差し替える。

**停止/削除（teardown）**: tokenless 公開を確実に止める手順（launchd の `install.sh uninstall` に相当）:

```bash
systemctl --user disable --now ulm-web-tailnet
rm ~/.config/systemd/user/ulm-web-tailnet.service
systemctl --user daemon-reload
loginctl disable-linger "$USER"          # 他に linger 必要な user unit が無ければ
journalctl --user --vacuum-time=1d       # 任意。注: vacuum は単一ユニットに絞れずユーザジャーナル全体に効く
```

**IP 変更時 (systemd)**: 起動後にノードの Tailscale IPv4 が変わっても、稼働中の listen socket は落ちないので
`Restart=always` は発火せず、`active (running)` のまま到達不能になる。`systemctl --user restart ulm-web-tailnet`
で `detectTailnet` が再実行され新 IP に bind し直す（固定指定版なら `ExecStart` を編集して restart）。

## メンテ上の注意

- **node は絶対パス**で埋め込む（launchd ジョブの既定 PATH は `/usr/bin:/bin` など最小で、nvm/homebrew/asdf の
  node はそこに無いため `process.execPath` で決め打ちする。`node` を上げたら再導入＝launchd は `install.sh`、
  systemd は `ExecStart` 更新）。systemd の user unit は既定 PATH（`/usr/bin` 等）を持つので、
  Linux の `--tailnet` ExecStart は `tailscale` をその PATH から見つけられる。PATH が特殊な環境では固定指定版
  （`--host/--allow-host/--no-token`）に切り替えること。
- ここでは開発リポジトリの `bin/ulm.js` を指す。プラグイン版に `--tailnet` が載ったら、そちらの `ulm` に向け直してよい。
