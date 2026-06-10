# シミュレーション設計: irodori で ulm の実価値を実証

対象リポジトリ: ~/playground/irodori（実在の Flow Matching TTS, Python, v1/v2/v3 非互換あり）
独立 ULM_HOME: ~/playground/user-test/ulm-sim/.ulmhome

## ストーリー
開発者(+Claude Code)が irodori で作業 → 本物の落とし穴に遭遇 → ulm が観測として記録 →
mine で仮説化 → 人間が承認して ref へ昇格 → 「次のセッション」で記憶が思い出され、同じ失敗を避ける。

## ステップ
1. Session 1: irodori-gotchas が抽出した**実コード根拠ありの観測**を ulm に記録（source=claude）
2. state: 作業中の方針を記録（例: v3 移行作業中）
3. mine（codex 実行）: 観測 → 仮説候補（条件・反例つき）を inbox へ
4. review → approve → promote: 1-2件を ref へ昇格
5. Session 2: `ulm context --hook`（irodori の cwd）で SessionStart 注入を取得 → 関連 gotcha が出るか

## A/B テスト（measurable value）
タスク: 「irodori で手元の v1 チェックポイントを v3 コードで推論したい。進め方を3行で」
- A（記憶なし）: 素の subagent に質問 → v1/v3 非互換を見落とすか
- B（記憶あり）: ulm context を注入した subagent → 非互換を警告できるか
→ 同じ失敗を「次の仕事で迷わず」回避できることの実証

## 測定指標
- 注入された記憶の関連度（irodori 観測が SessionStart に出る件数）
- A/B での pitfall 回避率（B が v1/v3 非互換を指摘し A が見落とすか）
- 記憶の容量効率（注入文字数 vs 全観測）
- 機密ゲート/隔離が誤作動しないか（運用上の安全性）
