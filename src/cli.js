// ulm CLI — コマンドディスパッチ
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { ulmHome, ensureHome, loadConfig } from './config.js';
import { openStore } from './store.js';
import { compileGate, detectHighEntropy } from './gate.js';
import { buildContext, buildRecall, hookOutput } from './context.js';
import { exportAll } from './exporter.js';
import { mine } from './miner.js';
import { capture, findDupCandidates } from './capture.js';
import { startWebServer, normalizeHost } from './webapp.js';
import { embedAvailable, embedTexts, embedConfig, vecToBuf } from './embed.js';
import { runDoctor } from './doctor.js';
import { checkWriteTarget, checkSkillTarget } from './safepath.js';
import { promoteWithPr, gateHit, sanitizeRefSlug, oneline, candidateGateText, renderFrontmatterHead } from './skillpr.js';
import { resolveProject, projectInfo } from './project.js';
import { nowIso, parseTtl, readStdin, shortDate, splitCsv, truncate, parseJsonSafe, trigramContainment } from './util.js';

const HELP = `ulm — user-level memory（ユーザーレベル長期記憶 CLI）

知識の置き場 4 段（CLAUDE.md / ref / bd / ulm）のうち、「現場の勘所を育てる生もの」の層。
観測は追記、状態は上書き+TTL、仮説は inbox で育てて人間の承認で project の skill へ昇格する。

観測:
  ulm obs add <text|-> [--tags a,b] [--secret] [--pin] [--project P] [--source S] [--meta json]
  ulm obs list [--project P] [--days N] [--tags t] [--pinned] [--all] [--include-secret] [--json]
  ulm obs search <query> [--json]
  ulm obs show <id> | ulm show <id>
  ulm obs pin|unpin|secret|archive|redact <id>      訂正・整理（redact=墓石化）
  ulm obs tag <id> +add,-remove
状態:
  ulm state set <key> <value> [--ttl 7d] [--global|--project|--scope S] [--secret]
  ulm state get <key> [--global|--project]   ulm state list [--all] [--json]   ulm state unset <key>
仮説（遊び場 / 採用は人間が決める）:
  ulm cand add <hypothesis> [--conditions C] [--counter X]... [--evidence id,..]
  ulm cand edit <id> [--conditions C] [--note N]
  ulm inbox [--json] | ulm show <id>
  ulm approve|reject <id> [--note N] [--yes]
  ulm promote <id> [--name slug] [--yes]            承認済みを project の .claude/skills/ref-* へ skill 化（ローカル生成）
  ulm promote <id> --pr [--provider P] [--dry-run] [--yes]   agent が関連 ref-* skill を更新（無ければ ref- 新規）し PR を出す
       --provider codex|opencode|openai（既定 auto。codex/opencode CLI か openai 明示が必要）。--name 併用時は常に新規作成。
       非対話実行では --yes 必須。git リポジトリ・remote・gh CLI が前提。実行すると即 push（--dry-run でも LLM は呼ぶ）。
  ulm reject-stale [--days 90]
採掘 / ref / 注入 / 運用:
  ulm mine [--project P] [--days N] [--limit M] [--provider codex|opencode|openai] [--dry-run]
  ulm capture [--transcript F] [--project P] [--dry-run]  作業ログから観測を自動抽出(source=auto)
  ulm ref add <path.md> [--note N] [--project P] | ulm ref list | ulm ref rm <id|path>
  ulm context [--project P] [--hook] [--json]           SessionStart 用の注入（state/ref/pin/最近）
  ulm recall <query> [--project P] [--explain] [--json]  プロンプト関連の記憶をハイブリッド想起（FTS5/BM25 + 埋め込み・キー無しは FTS のみ）
  ulm export [--quiet] | ulm import <dir> | ulm status | ulm doctor
  ulm web [--port 8765] [--tailnet] [--host IP]         DB を閲覧・編集する Web UI（既定 127.0.0.1+トークン必須）。
              [--allow-host NAME ...] [--no-token]          --tailnet は 100.x に直バインドし既定でトークン無し公開（tailnet ACL を信頼境界に）

環境変数: ULM_HOME（既定: ~/.claude/user-memory）`;

class UsageError extends Error {}

function parse(args, options, { positionals = 0 } = {}) {
  const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  if (parsed.positionals.length < positionals) {
    throw new UsageError(`引数が足りません（${positionals} 個必要）`);
  }
  return parsed;
}

/** approve / reject / promote の人間ゲート: TTY か、明示指示を表す --yes が必要 */
function requireHuman(values, action) {
  if (process.stdin.isTTY || values.yes) return;
  throw new Error(
    `${action} は人間の操作です。非対話実行ではユーザーの明示指示がある場合のみ --yes を付けてください。`
  );
}

// async コールバックにも対応する（await してから store を閉じる）。
// 同期コールバックでも Promise を返すので、呼び出し側は常に await すること。
async function withStore(fn) {
  const home = ulmHome();
  ensureHome(home);
  const store = openStore(home);
  try {
    return await fn(store, loadConfig(home), home);
  } finally {
    store.close();
  }
}

/**
 * 書き込み時の機密ゲート。
 * - 既知パターン一致 → secret 強制。
 * - 高エントロピー文字列（未知形式トークンの兆候）→ 既定で fail-closed（secret 化）。
 *   memory は注入・埋め込みに乗る特権チャネルなので、取りこぼし漏洩より誤 secret を選ぶ。
 *   config.gate.entropy_secret=false で警告のみに緩められる。
 */
function gateWrite(config, text, { explicitSecret = false } = {}) {
  const gate = compileGate(config, (m) => console.error(`⚠ ${m}`));
  const hit = gate.match(text);
  let secret = explicitSecret;
  const notes = [];
  if (hit && !secret) {
    secret = true;
    notes.push(`機密パターン (${hit}) に一致したため secret として保存します（注入・採掘・通常エクスポートから除外）。`);
  }
  if (!secret) {
    const ent = detectHighEntropy(text);
    if (ent) {
      if (config.gate?.entropy_secret !== false) {
        secret = true;
        notes.push(`高エントロピー文字列 (${ent}) を検出したため安全側に secret 化しました（公開したい場合は config.gate.entropy_secret=false）。`);
      } else {
        notes.push(`高エントロピー文字列 (${ent}) を検出。機密なら --secret を付けてください。`);
      }
    }
  }
  return { secret, notes };
}

function printObs(o, { full = false } = {}) {
  const tags = o.tags.length ? ` #${o.tags.join(' #')}` : '';
  const flags = [o.secret && '🔒secret', o.pinned && '📌pin', o.archived && '🗄archived'].filter(Boolean).join(' ');
  const proj = o.project ? ` (${o.project})` : ' (global)';
  // `\s+`→空白の単一量化子で線形（旧 `\s*\n\s*` は空白だけの長文で二次になりうる）
  const text = full ? o.text : truncate(o.text.replace(/\s+/g, ' '), 100);
  console.log(`${o.id} ${shortDate(o.ts)}${proj}${tags}${flags ? '  ' + flags : ''}  ${text}`);
}

