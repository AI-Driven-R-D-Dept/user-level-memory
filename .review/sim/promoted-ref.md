
## irodori の checkpoint・tokenizer・codec・embedding は次元や vocab の不一致が推論開始時または学習開始時の ValueError/RuntimeError に直結するため、組み合わせ変更時は config と実体を事前検証する。

- 条件: speaker inversion embedding、text_tokenizer_repo、codec repo、caption_tokenizer、または checkpoint を差し替える irodori の学習・推論環境。
- 反例: 同一リリースで配布された検証済み checkpoint/tokenizer/codec 一式をそのまま使う場合
- 反例: 該当する機能を無効化しており、その依存コンポーネントをロードしない場合
- 根拠: obs-ccc23f, obs-61e0e5, obs-7fc346, obs-3bfa9c
- 出自: miner:codex:gpt-5.5 / 承認 2026-06-10 / 昇格 2026-06-10 (cand-5f70b8)

## irodori v2 の固定長前提と v3 の可変長前提を混同すると、長尺推論の安定性低下や可変長系列のマスク不備が起きやすい。

- 条件: fixed_target_latent_steps、fixed_target_full_mask、--seconds、duration predictor の有無を調整しながら v2/v3 の学習設定や推論長を変更するとき。
- 反例: v2 の固定30秒・750 latent steps 前提に合わせて推論長を抑える場合
- 反例: v3 の可変長学習と duration predictor を前提にした設定だけを使う場合
- 根拠: obs-556a86, obs-fbb036, obs-974007
- 出自: miner:codex:gpt-5.5 / 承認 2026-06-10 / 昇格 2026-06-10 (cand-891f4d)
