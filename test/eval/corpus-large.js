// 拡張評価コーパス生成: 現実に近い条件で recency / FTS-only / hybrid を比べる。
// - 複数ドメイン(irodori/webapp/api/infra/ml)の relevant 観測
// - クエリ category: exact(語彙重複) / paraphrase(言い換え) / synonym(字面ゼロ一致) / typo / cross(別ドメイン語)
// - 数千件のノイズ観測（無関係・新しい=recency 罠）
// - secret 観測 + secret 狙いクエリ（漏洩しないこと）
// 決定的（乱数を使わず index ベース）で再現可能。

export const RELEVANT = [
  // [id, project, text, [queries...] , category 別]
  { id: 'r_voicedesign', project: 'irodori', text: 'irodori: v2 VoiceDesign は use_caption_condition が true だと speaker 条件が無効化され reference audio が無視される。話者模倣には speaker 条件が有効な v2 base を使う。',
    queries: { exact: 'v2 VoiceDesign で use_caption_condition と speaker 条件', paraphrase: 'VoiceDesign で参照音声を渡しても話者が似ない', synonym: '声色をコピーしたいのに反映されない', typo: 'VoiceDesign の reference audo が無視される' } },
  { id: 'r_vocab', project: 'irodori', text: 'irodori: tokenizer の vocab_size が checkpoint の text_vocab_size と不一致だと推論ランタイムで ValueError。text_tokenizer_repo の vocab と checkpoint を一致させる。',
    queries: { exact: 'tokenizer vocab_size と text_vocab_size 不一致 ValueError', paraphrase: '推論起動で語彙数が合わずエラー', synonym: '単語辞書のサイズ違いで落ちる', typo: 'tokenizer の vocab_size mismatch' } },
  { id: 'r_latent', project: 'irodori', text: 'irodori: checkpoint の latent_dim と codec の latent_dim が不一致だと推論開始時に ValueError。学習時と同じ DACVAE/codec repo を指定する。',
    queries: { exact: 'latent_dim と codec の次元 mismatch', paraphrase: '推論開始で潜在次元が合わずエラー', synonym: '埋め込み次元の食い違いで起動失敗', typo: 'latnet_dim の mismatch エラー' } },
  { id: 'r_lora', project: 'irodori', text: 'irodori: LoRA v3 で lora_modules_to_save が auto かつ use_duration_predictor が true だと duration_predictor が modules_to_save に自動追加され adapter に含まれる。',
    queries: { exact: 'lora_modules_to_save auto と duration_predictor', paraphrase: 'LoRA の adapter に長さ予測器が入るか', synonym: '追加学習の保存物にデュレーション推定が含まれる', typo: 'lora modules_to_save の duration_predector' } },
  { id: 'r_v1', project: 'irodori', text: 'irodori: v1 checkpoint と preprocessing は v2/v3 コードでは使用不可。v1 を使うなら v1 タグのコードに戻す。',
    queries: { exact: 'v1 checkpoint は v2/v3 コードで使用不可', paraphrase: '古いモデルを新しいコードで動かしたい', synonym: '旧バージョンの重みが最新実装と互換でない', typo: 'v1 chekpoint を v3 で使う' } },
  { id: 'r_caption', project: 'irodori', text: 'irodori: use_caption_condition が true の checkpoint は caption_tokenizer のロードが必須で、未ロードのまま synthesize すると RuntimeError。',
    queries: { exact: 'use_caption_condition の checkpoint は caption_tokenizer 必須', paraphrase: 'caption 有効モデルで合成すると実行時エラー', synonym: '説明文の分割器を読まずに音声生成して落ちる', typo: 'caption_tokenizer を読まず synthsize' } },
  { id: 'r_tailwind', project: 'webapp', text: 'webapp: tailwind の JIT は content 設定漏れでクラスが効かない。purge 対象に全テンプレートを含める。',
    queries: { exact: 'tailwind JIT の content 設定でクラスが効かない', paraphrase: 'tailwind のクラスが反映されない', synonym: 'CSS のスタイルが当たらない', typo: 'tailwnid の class が効かない' } },
  { id: 'r_useeffect', project: 'webapp', text: 'webapp: useEffect の依存配列を空にすると初回マウント時のみ実行される。',
    queries: { exact: 'useEffect 依存配列を空にすると初回のみ', paraphrase: '副作用をマウント時だけ動かしたい', synonym: 'コンポーネント表示時に一度だけ処理を走らせる', typo: 'useEffect の依存配列 空' } },
  { id: 'r_pool', project: 'api', text: 'api: postgres の接続プールはサーバーレスで枯渇しやすい。pgbouncer を挟む。',
    queries: { exact: 'postgres 接続プールがサーバーレスで枯渇', paraphrase: 'DB のコネクションが足りなくなる', synonym: 'データベースの同時接続上限にすぐ達する', typo: 'postgres の接続プールが枯渇' } },
  { id: 'r_nplus1', project: 'api', text: 'api: N+1 クエリは include で eager load して潰す。',
    queries: { exact: 'N+1 クエリを include で eager load', paraphrase: 'クエリが大量発行されて遅い', synonym: '関連データの取得でDBアクセスが膨れる', typo: 'N+1 query を eagar load' } },
  { id: 'r_oom', project: 'webapp', text: 'webapp: vite のビルドは大きな画像で OOM する。public 配下に逃がす。',
    queries: { exact: 'vite ビルドが大きな画像で OOM', paraphrase: 'ビルドがメモリ不足で落ちる', synonym: 'バンドル生成中にメモリを使い切る', typo: 'vite の bulid が OOM' } },
  { id: 'r_edge', project: 'webapp', text: 'webapp: Next.js の middleware は edge runtime だと node:crypto が使えない。runtime を nodejs にする。',
    queries: { exact: 'Next.js middleware の edge runtime で node:crypto', paraphrase: 'ミドルウェアで暗号モジュールが動かない', synonym: 'エッジ環境で Node の組み込み機能が欠ける', typo: 'middleware の edge runtime で node:cryto' } },
  { id: 'r_docker', project: 'infra', text: 'infra: docker のマルチステージで COPY --from を使うとビルドキャッシュが効きやすい。',
    queries: { exact: 'docker マルチステージの COPY --from とキャッシュ', paraphrase: 'コンテナのビルドを速くしたい', synonym: 'イメージ作成の再利用でビルド時間短縮', typo: 'docker の マルチステージ COPY --form' } },
  { id: 'r_cors', project: 'api', text: 'api: CORS の preflight は OPTIONS に 204 を返さないとブラウザが本リクエストを送らない。',
    queries: { exact: 'CORS preflight の OPTIONS に 204', paraphrase: 'ブラウザからのリクエストが CORS で弾かれる', synonym: 'クロスオリジンの事前確認で本通信が止まる', typo: 'CORS の preflght で OPTIONS' } },
  { id: 'r_lr', project: 'ml', text: 'ml: 学習率を上げすぎると loss が発散する。warmup とスケジューラで段階的に上げる。',
    queries: { exact: '学習率を上げすぎると loss が発散', paraphrase: '訓練で損失が爆発する', synonym: 'モデルの最適化が不安定になり値が飛ぶ', typo: '学習率 を上げすぎて loss 発散' } },
];