function printCand(c, { full = false } = {}) {
  console.log(`${c.id} [${c.status}] ${shortDate(c.ts)} 出自=${c.origin}${c.project ? ` (${c.project})` : ''}`);
  console.log(`  仮説: ${c.hypothesis}`);
  if (c.conditions) console.log(`  条件: ${c.conditions}`);
  for (const x of c.counterexamples) console.log(`  反例: ${x}`);
  if (c.evidence.length) console.log(`  根拠: ${c.evidence.join(', ')}`);
  if (full && c.note) console.log(`  メモ: ${c.note}`);
  if (full && c.reviewed_at) console.log(`  レビュー: ${shortDate(c.reviewed_at)}`);
  if (c.promoted_to) console.log(`  昇格先: ${c.promoted_to}`);
}

// ---- コマンド ----

function cmdInit() {
  const home = ulmHome();
  const created = ensureHome(home);
  openStore(home).close(); // db を作る
  if (created.length) {
    console.log(`✓ 初期化しました: ${home}`);
    for (const p of created) console.log(`  + ${p}`);
  } else {
    console.log(`✓ 初期化済みです: ${home}`);
  }
  console.log('\n次の一歩:');
  console.log('  ulm obs add "今日の作業で得たコツ" --tags <tag>');
  console.log('  ulm state set 現在の担当 "..." --ttl 30d');
  console.log('  ulm doctor');
  return 0;
}

async function cmdObs(args) {
  const sub = args[0];
  if (sub === 'add') {
    const { values, positionals } = parse(args.slice(1), {
      project: { type: 'string' },
      global: { type: 'boolean', default: false },
      tags: { type: 'string' },
      secret: { type: 'boolean', default: false },
      pin: { type: 'boolean', default: false },
      source: { type: 'string', default: 'manual' },
      meta: { type: 'string' },
      quiet: { type: 'boolean', default: false },
    }, { positionals: 1 });
    let text = positionals.join(' ');
    if (text === '-') text = (await readStdin()).trim();
    if (!text) throw new UsageError('観測テキストが空です');
    // source は注入ブロックに使うため形式を厳格化（injection 境界脱出の防止）
    if (!/^[a-zA-Z0-9:_-]{1,40}$/.test(values.source)) {
      throw new UsageError('--source は英数字・コロン・ハイフン・アンダースコア（40字以内）のみ');
    }
    return withStore((store, config) => {
      // 入口ゲート: text と meta の両方をスキャン（meta 経由の持出を塞ぐ）
      const metaObj = values.meta ? parseJsonSafe(values.meta, {}) : {};
      const { secret, notes } = gateWrite(config, `${text}\n${JSON.stringify(metaObj)}`, { explicitSecret: values.secret });
      for (const n of notes) console.error(`⚠ ${n}`);
      const obs = store.addObservation({
        text,
        project: values.global ? null : (values.project ?? resolveProject(process.cwd())),
        tags: splitCsv(values.tags),
        source: values.source,
        secret,
        pinned: values.pin,
        meta: metaObj,
      });
      if (!values.quiet) console.log(`✓ 観測を記録: ${obs.id}${obs.secret ? ' (secret)' : ''}${obs.pinned ? ' (pin)' : ''}`);
      // 類似観測の機械的警告（手動経路のバックストップ）。保存は止めない・重複の断定もしない。
      // trigramContainment は警告専用の弱フィルタ（判定に使えない理由は util.js のコメント参照。
      // 閾値 0.4 は実測の言い換え下限 0.44 ぎりぎりで、recall は部分的 — 取りこぼしは普通に起こる）。
      // 候補は findDupCandidates 経由: stderr は skill/command から Claude のコンテキストに載るため
      // 実質 LLM ペイロードであり、capture の judge と同じ二条件ゲートを一様に適用する。
      if (!values.quiet && !obs.secret) {
        try {
          const scopes = obs.project ? ['global', obs.project] : null;
          const similar = findDupCandidates(store, text, { scopes, gate: compileGate(config), limit: 5 })
            .filter((o) => o.id !== obs.id && trigramContainment(text, o.text) >= 0.4)
            .slice(0, 2);
          if (similar.length) {
            console.error('⚠ 似ている可能性のある既存観測があります（重複なら ulm obs archive <id> で整理）:');
            for (const o of similar) console.error(`  ${o.id} ${truncate(o.text, 60)}`);
          }
        } catch {
          // 警告はベストエフォート（保存は完了済み。警告の失敗で obs add を失敗させない）
        }
      }
      return 0;
    });
  }
  if (sub === 'list' || sub === 'search') {
    const { values, positionals } = parse(args.slice(1), {
      project: { type: 'string' },
      tags: { type: 'string' },
      days: { type: 'string' },
      all: { type: 'boolean', default: false },
      pinned: { type: 'boolean', default: false },
      archived: { type: 'boolean', default: false },
      'include-secret': { type: 'boolean', default: false },
      limit: { type: 'string', default: '50' },
      json: { type: 'boolean', default: false },
    }, { positionals: sub === 'search' ? 1 : 0 });
    // 読み取りゲート: 既定で secret 除外。--include-secret は人間用（TTY のみ許可）
    let includeSecret = false;
    if (values['include-secret']) {
      if (!process.stdin.isTTY) {
        console.error('⚠ --include-secret は対話実行でのみ有効です。secret を除外して表示します。');
      } else includeSecret = true;
    }
    return withStore((store) => {
      // search は FTS5 BM25 の関連度順、list は recency 順
      const list = sub === 'search'
        ? store.searchObservations({
            query: positionals.join(' '),
            project: values.project,
            tags: splitCsv(values.tags),
            includeSecret,
            includeArchived: values.all || values.archived,
            limit: Number(values.limit),
          })
        : store.listObservations({
            project: values.project,
            days: values.all ? undefined : values.days ? Number(values.days) : 30,
            tags: splitCsv(values.tags),
            includeSecret,
            includeArchived: values.all || values.archived,
            pinnedOnly: values.pinned,
            limit: Number(values.limit),
          });
      if (values.json) {
        console.log(JSON.stringify(list, null, 2));
        return 0;
      }
      if (!list.length) console.log('（観測なし）');
      else for (const o of list) {
        if (sub === 'search' && o.rank != null) process.stdout.write(`[rank ${o.rank.toFixed(2)}] `);
        printObs(o);
      }
      const hidden = store.stats().secret_observations;
      if (!includeSecret && hidden) console.log(`（secret ${hidden} 件を非表示）`);
      return 0;
    });
  }
  if (sub === 'show') return cmdShow(args.slice(1));
  if (sub === 'archive') {
    // 一括（--days N / --before YYYY-MM-DD）または単一 <id>
    const { values, positionals } = parse(args.slice(1), {
      days: { type: 'string' },
      before: { type: 'string' },
    });
    return withStore((store) => {
      if (values.days || values.before) {
        let iso;
        if (values.before) {
          const d = new Date(values.before);
          if (Number.isNaN(d.getTime())) throw new UsageError(`不正な日付: ${values.before}`);
          iso = d.toISOString();
        } else {
          iso = new Date(Date.now() - Number(values.days) * 86_400_000).toISOString();
        }
        const n = store.archiveObservationsBefore(iso);
        console.log(`✓ ${shortDate(iso)} より前の観測 ${n} 件をアーカイブしました（既定の list/search/mine から除外。--all で参照可）`);
      } else if (positionals[0]) {
        store.setObservationFlags(positionals[0], { archived: true });
        console.log(`✓ ${positionals[0]}: archived=true`);
      } else {
        throw new UsageError('ulm obs archive <id> | --days N | --before YYYY-MM-DD');
      }
      return 0;
    });
  }
  if (['pin', 'unpin', 'secret', 'redact'].includes(sub)) {
    const { positionals } = parse(args.slice(1), {}, { positionals: 1 });
    return withStore((store) => {
      const id = positionals[0];
      if (sub === 'redact') {
        store.redactObservation(id);
        console.log(`✓ ${id} を墓石化しました（本文・meta を消去、追記履歴は保持）`);
      } else {
        const flag = { pin: { pinned: true }, unpin: { pinned: false }, secret: { secret: true } }[sub];
        store.setObservationFlags(id, flag);
        console.log(`✓ ${id}: ${Object.keys(flag)[0]}=${Object.values(flag)[0]}`);
        if (sub === 'secret') console.log('  注入・採掘・通常エクスポートから除外されます');
      }
      return 0;
    });
  }
  if (sub === 'tag') {
    const { positionals } = parse(args.slice(1), {}, { positionals: 2 });
    const [id, spec] = positionals;
    return withStore((store) => {
      const o = store.getObservation(id);
      if (!o) throw new Error(`観測が見つかりません: ${id}`);
      const tags = new Set(o.tags);
      for (const part of splitCsv(spec)) {
        if (part.startsWith('-')) tags.delete(part.slice(1));
        else tags.add(part.replace(/^\+/, ''));
      }
      store.setObservationTags(id, [...tags]);
      console.log(`✓ ${id} tags: ${[...tags].join(', ') || '(なし)'}`);
      return 0;
    });
  }
  throw new UsageError('ulm obs <add|list|search|show|pin|unpin|secret|archive|redact|tag> ...');
}

