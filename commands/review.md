---
description: inbox の仮説候補を人間がレビューできるよう提示する（採用判断は人間）
argument-hint: "[候補ID]"
allowed-tools: "Bash(node:*)"
---

ulm の inbox にある未レビューの仮説候補を、ユーザーがレビューできるように提示します。

**この command の契約（厳守）:**
- あなた（Claude）の仕事は、候補を**提示し、反例込みで中立に説明する**ことだけです。
- `approve` / `reject` / `promote` の実行は、**ユーザーがこの場で明示的に指示したときのみ**行います。勝手に採用・昇格しないでください。
- 各候補の**出自（origin）**を必ず伝えてください。`miner:...` は AI が生成した未承認の仮説であり、「育った知識」ではありません（権威の偽装を避ける）。

手順:
1. inbox を表示する:

```!
node "${CLAUDE_PLUGIN_ROOT}/bin/ulm.js" inbox
```

2. 各候補について、仮説・**効く条件**・反例・根拠（observation id）・出自を整理して提示する。条件と反例を特に重視する（「どこで効くか」が本体）。
3. ユーザーの判断を仰ぐ。ユーザーが明示的に指示した場合のみ、対応する操作を実行する:
   - 承認: `node "${CLAUDE_PLUGIN_ROOT}/bin/ulm.js" approve <id> --note "<理由>"`
   - 却下: `node "${CLAUDE_PLUGIN_ROOT}/bin/ulm.js" reject <id> --note "<理由>"`
   - 条件を磨く: `node "${CLAUDE_PLUGIN_ROOT}/bin/ulm.js" cand edit <id> --conditions "<狭めた条件>"`
   - skill へ昇格（承認済みのみ）: `node "${CLAUDE_PLUGIN_ROOT}/bin/ulm.js" promote <id> [--name <slug>]`（`ref-` は自動付与。省略時は `ref-<id>`）
4. promote は project の skill（`.claude/skills/ref-<slug>/SKILL.md`）への昇格です。検証済み slug から組み立てたパスのみ生成され、任意パスへの書込・既存 skill の上書きは機械的に拒否されます（既存 skill の更新は `promote --pr` 経路でのみ・実在 ref-* skill に限り可能）。
5. approved が複数溜まっている場合は、`/ulm:promote` で一括昇格できることを案内する（人間の判断は approve で済んでいるため、昇格は機械的処理でよい）。
