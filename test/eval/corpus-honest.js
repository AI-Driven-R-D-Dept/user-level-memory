// 正直な評価コーパス v2 — eval-integrity 監査の3バイアスを是正する。
//  (1) recency strawman の是正: relevant の半分を「最近」(1-9日)、半分を「古い」(40-70日)に置く。
//      → recency は最近-relevant を拾える(0%でなくなる)。古い-relevant は recency が落とし hybrid が拾う、で公平比較。
//  (2) cross カテゴリの実装: 同ドメインに紛らわしい hard-negative を複数置き、特定の1件を当てさせる。
//  (3) 重いタイポ: 1-2文字でなくローマ字化・連続破損を含む。
// FTS/vector/hybrid を4-way で測り、FTS の寄与とタイポ耐性を正直に晒す。

// 各 relevant: id, project, text, fresh(最近に置くか), queries{exact,synonym,typo,cross}
// cross クエリは、同 project の hard-negative（似た話題）と弁別が必要なもの。
export const ITEMS = [
  { id: 'h_pool', project: 'api', fresh: false,
    text: 'api: postgres の接続プールはサーバーレスで枯渇しやすい。pgbouncer を挟む。',
    hardneg: ['api: postgres の VACUUM が長時間ロックを取ると接続が詰まる。autovacuum を調整する。', 'api: redis の接続が TLS ハンドシェイクで遅い。コネクションを使い回す。'],
    queries: { exact: 'postgres 接続プール サーバーレス pgbouncer', synonym: 'DBの同時接続上限にすぐ達する', typo: 'postgres no setuzoku pool ga kokatu', cross: 'サーバーレスで pg の接続が枯渇する件（VACUUM やredisでなく）' } },
  { id: 'h_oom', project: 'web', fresh: true,
    text: 'web: vite のビルドは大きな画像で OOM する。public 配下に逃がす。',
    hardneg: ['web: webpack のソースマップ生成でメモリを食う。devtool を変える。', 'web: jest のワーカーが多すぎてメモリ不足。maxWorkers を絞る。'],
    queries: { exact: 'vite ビルド 大きな画像 OOM', synonym: 'バンドル生成中にメモリを使い切る', typo: 'vite no bulid ga gazou de OOM', cross: 'vite のビルドが画像でメモリ不足（webpack や jest でなく）' } },
  { id: 'h_tailwind', project: 'web', fresh: false,
    text: 'web: tailwind の JIT は content 設定漏れでクラスが効かない。purge 対象に全テンプレートを含める。',
    hardneg: ['web: CSS modules はクラス名がハッシュ化されて検証が面倒。', 'web: styled-components は SSR でクラス順がズレてちらつく。'],
    queries: { exact: 'tailwind JIT content クラスが効かない', synonym: 'CSSのスタイルが当たらない', typo: 'tailwnid no class ga kikanai', cross: 'tailwind のクラスが出ない（CSS modules や styled でなく）' } },
  { id: 'h_edge', project: 'web', fresh: true,
    text: 'web: Next.js の middleware は edge runtime だと node:crypto が使えない。runtime を nodejs にする。',
    hardneg: ['web: Next.js の app router は use client を付け忘れると hooks が動かない。', 'web: Next.js の画像最適化は外部ドメインを next.config で許可する。'],
    queries: { exact: 'Next.js middleware edge runtime node:crypto', synonym: 'エッジ環境でNodeの組み込み機能が欠ける', typo: 'nextjs no midleware de edge runtaim', cross: 'middleware で crypto が動かない（hooks や画像でなく）' } },
  { id: 'h_cors', project: 'api', fresh: false,
    text: 'api: CORS の preflight は OPTIONS に 204 を返さないとブラウザが本リクエストを送らない。',
    hardneg: ['api: JWT の有効期限切れは 401 を返してリフレッシュさせる。', 'api: レート制限超過は 429 と Retry-After を返す。'],
    queries: { exact: 'CORS preflight OPTIONS 204', synonym: 'クロスオリジンの事前確認で本通信が止まる', typo: 'CORS no preflght de OPTIONS', cross: 'ブラウザが OPTIONS で止まる（JWT や 429 でなく）' } },
  { id: 'h_nplus1', project: 'api', fresh: true,
    text: 'api: N+1 クエリは include で eager load して潰す。',
    hardneg: ['api: トランザクション分離レベルを上げるとデッドロックが増える。', 'api: インデックス不足でフルスキャンが走る。EXPLAIN で確認。'],
    queries: { exact: 'N+1 クエリ include eager load', synonym: '関連データ取得でDBアクセスが膨れる', typo: 'N+1 query wo eagar rohdo', cross: 'クエリが大量発行される（デッドロックやフルスキャンでなく）' } },
  { id: 'h_lr', project: 'ml', fresh: false,
    text: 'ml: 学習率を上げすぎると loss が発散する。warmup とスケジューラで段階的に上げる。',
    hardneg: ['ml: バッチサイズを上げると汎化性能が落ちることがある。', 'ml: ドロップアウトを強くしすぎると学習が進まない。'],
    queries: { exact: '学習率 上げすぎ loss 発散 warmup', synonym: 'モデルの最適化が不安定で値が飛ぶ', typo: 'gakusyuuritu wo agesugite loss hassan', cross: 'loss が爆発する（バッチサイズやdropoutでなく）' } },
  { id: 'h_lora', project: 'ml', fresh: true,
    text: 'ml: LoRA は rank を上げるほど表現力が増すが過学習しやすい。alpha との比で調整。',
    hardneg: ['ml: 量子化は推論を速くするが精度が落ちる。', 'ml: 勾配累積はメモリ節約だが学習が遅くなる。'],
    queries: { exact: 'LoRA rank alpha 過学習', synonym: '低ランク適応で表現力と過学習のバランス', typo: 'LoRA no rank wo agete kagakusyuu', cross: 'LoRA の rank 調整（量子化や勾配累積でなく）' } },
  { id: 'h_docker', project: 'infra', fresh: false,
    text: 'infra: docker のマルチステージで COPY --from を使うとビルドキャッシュが効きやすい。',
    hardneg: ['infra: docker の layer 順を変えるとキャッシュが無効化する。', 'infra: docker-compose の depends_on は起動順だけで疎通は保証しない。'],
    queries: { exact: 'docker マルチステージ COPY --from キャッシュ', synonym: 'コンテナのビルドを再利用で速くする', typo: 'docker no maruti suteji COPY', cross: 'マルチステージでキャッシュ（layer順やcomposeでなく）' } },
  { id: 'h_tz', project: 'infra', fresh: true,
    text: 'infra: cron のタイムゾーンは UTC 既定。JST 前提のジョブは TZ を明示する。',
    hardneg: ['infra: systemd timer は OnCalendar の書式が cron と違う。', 'infra: ログローテートの logrotate は実行タイミングが日次バッチ依存。'],
    queries: { exact: 'cron タイムゾーン UTC JST TZ', synonym: '定期実行の時刻が想定とずれる', typo: 'cron no taimuzon ga UTC', cross: 'cron の時刻がずれる（systemd timer や logrotate でなく）' } },
];

