---
description: approved の仮説候補を ref へ一括昇格する（承認判断は行わない・機械的処理のみ）
argument-hint: "[--ref file.md]"
allowed-tools: "Bash(node:*)"
---

承認済み（approved）の仮説候補を、まとめて ref（正式ルールの Markdown）へ昇格します。

**この command の契約（厳守）:**
- 対象は **status=approved の候補のみ**。inbox の候補を承認したり、rejected を復活させたりしません。
  承認判断そのものは `/ulm:review` で人間が行います（この command は判断済みのものを処理するだけ）。
- `promote --yes` の `--yes` は「ユーザーがこの command を起動した」という明示指示を表します。
  ユーザーの起動なしにこの手順を実行しないでください。

手順:

1. approved の候補を一覧する:

```!
node "${CLAUDE_PLUGIN_ROOT}/bin/ulm.js" cand list --status approved --json
```

2. 0 件なら「approved の候補はありません。承認は `/ulm:review` で行えます」と伝えて終了する。
3. 1 件以上あれば、昇格対象のリスト（id・仮説・条件）を簡潔に提示してから、各候補を昇格する:
   - `node "${CLAUDE_PLUGIN_ROOT}/bin/ulm.js" promote <id> --yes`
   - ユーザーが引数で `--ref <file.md>` を指定した場合は全件にそれを付ける（既定は `ULM_HOME/ref/promoted.md`）。
4. 結果を一覧で報告する: 昇格できた候補（id → 昇格先パス）と、失敗した候補（エラーメッセージそのまま）。
   失敗を握りつぶしたり、リトライで別の昇格先に書いたりしない。

注意:
- 昇格先は ULM_HOME/ref 配下か作業ツリー配下の .md に限られます。CLAUDE.md 等の自動読込ファイルへの
  追記は safepath が機械的に拒否します（拒否されたらその旨をそのまま報告する）。
- 昇格文面には origin（`miner:<model>` 等)・承認日・候補 ID が自動で記録されます。出自の偽装はできません。