// secret 観測（漏洩してはいけない）
export const SECRET_OBS = [
  { id: 's_hf', project: 'irodori', secret: true, text: 'irodori: HuggingFace token は hf_SHOULDNOTLEAK1234567890ABCD を使用。' },
];
export const SECRET_QUERIES = ['HuggingFace token は何だっけ', 'irodori の API キー'];

// クロスドメインの紛らわしいノイズ（同じ語を含むが無関係）
const NOISE_TEMPLATES = [
  'webapp: ボタンの色は赤が押されやすい A/B 第{n}回',
  'api: ログのフォーマットを JSON に統一した #{n}',
  'infra: nginx の gzip を有効化した（chunk {n}）',
  'ml: データ拡張で精度が {n}pt 改善',
  'webapp: i18n の翻訳キーを {n} 件追加',
  'irodori: README のバッジ URL を更新 v{n}',
  'api: レートリミットを {n} req/min に設定',
  'infra: terraform の state を s3 に移行 step{n}',
];

export function buildCorpus({ noise = 2000 } = {}) {
  const obs = [];
  // relevant を「古い」(40-70日前)に置く＝recency 罠
  RELEVANT.forEach((r, i) => obs.push({ id: r.id, project: r.project, text: r.text, days_ago: 40 + i, tags: [], secret: false }));
  SECRET_OBS.forEach((s) => obs.push({ id: s.id, project: s.project, text: s.text, days_ago: 50, tags: ['secret'], secret: true }));
  // ノイズを「新しい」(0-5日前)に置く＝recency が上位を占める
  for (let i = 0; i < noise; i++) {
    const t = NOISE_TEMPLATES[i % NOISE_TEMPLATES.length].replace('{n}', String(i));
    const project = t.split(':')[0];
    obs.push({ id: `n_${i}`, project, text: t, days_ago: (i % 6), tags: [], secret: false });
  }
  return obs;
}

export function buildQueries() {
  const qs = [];
  for (const r of RELEVANT) {
    for (const [cat, q] of Object.entries(r.queries)) {
      qs.push({ q, relevant: [r.id], category: cat, project: r.project });
    }
  }
  return qs;
}