// 大量ノイズ（全ドメイン・新しい）。recency を一定不利にするが、relevant の半分(fresh)も新しいので strawman ではない。
const NOISE_T = [
  'web: ボタンの色を赤にした A/B #{n}', 'api: ログを JSON 統一 #{n}', 'infra: nginx gzip 有効化 {n}',
  'ml: データ拡張で精度 {n}pt 改善', 'web: i18n キー {n} 件追加', 'api: レート上限 {n}req/min',
  'infra: terraform state を s3 移行 {n}', 'ml: 学習を {n} epoch 回した', 'web: フォントを可変に {n}',
];

export function buildHonestCorpus({ noise = 1500 } = {}) {
  const obs = [];
  for (const it of ITEMS) {
    obs.push({ id: it.id, project: it.project, text: it.text, secret: false,
      days_ago: it.fresh ? (1 + (hash(it.id) % 9)) : (40 + (hash(it.id) % 30)) });
    (it.hardneg || []).forEach((t, i) => obs.push({ id: it.id + '_hn' + i, project: it.project, text: t, secret: false, days_ago: it.fresh ? 2 : 45 }));
  }
  for (let i = 0; i < noise; i++) {
    const t = NOISE_T[i % NOISE_T.length].replace('{n}', String(i));
    obs.push({ id: 'n_' + i, project: t.split(':')[0], text: t, secret: false, days_ago: i % 7 });
  }
  return obs;
}

export function buildHonestQueries() {
  const qs = [];
  for (const it of ITEMS) for (const [cat, q] of Object.entries(it.queries)) qs.push({ q, relevant: [it.id], category: cat, project: it.project });
  return qs;
}

function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