function cmdState(args) {
  const sub = args[0];
  // scope 解決: --global > --project > --scope > 既定(global)。obs add とフラグ体系を統一。
  const scopeOf = (values) => {
    if (values.global) return 'global';
    if (values.project) return resolveProject(process.cwd());
    if (values.scope === 'project') return resolveProject(process.cwd());
    return values.scope || 'global';
  };
  const scopeOpts = { scope: { type: 'string' }, global: { type: 'boolean', default: false }, project: { type: 'boolean', default: false } };
  if (sub === 'set') {
    const { values, positionals } = parse(args.slice(1), {
      ...scopeOpts,
      ttl: { type: 'string' },
      secret: { type: 'boolean', default: false },
    }, { positionals: 2 });
    return withStore((store, config) => {
      let ttlMs = null;
      if (values.ttl) {
        ttlMs = parseTtl(values.ttl);
        if (!ttlMs) throw new UsageError(`不正な TTL: ${values.ttl}（例: 30m, 24h, 7d, 2w）`);
      }
      const [key, ...rest] = positionals;
      const value = rest.join(' ');
      // key も value もゲートする（M4: key 経由の機密混入を防ぐ）
      const { secret, notes } = gateWrite(config, `${key}\n${value}`, { explicitSecret: values.secret });
      for (const n of notes) console.error(`⚠ ${n}`);
      store.setState(key, value, { scope: scopeOf(values), ttlMs, secret });
      console.log(`✓ state を更新: ${key}${values.ttl ? ` (TTL ${values.ttl})` : ''}${secret ? ' (secret)' : ''}`);
      return 0;
    });
  }
  if (sub === 'get') {
    const { values, positionals } = parse(args.slice(1), scopeOpts, { positionals: 1 });
    return withStore((store) => {
      const scope = scopeOf(values);
      // scope 解決順: 指定 scope → global フォールバック
      const r = store.getState(positionals[0], { scope }) || (scope !== 'global' ? store.getState(positionals[0], { scope: 'global' }) : null);
      if (!r) {
        console.error('（未設定または期限切れ）');
        return 1;
      }
      // secret state は非対話では値を出さない（list が *** マスクするのと整合）
      if (r.secret && !process.stdin.isTTY) {
        console.error('（secret state。対話実行でのみ値を表示します）');
        return 1;
      }
      console.log(r.value);
      return 0;
    });
  }
  if (sub === 'list') {
    const { values } = parse(args.slice(1), {
      all: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    });
    return withStore((store, config) => {
      const gate = compileGate(config);
      // キー自体が機密になりうる（M4）。非対話では secret state のキーもマスクする。
      const maskKey = (r) => (r.secret && !process.stdin.isTTY && (gate.match(r.key) || detectHighEntropy(r.key)) ? '[secret-key]' : r.key);
      const rows = store.listStates({ includeExpired: values.all });
      if (values.json) {
        // 非対話では secret の値・機密キーをマスクして出す（エージェントへの平文ダンプを防ぐ）
        const safe = process.stdin.isTTY ? rows : rows.map((r) => (r.secret ? { ...r, key: maskKey(r), value: '***' } : r));
        console.log(JSON.stringify(safe, null, 2));
        return 0;
      }
      if (!rows.length) console.log('（state なし）');
      else for (const r of rows) {
        const expired = r.expires_at && r.expires_at <= nowIso();
        const exp = r.expires_at ? ` [期限 ${shortDate(r.expires_at)}${expired ? ' 切れ' : ''}]` : '';
        const sec = r.secret ? ' 🔒' : '';
        const val = r.secret ? '***' : truncate(r.value, 120);
        console.log(`${r.scope === 'global' ? '' : `(${r.scope}) `}${maskKey(r)}${sec} = ${val}${exp}`);
      }
      return 0;
    });
  }
  if (sub === 'unset') {
    const { values, positionals } = parse(args.slice(1), scopeOpts, { positionals: 1 });
    return withStore((store) => {
      const n = store.deleteState(positionals[0], { scope: scopeOf(values) });
      console.log(n ? `✓ state を削除: ${positionals[0]}` : `（該当なし: ${positionals[0]}）`);
      return 0;
    });
  }
  throw new UsageError('ulm state <set|get|list|unset> ...');
}

