// ulm CLI — コマンドディスパッチ
import { parseArgs } from 'node:util';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { ulmHome, ensureHome, loadConfig } from './config.js';
import { openStore } from './store.js';
import { compileGate, detectHighEntropy } from './gate.js';
import { buildContext, hookOutput } from './context.js';
import { exportAll } from './exporter.js';
import { mine } from './miner.js';
import { runDoctor } from './doctor.js';
import { checkWriteTarget } from './safepath.js';
import { resolveProject } from './project.js';
import { nowIso, parseTtl, readStdin, shortDate, splitCsv, truncate, parseJsonSafe } from './util.js';

const HELP = `ulm — user-level memory（ユーザーレベル長期記憶 CLI）

知識の置き場 4 段（CLAUDE.md / ref / bd / ulm）のうち、「現場の勘所を育てる生もの」の層。
観測は追記、状態は上書き+TTL、仮説は inbox で育てて人間の承認で ref へ昇格する。

観測:
  ulm obs add <text|-> [--tags a,b] [--secret] [--pin] [--project P] [--source S] [--meta json]
  ulm obs list [--project P] [--days N] [--tags t] [--pinned] [--all] [--include-secret] [--json]
  ulm obs search <query> [--json]
  ulm obs show <id> | ulm show <id>
  ulm obs pin|unpin|secret|archive|redact <id>      訂正・整理（redact=墓石化）
  ulm obs tag <id> +add,-remove
状態:
  ulm state set <key> <value> [--ttl 7d] [--scope S|project] [--secret]
  ulm state get <key> [--scope S]      ulm state list [--all] [--json]      ulm state unset <key>
仮説（遊び場 / 採用は人間が決める）:
  ulm cand add <hypothesis> [--conditions C] [--counter X]... [--evidence id,..]
  ulm cand edit <id> [--conditions C] [--note N]
  ulm inbox [--json] | ulm show <id>
  ulm approve|reject <id> [--note N] [--yes]
  ulm promote <id> [--ref file.md] [--yes]          承認済みを ref へ昇格（人間の操作）
  ulm reject-stale [--days 90]
採掘 / ref / 注入 / 運用:
  ulm mine [--project P] [--days N] [--limit M] [--provider codex|openai] [--dry-run]
  ulm ref add <path.md> [--note N] [--project P] | ulm ref list | ulm ref rm <id|path>
  ulm context [--project P] [--hook] [--json]
  ulm export [--quiet] | ulm import <dir> | ulm status | ulm doctor

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

/** 書き込み時の機密ゲート。一致したら secret 強制 + 警告。エントロピーは警告のみ。 */
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
    if (ent) notes.push(`高エントロピー文字列 (${ent}) を検出。機密なら --secret を付けてください。`);
  }
  return { secret, notes };
}

function printObs(o, { full = false } = {}) {
  const tags = o.tags.length ? ` #${o.tags.join(' #')}` : '';
  const flags = [o.secret && '🔒secret', o.pinned && '📌pin', o.archived && '🗄archived'].filter(Boolean).join(' ');
  const proj = o.project ? ` (${o.project})` : ' (global)';
  const text = full ? o.text : truncate(o.text.replace(/\s*\n\s*/g, ' '), 100);
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
      const list = store.listObservations({
        project: values.project,
        days: values.all ? undefined : values.days ? Number(values.days) : sub === 'list' ? 30 : undefined,
        tags: splitCsv(values.tags),
        includeSecret,
        includeArchived: values.all || values.archived,
        pinnedOnly: values.pinned,
        limit: Number(values.limit),
        query: sub === 'search' ? positionals.join(' ') : undefined,
      });
      if (values.json) {
        console.log(JSON.stringify(list, null, 2));
        return 0;
      }
      if (!list.length) console.log('（観測なし）');
      else for (const o of list) printObs(o);
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
  const scopeOf = (values) => (values.scope === 'project' ? resolveProject(process.cwd()) : values.scope || 'global');
  if (sub === 'set') {
    const { values, positionals } = parse(args.slice(1), {
      scope: { type: 'string' },
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
      const { secret, notes } = gateWrite(config, value, { explicitSecret: values.secret });
      for (const n of notes) console.error(`⚠ ${n}`);
      store.setState(key, value, { scope: scopeOf(values), ttlMs, secret });
      console.log(`✓ state を更新: ${key}${values.ttl ? ` (TTL ${values.ttl})` : ''}${secret ? ' (secret)' : ''}`);
      return 0;
    });
  }
  if (sub === 'get') {
    const { values, positionals } = parse(args.slice(1), { scope: { type: 'string' } }, { positionals: 1 });
    return withStore((store) => {
      const scope = scopeOf(values);
      // scope 解決順: 指定 scope → global フォールバック
      const r = store.getState(positionals[0], { scope }) || (scope !== 'global' ? store.getState(positionals[0], { scope: 'global' }) : null);
      if (!r) {
        console.error('（未設定または期限切れ）');
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
    return withStore((store) => {
      const rows = store.listStates({ includeExpired: values.all });
      if (values.json) {
        console.log(JSON.stringify(rows, null, 2));
        return 0;
      }
      if (!rows.length) console.log('（state なし）');
      else for (const r of rows) {
        const expired = r.expires_at && r.expires_at <= nowIso();
        const exp = r.expires_at ? ` [期限 ${shortDate(r.expires_at)}${expired ? ' 切れ' : ''}]` : '';
        const sec = r.secret ? ' 🔒' : '';
        const val = r.secret ? '***' : truncate(r.value, 120);
        console.log(`${r.scope === 'global' ? '' : `(${r.scope}) `}${r.key}${sec} = ${val}${exp}`);
      }
      return 0;
    });
  }
  if (sub === 'unset') {
    const { values, positionals } = parse(args.slice(1), { scope: { type: 'string' } }, { positionals: 1 });
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
    if (status === 'approved') console.log(`  昇格するには: ulm promote ${c.id} [--ref <file.md>]`);
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

function cmdPromote(args) {
  const { values, positionals } = parse(args, {
    ref: { type: 'string' },
    yes: { type: 'boolean', default: false },
  }, { positionals: 1 });
  requireHuman(values, 'promote');
  return withStore((store, config, home) => {
    const c = store.getCandidate(positionals[0]);
    if (!c) throw new Error(`候補が見つかりません: ${positionals[0]}`);
    if (c.status === 'promoted') throw new Error(`既に昇格済みです: ${c.promoted_to}`);
    if (c.status !== 'approved') {
      throw new Error(`昇格できるのは approved の候補のみです（現在: ${c.status}）。まず ulm approve ${c.id}`);
    }
    const refRoot = join(home, 'ref');
    const target = values.ref ? resolve(values.ref) : join(refRoot, 'promoted.md');
    const check = checkWriteTarget(target, { refRoot, allowRoots: [process.cwd()] });
    if (!check.ok) throw new Error(`昇格先を拒否: ${check.reason}`);

    const block = [
      ``,
      `## ${c.hypothesis}`,
      ``,
      ...(c.conditions ? [`- 条件: ${c.conditions}`] : []),
      ...c.counterexamples.map((x) => `- 反例: ${x}`),
      ...(c.evidence.length ? [`- 根拠: ${c.evidence.join(', ')}`] : []),
      `- 出自: ${c.origin} / 承認 ${shortDate(c.reviewed_at || nowIso())} / 昇格 ${shortDate(nowIso())} (${c.id})`,
      ``,
    ].join('\n');
    mkdirSync(dirname(check.path), { recursive: true });
    appendFileSync(check.path, block);
    store.markPromoted(c.id, check.path);
    store.addRef({ path: check.path, note: 'ulm promote による昇格先', project: c.project });
    console.log(`✓ ${c.id} を ref へ昇格: ${check.path}`);
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
  return withStore((store) => {
    let total = 0;
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
      const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => parseJsonSafe(l, null)).filter(Boolean);
      const n = store.importRows(table, rows);
      if (n) console.log(`  ${file}: ${n} 行を取込`);
      total += n;
    }
    console.log(`✓ import 完了: 合計 ${total} 行（既存 ID は INSERT OR IGNORE でスキップ）`);
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
      case 'export': return await cmdExport(rest);
      case 'import': return await cmdImport(rest);
      case 'status': return await cmdStatus();
      case 'doctor': return cmdDoctor();
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
