---
description: approved の仮説候補を project の skill (.claude/skills) へ一括昇格する（承認判断は行わない・機械的処理のみ）
argument-hint: "[--name slug]"
allowed-tools: "Bash(node:*)"
---

承認済み（approved）の仮説候補を、まとめて現在の project の skill（`.claude/skills/ref-<name>/SKILL.md`）へ昇格します。
skill は常時コンテキストには読み込まれず、description（発動条件）にマッチしたときだけ本文がロードされます。

> 関連する**既存** skill を agent に更新させて PR を出したい場合は `ulm promote <id> --pr`（別経路）。この command は
> 候補を1件ずつ新規 skill としてローカル生成する一括処理です。
> `--pr` の注意: git リポジトリ・remote・gh CLI が前提（remote 無しは push 段で失敗、gh 無しは push まで＝候補は
> approved のまま再実行可）。`--name` を付けると既存 skill との照合をスキップし常に新規 `ref-<slug>` を作る。
> `--dry-run` でも LLM は実呼び出しする（生成プレビューのため）ので、内容確認には `--pr --dry-run` を使う。

**この command の契約（厳守）:**
- 対象は **status=approved の候補のみ**。inbox の候補を承認したり、rejected を復活させたりしません。
  承認判断そのものは `/ulm:review` で人間が行います（この command は判断済みのものを処理するだけ）。
- `promote --yes` の `--yes` は「ユーザーの明示指示があった」ことを表します。`/ulm:promote` の起動だけでなく、
  「promote 作業して」「承認済みを昇格して」のような自然言語の依頼も明示指示に含みます。
  逆に、ユーザーの依頼なしに（タスクのついで等で）この手順を実行してはいけません。

手順:

1. approved の候補を一覧する:

```!
node "${CLAUDE_PLUGIN_ROOT}/bin/ulm.js" cand list --status approved --json
```

2. 0 件なら「approved の候補はありません。承認は `/ulm:review` で行えます」と伝えて終了する。
3. 1 件以上あれば、昇格対象のリスト（id・仮説・条件・project）を簡潔に提示してから、各候補を昇格する:
   - 各候補の仮説から **読みやすい skill 名**（英小文字・数字・ハイフン、64 文字以内。例: `ref-engines-check-first`）を
     考えて付ける: `node "${CLAUDE_PLUGIN_ROOT}/bin/ulm.js" promote <id> --name <slug> --yes`
     （`--name` を省略すると `ref-<id>` で生成される。生成先は常に `.claude/skills/ref-*`）
   - promote は **その候補の project の作業ツリー内で実行する**必要がある（候補の project と現在地が
     不一致だとエラーになる）。別 project の候補が混ざっていたら、その分は実行せず「その project で
     /ulm:promote を実行してください」と報告する。
4. 結果を一覧で報告する: 昇格できた候補（id → 生成された SKILL.md のパス）と、失敗した候補
   （エラーメッセージそのまま）。失敗を握りつぶしたり、リトライで別名・別場所に書いたりしない。

注意:
- 書込先は「検証済み slug から組み立てた `<project>/.claude/skills/ref-<slug>/SKILL.md`」のみ。任意パスは
  受け取れず、既存 skill への上書きも拒否されます（拒否されたらその旨をそのまま報告する）。
  ※ 既存 skill の更新は `--pr` 経路でのみ、LLM が選んだ実在 slug に限り許可されます（この一括 command では不可）。
- SKILL.md には origin（`miner:<model>` 等)・承認日・候補 ID が自動で記録されます。出自の偽装はできません。