function cmdCand(args) {
  const sub = args[0];
  if (sub === 'add') {
    const { values, positionals } = parse(args.slice(1), {
      conditions: { type: 'string', default: '' },
      counter: { type: 'string', multiple: true, default: [] },
      evidence: { type: 'string' },
      project: { type: 'string' },
    }, { positionals: 1 });
    return withStore((store, config) => {
      const hypothesis = positionals.join(' ');
      const { notes } = gateWrite(config, `${hypothesis}\n${values.conditions}`);
      for (const n of notes) console.error(`⚠ ${n}（候補は外部送信されませんが、機密は記録しないでください）`);
      const r = store.addCandidate({
        hypothesis,
        conditions: values.conditions,
        counterexamples: values.counter,
        evidence: splitCsv(values.evidence),
        origin: 'manual',
        project: values.project ?? resolveProject(process.cwd()),
      });
      if (r.duplicateOf) console.log(`= 同じ仮説が既にあります: ${r.duplicateOf} (${r.status})`);
      else console.log(`✓ 候補を inbox に追加: ${r.id}`);
      return 0;
    });
  }
  if (sub === 'edit') {
    const { values, positionals } = parse(args.slice(1), {
      conditions: { type: 'string' },
      note: { type: 'string' },
    }, { positionals: 1 });
    return withStore((store) => {
      const c = store.editCandidate(positionals[0], { conditions: values.conditions, note: values.note });
      console.log(`✓ ${c.id} を更新`);
      printCand(c, { full: true });
      return 0;
    });
  }
  if (sub === 'list') return cmdInbox(args.slice(1));
  throw new UsageError('ulm cand <add|edit|list> ...');
}

function cmdInbox(args) {
  const { values } = parse(args, { json: { type: 'boolean', default: false }, status: { type: 'string', default: 'inbox' } });
  return withStore((store) => {
    const list = store.listCandidates({ status: values.status });
    if (values.json) {
      console.log(JSON.stringify(list, null, 2));
      return 0;
    }
    if (!list.length) {
      console.log(`${values.status} は空です`);
      return 0;
    }
    console.log(`${values.status}: ${list.length} 件（採用するかは人間が決める）\n`);
    for (const c of list) {
      printCand(c);
      console.log('');
    }
    return 0;
  });
}

function cmdShow(args) {
  const { values, positionals } = parse(args, { json: { type: 'boolean', default: false } }, { positionals: 1 });
  const id = positionals[0];
  return withStore((store) => {
    if (id.startsWith('obs-')) {
      const o = store.getObservation(id);
      if (!o) throw new Error(`観測が見つかりません: ${id}`);
      if (o.secret && !process.stdin.isTTY) {
        console.error('⚠ secret 観測です。対話実行でのみ本文を表示します。');
        return 1;
      }
      if (values.json) console.log(JSON.stringify(o, null, 2));
      else {
        printObs(o, { full: true });
        if (Object.keys(o.meta).length) console.log(`  meta: ${JSON.stringify(o.meta)}`);
        console.log(`  source: ${o.source}`);
      }
      return 0;
    }
    if (id.startsWith('cand-')) {
      const c = store.getCandidate(id);
      if (!c) throw new Error(`候補が見つかりません: ${id}`);
      if (values.json) console.log(JSON.stringify(c, null, 2));
      else printCand(c, { full: true });
      return 0;
    }
    throw new UsageError(`不明な ID 形式: ${id}（obs- / cand- で始まる ID を指定）`);
  });
}

function cmdReview(args, status) {
  const { values, positionals } = parse(args, {
    note: { type: 'string', default: '' },
    yes: { type: 'boolean', default: false },
  }, { positionals: 1 });
  requireHuman(values, status === 'approved' ? 'approve' : 'reject');
  return withStore((store) => {
    const c = store.reviewCandidate(positionals[0], status, values.note);
    console.log(`✓ ${c.id} を ${status === 'approved' ? '承認' : '却下'}しました`);
    if (status === 'approved') {
      console.log(`  昇格するには: ulm promote ${c.id}（.claude/skills/ref-* へローカル生成）`);
      console.log(`  関連 skill を更新して PR を出すには: ulm promote ${c.id} --pr`);
    }
    return 0;
  });
}

function cmdRejectStale(args) {
  const { values } = parse(args, { days: { type: 'string', default: '90' }, yes: { type: 'boolean', default: false } });
  requireHuman(values, 'reject-stale');
  return withStore((store) => {
    const n = store.rejectStale(Number(values.days));
    console.log(`✓ ${values.days} 日以上 inbox に滞留した候補 ${n} 件を却下しました`);
    return 0;
  });
}

async function cmdPromote(args) {
  const { values, positionals } = parse(args, {
    name: { type: 'string' },
    pr: { type: 'boolean', default: false },
    provider: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  }, { positionals: 1 });
  // --dry-run / --provider は --pr 専用。ローカル生成パスで黙殺すると「dry-run のつもりが本書込・昇格確定」
  // という取り違えを招くため、--pr 無しでの併用は明確に弾く。
  if (!values.pr && (values['dry-run'] || values.provider !== undefined)) {
    throw new UsageError('--dry-run / --provider は --pr と併用してください');
  }
  // 空の --name は黙って無視されると「新規強制したつもりが既存照合される」取り違えになるため弾く。
  if (values.name !== undefined && !values.name.trim()) {
    throw new UsageError('--name が空です');
  }
  // 空の --provider も黙って auto 解決に落とさず弾く（--name と対称。指定したつもりが別 provider になる取り違え防止）。
  if (values.provider !== undefined && !values.provider.trim()) {
    throw new UsageError('--provider が空です');
  }
  // --pr は dry-run でも LLM を実呼び出しする（候補本文を外部送信しうる）ため、
  // 非対話エージェントによる無制限呼び出しを防ぐべく人間ゲートを常に課す。
  requireHuman(values, 'promote');
  return withStore(async (store, config, home) => {
    const c = store.getCandidate(positionals[0]);
    if (!c) throw new Error(`候補が見つかりません: ${positionals[0]}`);
    if (c.status === 'promoted') throw new Error(`既に昇格済みです: ${c.promoted_to}`);
    if (c.status !== 'approved') {
      throw new Error(`昇格できるのは approved の候補のみです（現在: ${c.status}）。まず ulm approve ${c.id}`);
    }
    // 昇格先はその候補の project の .claude/skills。候補と現在地の project が
    // 食い違ったまま書くと別 project に規範が混入するため、一致を要求する。
    const proj = projectInfo(process.cwd());
    if (c.project && c.project !== proj.name) {
      throw new Error(`候補は project '${c.project}' のものです。その project の作業ツリーで実行してください（現在: '${proj.name}'）`);
    }

    // --pr: agent が関連 skill を選んで更新（無ければ ref- 新規）し、PR を出す
    if (values.pr) {
      const r = await promoteWithPr(store, config, home, {
        candidate: c,
        projectRoot: proj.root,
        provider: values.provider,
        name: values.name,
        dryRun: values['dry-run'],
        log: (m) => console.error(m),
      });
      if (r.dryRun) return 0;
      const what = r.action === 'create' ? '新規 skill 作成' : '既存 skill 更新';
      // PR が作られたときだけ「昇格完了(✓)」。push 止まり（gh 不在等）は候補が approved のままなので、
      // 完了と誤認させない語調にし、冪等な再実行を案内する。
      if (r.prUrl) {
        console.log(`✓ ${c.id} → ${what}: .claude/skills/${r.slug}/SKILL.md`);
        console.log(`  branch: ${r.branch}`);
        console.log(`  PR: ${r.prUrl}`);
      } else {
        console.log(`△ ${c.id} → ${what}を branch '${r.branch}' に commit しましたが PR は未作成です（候補は approved のまま）。`);
        console.log('  gh CLI を入れて再実行すると PR を作成できます（ブランチは冪等に再利用）。');
      }
      if (r.note) console.log(`  ${r.note}`);
      return 0;
    }

    // 既定（ローカル生成）: 候補1件をそのまま ref- skill として新規生成する。
    // 昇格 skill は ref-* 名前空間に統一する（--name 指定でも ref- を強制。safepath でも再検証）。
    // 自動ロードされる .claude/skills へ書く前に、--pr 入口と同じ二条件で候補本文を再ゲートする（egress=ゲート対象）。
    const candText = candidateGateText(c);
    if (gateHit(compileGate(config), candText)) {
      throw new Error(`候補 ${c.id} に機密の疑いがあるテキストが含まれるため skill 生成を中止しました`);
    }
    // slug 正規化は --pr 経路と同一規則（sanitizeRefSlug）に揃える: 同じ --name 値で経路により成否が割れない。
    const slug = values.name ? sanitizeRefSlug(values.name) : c.id.replace(/^cand-/, 'ref-');
    const check = checkSkillTarget(slug, proj.root);
    if (!check.ok) throw new Error(`昇格先を拒否: ${check.reason}`);

    // description = 発動条件。skill は常時注入されず、ここのマッチで初めて本文がロードされる。
    // 正規化/サニタイズは skillpr の oneline（制御文字・U+2028/2029 除去込み）に統一する（--pr 経路と同じ防御）。
    const description = oneline([c.conditions, c.hypothesis].filter(Boolean).join(' — ')).slice(0, 300);
    const skill = [
      ...renderFrontmatterHead(slug, description),
      '',
      `# ${oneline(c.hypothesis)}`,
      '',
      ...(c.conditions ? [`- 条件: ${oneline(c.conditions)}`] : []),
      ...c.counterexamples.map((x) => `- 反例: ${oneline(x)}`),
      ...(c.evidence.length ? [`- 根拠: ${c.evidence.map(oneline).filter(Boolean).join(', ')}`] : []),
      `- 出自: ${oneline(c.origin || 'unknown')} / 承認 ${shortDate(c.reviewed_at || nowIso())} / 昇格 ${shortDate(nowIso())} (${c.id})`,
      '',
    ].join('\n');
    mkdirSync(dirname(check.path), { recursive: true });
    writeFileSync(check.path, skill);
    store.markPromoted(c.id, check.path);
    console.log(`✓ ${c.id} を skill へ昇格: ${check.path}`);
    console.log('  関連する既存 skill に反映して PR を出すには: ulm promote --pr');
    return 0;
  });
}

