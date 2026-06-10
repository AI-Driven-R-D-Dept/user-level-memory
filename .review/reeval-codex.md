# ulm 再評価

## 採点

**82/100**（以前 62/100 から **+20**）

最大の減点だった「SessionStart の recency 詰め込み」「検索が LIKE のみ」は、本質的に改善されています。特に UserPromptSubmit で、その場の prompt に対して BM25 検索した観測だけを注入する経路が入ったのは大きいです。一方で、90 点にはまだ届きません。理由は、評価ハーネスが小さく語彙重複寄りで、実運用の記憶混雑・スコープ・タグ・短いクエリ・言い換え耐性までは測れていないこと、自動キャプチャが便利な反面で外部送信/抽出品質/レビュー導線の詰めがまだ甘いことです。

## 実測

実行コマンド:

```bash
node test/eval/recall-eval.js 5
node --test test/*.test.js
```

結果:

- `node test/eval/recall-eval.js 5`: FTS=true, n=10, K=5
- BM25: `Recall@5=1.0`, `MRR=1.0`, `secret_leaks=0`
- recency: `Recall@5=0.2`, `MRR=0.163`, `secret_leaks=0`
- `node --test test/*.test.js`: 91 tests, 91 pass

補足: `npm test` は失敗しました。`package.json:12-14` の script が `node --test test/` になっており、この環境の Node v24.14.0 では `Cannot find module .../test` になります。指定手順の `node --test test/*.test.js` は通っていますが、通常の品質ゲートとしては直すべきです。

一時 `ULM_HOME` でも確認しました。`ulm init`, `ulm obs add`, `ulm recall "参照音声で声が似ない VoiceDesign" --explain` は動作し、FTS=true で該当観測だけを `<user-memory kind="recall" trust="data">` として注入しました。`ulm capture --transcript <jsonl> --dry-run` も動作し、機密パターン入り行を落とした後の transcript 長だけを表示しました。

## 根拠

- FTS5 trigram は `src/store.js:85-123` で仮想テーブル、トリガ、既存行バックフィルを作っています。
- 日本語を含むクエリのトライグラム OR 化は `src/store.js:131-161`。英数語はフレーズも足す設計です。
- BM25 検索本体は `src/store.js:273-305`。`bm25(obs_fts) AS rank` で順位付けし、FTS 不可や構文エラー時は LIKE recency にフォールバックします。
- UserPromptSubmit の動的注入は `src/context.js:127-155` と `src/cli.js:632-678`。hook JSON は `src/context.js:157-165` で `hookEventName` を切り替えています。
- hook 配線は `hooks/hooks.json:16-26` と `scripts/user-prompt.sh:1-10`。
- 自動キャプチャは `src/capture.js:24-56` で transcript から user/assistant だけを抽出し、LLM 入力前に機密行を除去します。抽出結果の保存前 gate は `src/capture.js:58-70`、dedup と `source=auto` 保存は `src/capture.js:96-115`。
- 注入の無害化は `src/gate.js:130-147`。山括弧タグ、偽ロール、制御文字、fence を中和しています。
- 人間ゲートは `src/cli.js:59-65`、secret state の非対話マスクは `src/cli.js:330-335` と `src/cli.js:351-356`。

## 評価

想起品質は、前回の 62 点評価時点から明確に改善しています。recency baseline を罠コーパスで潰し、BM25 が古い relevant を top-1 で拾うことを実測できています。これは「長期記憶として使えるか」の中核に効く改善です。

自動キャプチャも、記録が習慣化しない問題への答えとして方向は正しいです。Stop hook 配線、dry-run、無効化、上限、dedup、機密ゲート二段は揃っています。ただし、デフォルト enabled で provider auto なのは、実運用では明示的な初回同意や送信先表示がほしいです。抽出された `source=auto` 観測も、未レビューのまま recall 対象になるため、誤抽出が増えた時の品質劣化リスクがあります。

セキュリティ設計はかなり一貫しています。入口 gate、注入 sanitize、secret 除外、人間ゲート、import の id/source 矯正まで見ています。ただし regex gate は未知形式の機密に弱く、capture の「機密行を落とす」方式は同じ行の有用情報も落とす一方、複数行にまたがる秘密や未登録形式は残り得ます。

## 残る弱点

- 検索評価が 10 クエリの合成コーパスで、語彙重複が強いです。日本語の言い換え、短いクエリ、typo、記憶が数千件ある状態、project scope と global の混在までは保証していません。
- `searchObservations` は BM25 top `limit * 4` を取ってから JS 側で project/tag/secret/archive フィルタします（`src/store.js:286-296`）。スコープ外やタグ外の高ランク候補が多いと、本来のヒットを取りこぼします。
- 3 文字未満のクエリは FTS に乗らず LIKE になります（`src/store.js:131-134`, `src/store.js:281-305`）。略語や短い固有名で弱いです。
- FTS が使えない環境では静かに LIKE に戻ります（`src/store.js:121-123`, `src/store.js:297-304`）。ユーザーが性能低下に気づきにくいです。
- 自動キャプチャの抽出品質を測る eval がありません。秘密漏洩テストはありますが、「腐らない観測だけを抽出できるか」「誤った観測を作らないか」の回帰が薄いです。
- `npm test` が壊れています。採点への影響は小さいですが、基本の開発体験として減点です。

## 90 点に必要な次の一手

1. 評価を拡張する。最低でも 100+ クエリ、project/global/tag フィルタ、短いクエリ、言い換え、typo、数千件ノイズ、auto 観測混入を含め、Recall@K だけでなく precision@K / nDCG / false positive を見る。
2. `searchObservations` のフィルタを SQL 側に寄せる。project/global/tags/secret/archive を FTS JOIN の WHERE に入れ、`limit * 4` 後処理の取りこぼしを消す。
3. 自動キャプチャを「未レビュー auto 観測は recall 注入で弱く扱う、または初回は inbox 的な確認を挟む」設計にする。少なくとも auto の重み/件数制限と review UI がほしい。
4. 初回設定で capture の外部送信先、送信される抜粋、無効化方法を明示する。dry-run も sanitized transcript のプレビューを安全に出せると検証しやすい。
5. `npm test` を `node --test test/*.test.js` など実際に通る形へ修正する。

結論として、今回の改善は「見せかけ」ではありません。以前の最大論点だった想起は実装・hook・評価の三点で前進しており、62 点から 82 点へ上げる価値があります。ただし、現在の 1.0/1.0 は小さな罠コーパス上の値であり、90 点台を主張するには実運用に近い評価と auto capture の品質管理が足りません。
