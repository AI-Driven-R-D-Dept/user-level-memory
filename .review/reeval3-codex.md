# Re-evaluation 3: secret gate fix

Date: 2026-06-10
Evaluator: Codex

## Verdict

**Score: 89 / 100. 90点にはまだ届かない。**

前回の直接ブロッカーだった「`hf_` token が CLI の通常追加で secret 化されず、embedding/recall に流れる」穴は、指定シナリオでは塞がっている。通常観測の誤 secret 化も見られず、想起品質も維持された。

ただし、多層防御の主張としてはまだ 1 箇所弱い。入口ゲートを通らない既存/インポート済み `secret=0` 行に機密が残っている場合、`reindex` は embedding から除外するが、FTS recall は読み取り時に再ゲートしないため本文を返せる。これは「機密の門番は機械的ルール」という原則の残穴で、90点超えには読み取り側の候補フィルタか既存データの自動 secret 化が必要。

## 実測結果

### 指定シナリオ

一時 `ULM_HOME` で実行:

- `ulm init`
- `ulm obs add "token は hf_SHOULDNOTLEAK1234567890ABCD"`
- `ulm obs add "decimal.js は precision 未指定で20桁丸め"`
- `ulm reindex`
- `ulm recall "HuggingFace token"`

結果:

- 観測総数: 2
- secret 観測: 1
- `hf_...` 観測は手動 `--secret` なしで自動 secret 化: **pass**
- `decimal.js は precision 未指定で20桁丸め` は非 secret: **pass**
- embedding 件数: 1
- `reindex`: 通常観測 1 件のみ embedding 作成
- `recall "HuggingFace token"`: fake token は出力に含まれず、「関連する記憶なし」: **pass**

### 大規模 recall 評価

`node test/eval/recall-eval-large.js 5 2000`

- recency: Recall@5 0%, MRR 0.000
- FTSのみ: Recall@5 73%, MRR 0.725
- hybrid: Recall@5 97%, MRR 0.931
- synonym: hybrid 87%
- secret 漏洩 top-5: FTS 0, hybrid 0

想起品質は要求水準を維持している。

### 通常テスト

`npm test`

- 99 tests
- 99 pass
- 0 fail

`CLI: ゲートが hf_ トークンを自動 secret 化する` と `CLI: 未知形式の高エントロピートークンを fail-closed で secret 化` の回帰テストも通っている。

## 残ブロッカー

### FTS recall の読み取り側に再ゲートがない

追加で、入口ゲートを通らない `secret=0` 行を `importRows` で作り、`reindex` と `recall` を実測した。

結果:

- `reindex` は機密疑いとして embedding から除外: **pass**
- embedding 件数: 0
- しかし `recall "HuggingFace token"` は FTS 経由で fake token 本文を返した: **fail**

原因は `store.searchObservations()` が `o.secret = 0` だけで絞り、`compileGate().match(text)` / `detectHighEntropy(text)` による読み取り時フィルタをしていないこと。`recallObservations()` の FTS 候補も同じ経路なので、古い DB・import・将来の別書き込み経路で `secret=0` の機密が残ると漏洩する。

90点に上げる最短修正:

- `recallObservations()` で FTS/vector 候補を返す前に `gate.match(o.text) || detectHighEntropy(o.text)` を除外する。
- さらに `reindex` で skipped した既存観測を任意で `secret=1` に昇格する、または `ulm doctor/fix` を用意して既存 DB を修復する。
- `importRows` 後、または import コマンド側で通常追加と同じ gateWrite 相当を適用する。

## 軽微な指摘

- `detectHighEntropy()` のコメントは「自動 secret 化はしない」のままで、現在の `gateWrite` の既定挙動とズレている。実装バグではないが、将来のレビューで誤解を招く。
- `reindex` の filtering は `gate.match` と `detectHighEntropy` を filter 2 回で再実行している。実害は小さいが、候補数が増えると無駄が出る。

## 採点内訳

- 指定漏洩バグの直接修正: 23 / 25
- 高エントロピー fail-closed: 17 / 20
- 多層防御: 17 / 25
- 誤検知の副作用: 14 / 15
- 想起品質維持: 15 / 15
- 合計: **89 / 100**

結論: CLI 通常追加からの `hf_` 漏洩は塞がった。だが、read path / import / legacy data まで含めた機械的ゲートとしてはまだ穴があるため、90点到達とは判定しない。