function cmdRef(args) {
  const sub = args[0];
  if (sub === 'add') {
    const { values, positionals } = parse(args.slice(1), {
      note: { type: 'string', default: '' },
      project: { type: 'string' },
    }, { positionals: 1 });
    return withStore((store, config, home) => {
      const target = resolve(positionals[0]);
      const check = checkWriteTarget(target, { refRoot: join(home, 'ref'), allowRoots: [process.cwd()] });
      if (!check.ok) throw new Error(`ref パスを拒否: ${check.reason}`);
      const r = store.addRef({ path: check.path, note: values.note, project: values.project ?? null });
      console.log(`✓ ref ポインタ: ${r.id} → ${r.path}`);
      return 0;
    });
  }
  if (sub === 'list') {
    return withStore((store) => {
      const rows = store.listRefs();
      if (!rows.length) console.log('（ref ポインタなし）');
      for (const r of rows) {
        const missing = existsSync(r.path) ? '' : ' ⚠不在';
        console.log(`${r.id} ${r.path}${r.project ? ` (${r.project})` : ''}${r.note ? ` — ${r.note}` : ''}${missing}`);
      }
      return 0;
    });
  }
  if (sub === 'rm') {
    const { positionals } = parse(args.slice(1), {}, { positionals: 1 });
    return withStore((store) => {
      const n = store.removeRef(positionals[0]);
      console.log(n ? `✓ ref を削除: ${positionals[0]}` : `（該当なし: ${positionals[0]}）`);
      return 0;
    });
  }
  throw new UsageError('ulm ref <add|list|rm> ...');
}

async function cmdMine(args) {
  const { values } = parse(args, {
    project: { type: 'string' },
    days: { type: 'string' },
    limit: { type: 'string' },
    provider: { type: 'string' },
    force: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  });
  return withStore(async (store, config, home) => {
    // inbox 滞留の歯止め
    if (!values.force && !values['dry-run'] && store.inboxCount() >= 50) {
      throw new Error(`inbox に ${store.inboxCount()} 件の未レビュー候補があります。先に /ulm:review するか --force を付けてください。`);
    }
    const r = await mine(store, config, home, {
      project: values.project,
      days: values.days ? Number(values.days) : undefined,
      limit: values.limit ? Number(values.limit) : undefined,
      provider: values.provider,
      dryRun: values['dry-run'],
      log: (m) => console.error(m),
    });
    if (r.dryRun) return 0;
    if (r.observations === 0) {
      console.log('対象の観測がありません（secret・期間・project で絞られた結果が 0 件）');
      return 0;
    }
    console.log(`✓ 採掘完了: 新規候補 ${r.created.length} 件 / 重複 ${r.duplicates} 件（観測 ${r.observations} 件から, provider=${r.provider}）`);
    for (const c of r.created) {
      console.log('');
      printCand(c);
    }
    if (r.created.length) console.log('\n候補は inbox にあります。採用は人間が判断: ulm inbox');
    return 0;
  });
}

async function cmdContext(args) {
  const { values } = parse(args, {
    project: { type: 'string' },
    hook: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  });

  if (values.hook) {
    // hook はセッションを壊さないこと最優先: 失敗しても exit 0・stdout は JSON か空のみ（fail-open）
    try {
      const raw = await readStdin();
      const input = raw.length <= 256 * 1024 ? parseJsonSafe(raw, {}) : {}; // stdin サイズ上限
      const project = values.project ?? resolveProject(input.cwd || process.cwd());
      const out = await withStore((store, config) => hookOutput(buildContext(store, config, { project })));
      if (out) console.log(JSON.stringify(out));
      return 0;
    } catch (err) {
      console.error(`ulm hook error: ${err.message}`);
      return 0;
    }
  }

  const project = values.project ?? resolveProject(process.cwd());
  return withStore((store, config) => {
    const text = buildContext(store, config, { project });
    if (values.json) console.log(JSON.stringify(hookOutput(text) ?? {})); // 空時は {} を返す
    else console.log(text || '（注入する記憶はありません）');
    return 0;
  });
}

