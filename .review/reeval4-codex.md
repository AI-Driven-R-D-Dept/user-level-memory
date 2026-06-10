# Re-evaluation 4: read-path secret gate fix

Date: 2026-06-10
Evaluator: Codex

## Verdict

**Score: 92 / 100. 90点に到達。**

前回 89 点の直接ブロッカーだった read-path 漏洩は、指定 PoC では再現しなかった。`importRows()` で入口ゲートを迂回して `secret=0` の HuggingFace 形式トークンを DB/FTS に入れても、`ulm recall "HuggingFace token"` と `ulm context --hook` の注入出力には出なかった。

想起品質も維持されている。大規模評価は hybrid Recall@5 97%、synonym 87%、secret 漏洩 top-5 は FTS/hybrid とも 0。`npm test` は 101/101 pass。

ただし満点ではない。`reindex` の legacy 修復は「embedding 未作成の観測」だけを走査しているため、既に embedding 済みの legacy `secret=0` 機密行は `secret=0` のまま残る。このケースでも recall/context の read-path gate は効くが、DB 修復としての `reindex` 仕様にはまだ穴がある。

## 実測結果

### 指定 PoC: importRows で入口ゲート迂回

一時 `ULM_HOME` を作成し、Node から `openStore()` を使って直接挿入した。

- table: `observations`
- `source`: `import`
- `secret`: `0`
- `pinned`: `1`
- `text`: HuggingFace 形式トークンを含む本文

直接 `store.searchObservations({ query: "HuggingFace token", includeSecret: false })` では対象行が返ることを確認した。つまり DB/FTS 側には `secret=0` として存在しており、PoC 前提は成立している。

その後の CLI 結果:

- `ulm recall "HuggingFace token"`: `（関連する記憶なし）`
- `ulm context --hook` with `SessionStart`: stdout に注入 JSON なし
- 対象行は DB 上では `secret=false` のまま

判定: **read-path 漏洩は塞がった。** `src/recall.js` と `src/context.js` の読み取り時 gate が実際に効いている。

### reindex 修復

同じく `importRows()` で `secret=0` 機密行を直接挿入し、`ulm reindex --limit 10` を実行した。

結果:

- `1 件を機密の疑いで secret 化し、埋め込みから除外しました`
- 対象行の `secretAfterReindex`: `true`
- `embeddingCount`: `0`

判定: **未 embedding の legacy/import 行は reindex で修復される。**

### CLI import

`observations.jsonl` に `secret=0` かつ HuggingFace 形式トークンを含む行を置き、`ulm import <dir>` を実行した。

結果:

- `1 行を機密の疑いで secret 化しました`
- 対象行の `cliImportSecretized`: `true`

判定: **CLI import の入口 gate は効いている。**

### 大規模 recall 評価

Command:

```bash
node test/eval/recall-eval-large.js 5 2000
```

結果:

- recency: Recall@5 0%, MRR 0.000
- FTSのみ: Recall@5 73%, MRR 0.725
- hybrid: Recall@5 97%, MRR 0.931
- exact: hybrid 100%
- paraphrase: hybrid 100%
- synonym: hybrid 87%
- typo: hybrid 100%
- secret 漏洩 top-5: FTS 0, hybrid 0

判定: **要求された hybrid 97% / synonym 87% を維持。**

### 通常テスト

Command:

```bash
npm test
```

結果:

- tests: 101
- pass: 101
- fail: 0

read-path 回帰テストも追加済み:

- `recall: importRows 由来の secret=0 機密は読み取りゲートで除外`
- `context: 読み取り時ゲートで secret=0 の機密混入を注入から除外`

## 残リスク

### reindex は既に embedding 済みの legacy 機密行を修復しない

追加 PoC:

1. `importRows()` で `secret=0` の HuggingFace 形式トークン行を挿入
2. `store.upsertEmbedding()` で既存 embedding を持つ legacy 行に見せる
3. `ulm reindex --limit 10`

結果:

- `埋め込み済み: 1 件、新規なし`
- `secretAfterReindexAlreadyEmbedded`: `false`
- `embeddingCount`: `1`

原因は `cmdReindex()` が `store.observationsNeedingEmbedding()` の結果だけを gate しているため。既に `obs_vec` がある行は pending に入らず、機密疑いでも `secret=1` へ昇格されない。

この残リスクは今回の read-path 注入漏洩には直結しない。`recallObservations()` と `buildContext()` は本文 gate を再適用するため、注入経路では落ちる。ただし「reindex が legacy DB 修復をする」という説明から見ると不完全で、export や低レベル store API を含む運用上の secret 分類としては弱い。

推奨修正:

- `reindex` の先頭で `secret=0 AND redacted=0` の全観測を軽量スキャンし、`gate.match(text) || detectHighEntropy(text)` なら `secret=1` に昇格する。
- その後に embedding pending を計算する。
- 既存 embedding がある機密昇格行は `obs_vec` から削除するのが望ましい。

## 採点内訳

- 指定 read-path 漏洩の修正: 25 / 25
- import/reindex の入口・修復防御: 18 / 20
- 多層防御: 21 / 25
- 誤検知・品質維持: 15 / 15
- テスト・評価カバレッジ: 13 / 15
- 合計: **92 / 100**

結論: `recall` / `context --hook` の read-path 漏洩は実測で塞がった。想起品質も落ちていない。90 点到達と判定する。残る主な課題は、`reindex` の legacy 修復を「既に embedding 済み」の secret=0 機密行まで広げること。
