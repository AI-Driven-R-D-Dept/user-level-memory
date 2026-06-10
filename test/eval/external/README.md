# 外部評価（作者がgameできない想起品質の検証）

`ulm` の意味的想起が「自作コーパスで有利」でないことを示すため、**作者が本文もクエリも正解も書かない**評価を構築する。

## パイプライン
1. `chunk.js` — `raw/*.md`（実OSSの生ドキュメント: ripgrep/fd/bat/uv/ruff/tokio 等）を観測候補に分割 → `corpus.external.jsonl`（作者は1文字も書かない・`source` で出典追跡可）。
2. `gen-queries.js` — 別LLMが各観測から**症状ベースの質問**を生成（原文語彙を使わない）→ `queries.external.jsonl`。
3. `build-qrels.js` — 各クエリで4経路(recency/fts/vector/hybrid)の上位を pool → 別LLMが TREC スタイルで関連度採点 → `qrels.external.json`。本番コードをそのまま使用。
4. `run-external-eval.js` — Recall@K / Precision@K / MRR / nDCG@K をクエリ bootstrap の95%CI付きで算出。

## 実行
```bash
export OPENAI_API_KEY=...
node chunk.js && node gen-queries.js 44 && node build-qrels.js && node run-external-eval.js 10
```

## 循環バイアスの排除（クロスベンダ検証）
クエリ生成・qrels採点が同じ LLM ファミリだと共バイアスの疑いが残るため、両端を別ベンダに差し替えて測った：

| クエリ生成 × qrels採点 | vector Recall@10 | MRR |
|---|---|---|
| OpenAI × OpenAI（既定） | 95-98% | 83% |
| OpenAI × Claude(subagent) | 100% | 70% |
| Claude(subagent) × OpenAI | 100% | 88% |

どの組み合わせでも意味検索が圧勝。FTS は症状ベースクエリ（語彙回避）で16-32%に留まる。

- 別採点で評価: `ULM_QRELS=qrels-claude.json node run-external-eval.js 10`
- 別生成で評価: `QUERIES_FILE=queries-claude.jsonl node build-qrels.js && QUERIES_FILE=queries-claude.jsonl node run-external-eval.js 10`

## 注意（再現性）
- 既定スナップショット（`queries.external.jsonl` + `qrels.external.json` + `.evalhome`）は相互に整合。
- `build-qrels.js` は毎回 `.evalhome` を作り直し観測 ID が変わるため、**クロスベンダ用 qrels（`qrels-cq.json` / `qrels-claude.json`）は各々のビルド時点の記録**。再現するときは上記コマンドで再生成する（コーパス・クエリは決定的なので結論は安定）。
- `raw/` と `.evalhome/` と各種ログは `.gitignore` 対象（生データは再取得可能、DB は再生成可能）。