// UserPromptSubmit 用: プロンプトに関連する記憶をハイブリッド想起（FTS5/BM25 + 埋め込み）で動的注入する
async function cmdRecall(args) {
  const { values, positionals } = parse(args, {
    project: { type: 'string' },
    hook: { type: 'boolean', default: false },
    limit: { type: 'string' },
    explain: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  });

  if (values.hook) {
    // UserPromptSubmit hook: stdin の JSON から prompt と cwd を取り、関連記憶を additionalContext に
    try {
      const raw = await readStdin();
      const input = raw.length <= 256 * 1024 ? parseJsonSafe(raw, {}) : {};
      const query = String(input.prompt || input.user_prompt || '').slice(0, 4000);
      const project = values.project ?? resolveProject(input.cwd || process.cwd());
      if (!query.trim()) return 0;
      const out = await withStore(async (store, config) => {
        const { text } = await buildRecall(store, config, { project, query, limit: values.limit ? Number(values.limit) : undefined });
        return hookOutput(text, 'UserPromptSubmit');
      });
      if (out) console.log(JSON.stringify(out));
      return 0;
    } catch (err) {
      console.error(`ulm recall hook error: ${err.message}`);
      return 0;
    }
  }

  const query = positionals.join(' ');
  if (!query.trim()) throw new UsageError('ulm recall <query>');
  const project = values.project ?? resolveProject(process.cwd());
  return withStore(async (store, config) => {
    const { text, hits, mode } = await buildRecall(store, config, { project, query, limit: values.limit ? Number(values.limit) : undefined });
    if (values.json) {
      console.log(JSON.stringify({ mode, hits, text }, null, 2));
      return 0;
    }
    if (values.explain) {
      console.error(`query="${query}" project=${project} mode=${mode} fts=${store.hasFts()} embeds=${store.embeddingCount()} hits=${hits.length}`);
      for (const h of hits) console.error(`  ${h.fused != null ? 'fused=' + h.fused.toFixed(4) : h.sim != null ? 'sim=' + h.sim.toFixed(3) : 'rank=' + (h.rank == null ? 'LIKE' : h.rank.toFixed(2))} ${h.id} ${truncate(h.text, 56)}`);
    }
    console.log(text || '（関連する記憶なし）');
    return 0;
  });
}

// 観測の埋め込みを作成/更新（意味的想起の有効化）。キーが無ければ no-op。
async function cmdReindex(args) {
  const { values } = parse(args, { limit: { type: 'string' }, json: { type: 'boolean', default: false } });
  return withStore(async (store, config) => {
    if (!embedAvailable(config)) {
      console.log('埋め込みは無効です（API キー未設定）。FTS5 のみで動作します。');
      return 0;
    }
    // 修復スキャン: secret=0 の「全」観測を機械チェックし、機密疑いを secret=1 へ昇格。
    // 既に埋め込み済みの行も対象にし、昇格したらそのベクトルを削除する（codex 指摘の漏れを塞ぐ）。
    const gate = compileGate(config);
    let repaired = 0;
    for (const o of store.allNonSecretObs()) {
      if (gate.match(o.text) || detectHighEntropy(o.text)) {
        store.setObservationFlags(o.id, { secret: true });
        store.deleteEmbedding(o.id);
        repaired++;
      }
    }
    if (repaired) console.error(`⚠ ${repaired} 件を機密の疑いで secret 化し、埋め込みから除外/削除しました`);
    const pending = store.observationsNeedingEmbedding({ limit: values.limit ? Number(values.limit) : 1000 });
    if (!pending.length) {
      console.log(`埋め込み済み: ${store.embeddingCount()} 件、新規なし`);
      return 0;
    }
    const model = embedConfig(config).model;
    const vecs = await embedTexts(pending.map((p) => p.text), config);
    for (let i = 0; i < pending.length; i++) store.upsertEmbedding(pending[i].id, model, vecToBuf(vecs[i]));
    console.log(`✓ 埋め込み作成: ${pending.length} 件（model=${model}, 累計 ${store.embeddingCount()} 件）`);
    return 0;
  });
}

// Stop/SessionEnd hook 用: transcript から再利用可能な観測を自動抽出して source=auto で記録
async function cmdCapture(args) {
  const { values } = parse(args, {
    project: { type: 'string' },
    transcript: { type: 'string' },
    provider: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    hook: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
  });

  if (values.hook) {
    // hook: 失敗してもセッションを壊さない（exit 0、stdout は出さない）
    try {
      const raw = await readStdin();
      const input = raw.length <= 256 * 1024 ? parseJsonSafe(raw, {}) : {};
      const transcriptPath = values.transcript || input.transcript_path;
      if (!transcriptPath) return 0;
      const project = values.project ?? resolveProject(input.cwd || process.cwd());
      await withStore((store, config, home) =>
        capture(store, config, home, { transcriptPath, project, provider: values.provider, log: () => {} })
      );
      return 0;
    } catch (err) {
      console.error(`ulm capture hook error: ${err.message}`);
      return 0;
    }
  }

  return withStore(async (store, config, home) => {
    const r = await capture(store, config, home, {
      transcriptPath: values.transcript,
      project: values.project ?? resolveProject(process.cwd()),
      provider: values.provider,
      dryRun: values['dry-run'],
      log: (m) => console.error(m),
    });
    if (r.disabled) {
      console.log('自動キャプチャは無効です（config.capture.enabled=false）');
      return 0;
    }
    if (r.dryRun) return 0;
    if (!values.quiet) {
      console.log(`✓ 自動キャプチャ: 新規 ${r.captured.length} 件 / 重複 ${r.skippedDup} 件（provider=${r.provider}, 元 ${r.transcriptChars} 字）`);
      for (const o of r.captured) console.log(`  ${o.id} (auto) ${truncate(o.text, 80)}`);
      if (r.captured.length) console.log('  source=auto は未レビュー扱い。/ulm:review で確認、不要なら ulm obs redact <id>');
    }
    return 0;
  });
}

function cmdExport(args) {
  const { values } = parse(args, { quiet: { type: 'boolean', default: false } });
  return withStore((store, config, home) => {
    const r = exportAll(store, home, config);
    if (!values.quiet) {
      console.log(`✓ エクスポート: ${r.dir}`);
      for (const f of r.files) console.log(`  ${f}`);
    }
    for (const w of r.warnings) console.error(`⚠ ${w}`);
    return 0;
  });
}

