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

ポートを変えるなら `ULM_PORT=9000 contrib/launchd/install.sh`。ログは `~/Library/Logs/ulm-web-tailnet.log`。

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
node -e 'const fs=require("fs"),f=process.argv[1];fs.writeFileSync(f,fs.readFileSync(f,"utf8").split("__NODE__").join(process.execPath).split("__ULM_JS__").join(process.cwd()+"/bin/ulm.js"))' \
  ~/.config/systemd/user/ulm-web-tailnet.service
systemctl --user daemon-reload
systemctl --user enable --now ulm-web-tailnet
loginctl enable-linger "$USER"   # ログアウト後も動かすなら
```

Linux の tailscaled は unix socket 経由なので `--tailnet` が headless でも動く。検出が不安定なら
ユニット内の `ExecStart` を固定指定版（`--host ... --allow-host ... --no-token`）に差し替える。

## メンテ上の注意

- **node は絶対パス**で埋め込む（launchd は PATH を持たないため決め打ちが必要。`node` を上げたら再導入＝launchd は
  `install.sh`、systemd は `ExecStart` 更新）。systemd の user unit は既定 PATH（`/usr/bin` 等）を持つので、
  Linux の `--tailnet` ExecStart は `tailscale` をその PATH から見つけられる。PATH が特殊な環境では固定指定版
  （`--host/--allow-host/--no-token`）に切り替えること。
- ここでは開発リポジトリの `bin/ulm.js` を指す。プラグイン版に `--tailnet` が載ったら、そちらの `ulm` に向け直してよい。
