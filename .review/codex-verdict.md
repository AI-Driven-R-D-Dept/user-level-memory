# codex exec（gpt-5.5, low）による ulm 価値レビュー

> read-only sandbox で codex 自身は書き込めなかったため、codex の最終回答を転記。

- **総合評価: 62/100**
- **一行サマリ**: 思想は現場の痛みに刺さるが、現状の実装価値は「安全なローカルメモ帳 + フック」止まり。長期記憶レイヤーとしての勝負所である検索・想起品質・運用継続性が弱い。
- **最大の弱点**: `context` が実質 `state + ref + pinned + 最近の project/global 観測` を詰めるだけで、現在タスクに対する関連度検索がない。
- **もし1つだけ直すなら**: SQLite FTS/BM25 などで SessionStart 時の想起品質を上げること。

## 実装上の主な根拠（codex が実コードから引いた）
- `buildContext` は関連度ランキングなしで固定順に詰めるだけ: src/context.js:21
- 検索は `LIKE` 部分一致のみ: src/store.js:162
- project 識別は git root の basename のみで衝突しやすい: src/project.js:20
- candidate は自動注入されず件数だけ出す点は設計通り: src/context.js:103
- 機密ゲートと sanitize は比較的きちんとある: src/gate.js:5, src/gate.js:130
- `state get` は secret state もそのまま出す: src/cli.js:298
- manual candidate は機密検出が警告止まりで、export には candidates 全体が出る: src/cli.js:354, src/exporter.js:27

## 評価者注（ulm 作者側の補足）
- 「関連度検索なし（recency 詰め込み）」は DESIGN.md §10 で意図的に MVP 非スコープにした点。codex の指摘は正当で、記憶が増えた時の想起劣化は実在のリスク。→ 改善候補の筆頭。
- `state get <key>` の secret 露出は「人間が明示的にキー指定で取得する」操作で、SessionStart 自動注入とは別経路。とはいえ `state list` は *** マスクするので非対称。改善余地あり。