function cmdImport(args) {
  const { positionals } = parse(args, {}, { positionals: 1 });
  const dir = resolve(positionals[0]);
  return withStore((store, config) => {
    const gate = compileGate(config);
    let total = 0;
    let flagged = 0;
    for (const [table, file] of [
      ['observations', 'observations.jsonl'],
      ['observations', 'observations.secret.jsonl'],
      ['states', 'states.jsonl'],
      ['states', 'states.secret.jsonl'],
      ['candidates', 'candidates.jsonl'],
      ['refs', 'refs.jsonl'],
    ]) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      const rawLines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      let rows = rawLines.map((l) => parseJsonSafe(l, null)).filter(Boolean);
      const parseFail = rawLines.length - rows.length; // 不正 JSON 行の脱落を可視化（無言にしない）
      if (parseFail) console.log(`  ⚠ ${file}: ${parseFail} 行を JSON parse 失敗でスキップ`);
      // 取込時ゲート: 外部由来の行が gateWrite を通っていないので、ここで機密を secret 化する。
      // states は value だけでなく key も検査する（M4）。
      if (table === 'observations' || table === 'states') {
        for (const r of rows) {
          const blob = table === 'observations' ? String(r.text ?? '') : `${r.key ?? ''}\n${r.value ?? ''}`;
          if (!r.secret && (gate.match(blob) || detectHighEntropy(blob))) {
            r.secret = 1;
            flagged++;
          }
        }
      }
      const { inserted: n, skipped } = store.importRows(table, rows);
      if (n) console.log(`  ${file}: ${n} 行を取込`);
      if (skipped) console.log(`  ⚠ ${file}: ${skipped} 行をスキップ（不正 id/長すぎる本文/バインド不可）`);
      total += n;
    }
    console.log(`✓ import 完了: 合計 ${total} 行（既存 ID は INSERT OR IGNORE でスキップ）`);
    if (flagged) console.log(`  ${flagged} 行を機密の疑いで secret 化しました`);
    console.log('  取り込んだ観測は source 表示で出自を区別できます。注入前に内容を確認してください。');
    return 0;
  });
}

function cmdStatus() {
  return withStore((store, _config, home) => {
    const s = store.stats();
    console.log(`ULM_HOME: ${home}  (schema v${store.schemaVersion()})`);
    console.log(`観測: ${s.observations} 件（secret ${s.secret_observations} / pin ${s.pinned_observations} / archived ${s.archived_observations}）`);
    console.log(`state: ${s.states} 件（secret ${s.secret_states}）`);
    console.log(`候補: inbox ${s.candidates_inbox} / approved ${s.candidates_approved} / promoted ${s.candidates_promoted} / rejected ${s.candidates_rejected}`);
    console.log(`ref: ${s.refs} 件`);
    if (s.observations >= 5000) console.log('⚠ 観測が 5000 件を超えました。`ulm obs archive` での整理を検討してください。');
    if (s.candidates_inbox >= 50) console.log('⚠ inbox が 50 件を超えました。`/ulm:review` または `ulm reject-stale` を検討してください。');
    return 0;
  });
}

function cmdDoctor() {
  const { home, checks } = runDoctor();
  console.log(`ulm doctor — ${home}\n`);
  const icon = { ok: '✓', warn: '⚠', error: '✗' };
  for (const c of checks) console.log(`${icon[c.level]} ${c.name}: ${c.detail}`);
  return checks.some((c) => c.level === 'error') ? 1 : 0;
}

/**
 * tailscale CLI のバイナリを解決する。macOS GUI/App Store 版は CLI が PATH に無く
 * アプリバンドル内（/Applications/Tailscale.app/...）にあるため、既知の場所も探す。
 * ULM_TAILSCALE_BIN で明示上書き可。見つからなければ null。
 */
function resolveTailscaleBin() {
  const candidates = [
    process.env.ULM_TAILSCALE_BIN,
    'tailscale', // PATH（Linux / homebrew / operator 設定済み）
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale', // macOS GUI / App Store 版
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['version'], { timeout: 5000, stdio: 'ignore' });
      return bin;
    } catch { /* 次の候補へ */ }
  }
  return null;
}

// 常時起動（launchd 等）でも一貫して案内するフォールバック手順。
const TAILNET_MANUAL_HINT =
  '手動なら `ulm web --host <100.x のIP> --allow-host <node>.<tailnet>.ts.net --no-token` で固定指定してください';

/**
 * Tailscale の CGNAT 範囲 100.64.0.0/10（第2オクテット 64〜127）の IPv4 か。
 * `/^100\./` だと public な 100.0〜63 / 100.128〜255 まで通ってしまう（tokenless 公開の fail-open）ので
 * tailnet 判定はこの厳密版に統一する（install.sh の検出ロジックとも一致）。
 */
function isCgnatIp(ip) {
  const o = String(ip).split('.');
  if (o.length !== 4) return false;
  const n = o.map((x) => Number(x));
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  return n[0] === 100 && n[1] >= 64 && n[1] <= 127;
}

/**
 * `tailscale status --json` の生出力から { ip, dnsName } を取り出す純関数（テスト用に export）。
 * 不正・未接続時は実用的な UsageError を投げる。
 */
export function parseTailnetStatus(raw) {
  let status;
  try {
    status = JSON.parse(raw);
  } catch {
    // macOS App Store 版 CLI は GUI セッション依存で、launchd/cron/最小 env では
    // "The Tailscale GUI failed to start..." を stdout に吐く（exit 0 だが非 JSON）。実機で確認済み。
    const head = String(raw).trim().split('\n')[0].slice(0, 160);
    throw new UsageError(
      `tailscale status --json が JSON を返しませんでした${head ? `（出力: ${head}）` : ''}。`
      + 'macOS GUI 版 CLI は launchd 等の非対話環境では動きません。'
      + `常時起動などでは ${TAILNET_MANUAL_HINT}`,
    );
  }
  if (status.BackendState && status.BackendState !== 'Running') {
    throw new UsageError(`Tailscale が未接続です（BackendState=${status.BackendState}）。\`tailscale up\` で接続してください`);
  }
  const self = status.Self || {};
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  // Tailscale の IPv4 は CGNAT 100.64.0.0/10 のみ。緩いフォールバックは付けない（非 CGNAT を
  // トークン無しで bind する fail-open を避け、install.sh の検出と一致させる）。
  const ip = ips.find((a) => isIP(String(a)) === 4 && isCgnatIp(a));
  const dnsName = String(self.DNSName || '').replace(/\.$/, '').toLowerCase();
  if (!ip) throw new UsageError(`Tailscale の 100.x IPv4 を取得できませんでした。${TAILNET_MANUAL_HINT}`);
  return { ip, dnsName };
}

/**
 * tailscale CLI から自ノードの 100.x IPv4 と MagicDNS 名を得る（--tailnet 用）。
 * 0.0.0.0 ではなく 100.x に名指しバインドして tailnet 限定に保つのが狙い。
 */
function detectTailnet() {
  const bin = resolveTailscaleBin();
  if (!bin) {
    throw new UsageError(
      'tailscale CLI が見つかりません（PATH / 既知の場所いずれにも無し。ULM_TAILSCALE_BIN で指定可）。'
      + TAILNET_MANUAL_HINT,
    );
  }
  let raw;
  try {
    raw = execFileSync(bin, ['status', '--json'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new UsageError(`tailscale status を実行できません（Tailscale が起動しているか確認）。${TAILNET_MANUAL_HINT}`);
  }
  return parseTailnetStatus(raw);
}

function isLoopbackHost(h) {
  // IP リテラルのみ受理（'127.0.0.1.evil.com' のような名前が listen で DNS 解決され
  // 非 loopback に bind される事故を防ぐ。CGNAT 側と同じく isIP で literal 検証する）。
  if (h === 'localhost') return true;
  const v = isIP(h);
  if (v === 6) return h === '::1';
  if (v === 4) return /^127\./.test(h);
  return false;
}

/**
 * web のバインド先・Host 許可・トークン要否をフラグから決める純関数（テスト用に export）。
 * detect は --tailnet 検出を注入できる（既定は detectTailnet）。
 * 設計上、公開バインドは loopback か tailnet の 100.x IPv4 のみ。それ以外（LAN/ワイルドカード・
 * 0.0.0.0 の別表記含む）は到達範囲が読めないので一律拒否する（tokenless で LAN 露出する事故を断つ）。
 * @returns {{host:string, allowedHosts:string[], requireToken:boolean, displayHost:string|null, kind:'loopback'|'tailnet'}}
 */
export function resolveWebBind(values, detect = detectTailnet) {
  if (values.tailnet && values.host) throw new UsageError('--tailnet と --host は併用できません');
  const allowHosts = [...(values['allow-host'] || [])];
  const noToken = !!values['no-token'];

  if (values.tailnet) {
    const { ip, dnsName } = detect();
    const allowedHosts = dnsName ? [...allowHosts, dnsName] : allowHosts;
    // tailnet は ACL を信頼境界にする想定なので既定トークン無し（--no-token でも無し）。
    // 表示はユーザ指定の別名 > 検出 MagicDNS 名 > 100.x IP の優先（--host 経路と一貫）。
    return { host: ip, allowedHosts, requireToken: false, displayHost: allowHosts[0] || dnsName || ip, kind: 'tailnet' };
  }

  if (values.host) {
    const host = String(values.host).replace(/^\[(.+)\]$/, '$1'); // IPv6 角括弧を外す（listen は裸 IP を要求）
    let kind;
    if (isLoopbackHost(host)) kind = 'loopback';
    else if (isIP(host) === 4 && isCgnatIp(host)) kind = 'tailnet'; // CGNAT 100.64.0.0/10 の実 IPv4 のみ
    else throw new UsageError(`--host は loopback か tailnet の CGNAT(100.64.0.0/10) IPv4 のみ指定できます（tailnet 限定設計）: ${values.host}`);
    // loopback バインドに --allow-host を足してもその名前では到達できない（死に設定）。
    // proxy 前段で Host を通したい場合は config.webapp.trusted_hosts を使う。
    if (kind === 'loopback' && allowHosts.length) {
      throw new UsageError('--allow-host は loopback バインドでは到達できません（--tailnet か 100.x の --host と併用、または config.webapp.trusted_hosts を使用）');
    }
    return { host, allowedHosts: allowHosts, requireToken: !noToken, displayHost: allowHosts[0] || host, kind };
  }

  // 既定: loopback。--allow-host だけ渡しても loopback のままで到達できない（死に設定）ので弾く。
  if (allowHosts.length) {
    throw new UsageError('--allow-host は --tailnet または --host と併用してください（loopback バインドのままでは到達できません）');
  }
  return { host: '127.0.0.1', allowedHosts: [], requireToken: !noToken, displayHost: null, kind: 'loopback' };
}

/** 起動バナー行を組み立てる純関数（テスト用に export）。kind は loopback|tailnet のみ。 */
export function webBanner(bind, token, actualPort) {
  const lines = [];
  // allowlist と同じ正規化（:port / 末尾ドット除去）で URL を整える。二重ポート（name:port:port）を防ぐ。
  const raw = normalizeHost(bind.displayHost || bind.host);
  const shown = isIP(raw) === 6 ? `[${raw}]` : raw; // 真の裸 IPv6 だけ角括弧（name:port を IPv6 と誤判定しない）
  if (bind.kind === 'tailnet') {
    lines.push(`✓ ulm web を起動しました（tailnet バインド: ${bind.host}:${actualPort} / Ctrl+C で終了）`);
  } else {
    lines.push('✓ ulm web を起動しました（127.0.0.1 のみ・Ctrl+C で終了）');
  }
  lines.push(`  http://${shown}:${actualPort}${token ? `/?token=${token}` : '/'}`);
  if (token) {
    lines.push('  ※ URL の token はこの端末にだけ表示されます。token 無しのアクセスは拒否されます');
  } else if (bind.kind === 'tailnet') {
    lines.push('  ⚠ token 無しで公開中。tailnet(ACL) 内のデバイス＋このマシン上の任意プロセスが閲覧・承認できます');
  } else {
    lines.push('  ⚠ token 無しで起動中。同一ホスト上の任意プロセスが閲覧・承認できます');
  }
  return lines;
}

async function cmdWeb(args) {
  const { values } = parse(args, {
    port: { type: 'string', default: '8765' },
    tailnet: { type: 'boolean', default: false },
    host: { type: 'string' },
    'allow-host': { type: 'string', multiple: true, default: [] },
    'no-token': { type: 'boolean', default: false },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port は 0〜65535 の整数です');

  const bind = resolveWebBind(values);

  const home = ulmHome();
  ensureHome(home);
  const store = openStore(home); // サーバの寿命 = プロセスの寿命なので withStore は使わない
  let started;
  try {
    started = await startWebServer(store, loadConfig(home), home, {
      host: bind.host, port, allowedHosts: bind.allowedHosts, requireToken: bind.requireToken,
    });
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      throw new UsageError(`ポート ${port} は使用中です。別の --port を指定するか、既存の ulm web を停止してください`);
    }
    if (e && e.code === 'EADDRNOTAVAIL') {
      throw new UsageError(`${bind.host} にバインドできません（このIPがインターフェースにありません。Tailscale が接続済みか、--host の 100.x IP が正しいか確認してください）`);
    }
    throw e;
  }
  const { token, port: actual } = started;

  for (const line of webBanner(bind, token, actual)) console.log(line);
  return new Promise(() => {}); // サーバが生きている限り戻らない
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'init': return cmdInit();
      case 'obs': return await cmdObs(rest);
      case 'state': return await cmdState(rest);
      case 'cand': return await cmdCand(rest);
      case 'inbox': return await cmdInbox(rest);
      case 'show': return await cmdShow(rest);
      case 'approve': return await cmdReview(rest, 'approved');
      case 'reject': return await cmdReview(rest, 'rejected');
      case 'reject-stale': return await cmdRejectStale(rest);
      case 'promote': return await cmdPromote(rest);
      case 'ref': return await cmdRef(rest);
      case 'mine': return await cmdMine(rest);
      case 'context': return await cmdContext(rest);
      case 'recall': return await cmdRecall(rest);
      case 'capture': return await cmdCapture(rest);
      case 'reindex': return await cmdReindex(rest);
      case 'export': return await cmdExport(rest);
      case 'import': return await cmdImport(rest);
      case 'status': return await cmdStatus();
      case 'doctor': return cmdDoctor();
      case 'web': return await cmdWeb(rest);
      case 'help': case '--help': case '-h': case undefined:
        console.log(HELP);
        return 0;
      default:
        console.error(`不明なコマンド: ${cmd}\n`);
        console.log(HELP);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError || err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || err.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      console.error(`使い方エラー: ${err.message}`);
      return 2;
    }
    throw err;
  }
}
