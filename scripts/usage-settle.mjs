#!/usr/bin/env node
// Read-only settlement check: match this checkout's budget ledger to Comfy Cloud billing (the documented
// GET /api/billing/usage/timeseries, grouped by model, hourly) by model and time window, and report the variance.
//
//   pnpm usage:settle -- --from 2026-10-30 --to 2026-10-31 --tz America/Los_Angeles
//   pnpm usage:settle -- --from 2026-10-30 --json --granularity day
//
// What it can and cannot say. The timeseries has no job or prompt IDs, so a ledger entry is never matched to a billed job.
// A billed (model, window) bucket is compared with the ledger entries that finished in that window on that model:
//   single      the only ledger entry on that model in that window: its variance is billed − ledger. This assumes nothing
//               else billed to that model in the window (another checkout, a manual run); the report says so.
//   aggregate   several entries share the window: only the window total is compared, no per-entry variance is invented.
//   pending     no billing in the window yet and the entry is under 24 h old: billing lags, so this is not zero.
//   unbilled    no billing in the window after 24 h (after 72 h: ask Comfy support for the raw events, do not invent a charge).
//   unmapped    no billing model is known for the entry's model name: not compared.
// A refgen still that was graded is split in two parts (the image model and the Gemini grader), which bill under different models.
// Billing groups with no ledger entry at all are listed as unattributed (spend outside this app, other checkouts, other users).
// Needs COMFY_CLOUD_API_KEY (pnpm usage:settle loads .env); the key is only sent to https://cloud.comfy.org and never printed.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, fetchUsage, localDate } from './usage-report.mjs';

const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const finite = Number.isFinite;
const HOUR = 3600e3, DAY = 24 * HOUR;
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Ledger model name → billing group, both compared with every non-alphanumeric removed, lower-case. First match wins.
// Billing keys seen on this account: flux-2-pro, dreamina-seedance-2-5-260628, veo-3.1-generate-001. The rest are the providers'
// public model names and have not been seen in a real report yet; an entry that matches none is reported as unmapped, never guessed.
export const MODEL_MATCHERS = [
  { name: 'Still grader', ledger: /stillgrader/, billing: /gemini35flash|gemini3flash(?!image)|geminiflash(?!image)/ },
  { name: 'FLUX.2 Pro', ledger: /flux2pro/, billing: /flux2pro/ }, { name: 'FLUX.2 Max', ledger: /flux2max/, billing: /flux2max/ },
  { name: 'FLUX 3', ledger: /flux3/, billing: /flux3/ }, { name: 'FLUX 1.1 Ultra', ledger: /flux11.*ultra|fluxultra/, billing: /flux11.*ultra|fluxultra/ },
  { name: 'GPT Image', ledger: /gptimage/, billing: /gptimage/ }, { name: 'Seedream', ledger: /seedream/, billing: /seedream/ },
  { name: 'Nano Banana Pro', ledger: /nanobananapro|gemini3proimage/, billing: /gemini3proimage|nanobananapro/ },
  { name: 'Nano Banana 2', ledger: /nanobanana2|gemini31flashimage/, billing: /gemini31flashimage|nanobanana2/ },
  { name: 'Seedance', ledger: /seedance/, billing: /seedance/ }, { name: 'LTX', ledger: /ltx/, billing: /ltx/ }, { name: 'Kling', ledger: /kling/, billing: /kling/ },
  { name: 'Veo', ledger: /veo/, billing: /veo/ }, { name: 'Hailuo', ledger: /hailuo|minimax/, billing: /hailuo|minimax/ }, { name: 'Wan', ledger: /wan2|wanvace|wan27/, billing: /wan2|wanvace|wan27/ },
];
const matcherFor = model => { const n = norm(model); return n ? MODEL_MATCHERS.find(m => m.ledger.test(n)) || null : null; };

/** Parts of one ledger entry that bill under different models: a graded still is the image model plus the Gemini grader. */
export function entryParts(r) {
  const usd = m => (finite(m) ? m : 0) / 1e6, settled = r.state === 'settled';
  const total = settled ? usd(r.costMicros) : usd(r.expectedMicros ?? r.reserveMicros);
  const grader = r.components?.graderUsd || 0;
  if (r.source === 'refgen' && grader > 0 && settled) {
    // Settled cost = list + references + grades × grader price; the quoted allowance covered `grader` of it.
    const nonGrader = usd(r.expectedMicros ?? r.reserveMicros) - grader, gradeUsd = Math.max(0, round(total - nonGrader, 6));
    return [{ model: r.model, usd: round(total - gradeUsd, 6) }, ...(gradeUsd > 0 ? [{ model: 'Still grader', usd: gradeUsd }] : [])];
  }
  if (r.source === 'refgen' && grader > 0) return [{ model: r.model, usd: round(total - grader, 6) }, { model: 'Still grader', usd: grader }];
  return [{ model: r.model || (r.source === 'grader' ? 'Still grader' : null), usd: total }];
}

const windowOf = (t, granularity) => { const size = granularity === 'hour' ? HOUR : DAY; return Math.floor(t / size) * size; };

/**
 * Compare ledger entries with a parsed by-model timeseries (scripts/usage-report.mjs parseUsage). Pure.
 *   ledger: the budget ledger.json object; usage: parseUsage output with `buckets`, `rows` and `granularity`.
 */
export function settleLedger({ ledger, usage, start, end, now = Date.now() }) {
  const granularity = usage.granularity === 'hour' ? 'hour' : 'day';
  const labels = new Map(usage.rows.map(r => [r.key, r]));
  const groupOf = (m, key) => m.billing.test(norm(key)) || m.billing.test(norm(labels.get(key)?.name));
  const groupKeys = [...new Set([...usage.rows.map(r => r.key), ...usage.buckets.map(b => b.key).filter(Boolean)])];
  const bucketUsd = (key, windowStart) => round(usage.buckets.filter(b => b.key === key && Date.parse(b.start) === windowStart).reduce((t, b) => t + b.usd, 0), 6);

  const entries = [];
  for (const r of Object.values(ledger?.reservations || {})) {
    if (!['settled', 'held', 'reserved'].includes(r.state)) continue;
    const at = Date.parse(r.state === 'settled' ? r.endedAt || r.createdAt : r.createdAt);
    if (!(at >= +start && at < +end)) continue;
    entries.push({ id: r.id, source: r.source, model: r.model, state: r.state, costStatus: r.costStatus, at, parts: entryParts(r) });
  }
  // Group the parts by (billing model, window).
  const cells = new Map();
  for (const e of entries) for (const part of e.parts) {
    const m = matcherFor(part.model);
    part.matcher = m?.name || null;
    if (!m) { part.match = 'unmapped'; continue; }
    const keys = groupKeys.filter(k => groupOf(m, k)), w = windowOf(e.at, granularity), cellKey = `${m.name}|${w}`;
    const cell = cells.get(cellKey) || { model: m.name, groupKeys: keys, windowStart: w, windowEnd: w + (granularity === 'hour' ? HOUR : DAY), parts: [], ledgerUsd: 0 };
    cell.parts.push({ entry: e, part }); cell.ledgerUsd = round(cell.ledgerUsd + part.usd, 6); cells.set(cellKey, cell);
  }
  const windows = [];
  for (const cell of cells.values()) {
    const billedUsd = round(cell.groupKeys.reduce((t, k) => t + bucketUsd(k, cell.windowStart), 0), 6);
    const varianceUsd = round(billedUsd - cell.ledgerUsd, 6), n = cell.parts.length;
    const newest = Math.max(...cell.parts.map(p => p.entry.at)), age = now - newest;
    for (const { entry, part } of cell.parts) {
      const edge = Math.min(entry.at - cell.windowStart, cell.windowEnd - entry.at) < 5 * 60e3;
      if (billedUsd > 0) Object.assign(part, n === 1
        ? { match: 'single', billedUsd, varianceUsd, note: 'assumes nothing else billed to this model in the window' }
        : { match: 'aggregate', windowBilledUsd: billedUsd, windowLedgerUsd: cell.ledgerUsd, windowEntries: n });
      else Object.assign(part, age < DAY ? { match: 'pending', note: 'billing lags; a missing charge is pending, not zero' }
        : { match: 'unbilled', note: age >= 3 * DAY ? 'no charge after 72 h: ask Comfy for the raw billing events; do not assume zero or invent one' : 'no charge in the window after 24 h: recheck later' });
      if (edge) part.nearWindowEdge = true;
    }
    windows.push({ model: cell.model, windowStart: new Date(cell.windowStart).toISOString(), windowEnd: new Date(cell.windowEnd).toISOString(), entries: n, ledgerUsd: cell.ledgerUsd, billedUsd, varianceUsd,
      match: billedUsd > 0 ? (n === 1 ? 'single' : 'aggregate') : age < DAY ? 'pending' : 'unbilled' });
  }
  windows.sort((a, b) => a.windowStart.localeCompare(b.windowStart) || a.model.localeCompare(b.model));

  // Per entry: variance only when every part matched a single-entry window.
  const out = entries.map(e => ({ id: e.id, source: e.source, model: e.model, state: e.state, costStatus: e.costStatus, at: new Date(e.at).toISOString(), ledgerUsd: round(e.parts.reduce((t, p) => t + p.usd, 0), 6),
    parts: e.parts.map(p => ({ model: p.model, ledgerUsd: round(p.usd, 6), billingModel: p.matcher, match: p.match, ...(p.match === 'single' ? { billedUsd: p.billedUsd, varianceUsd: p.varianceUsd } : {}), ...(p.match === 'aggregate' ? { windowBilledUsd: p.windowBilledUsd, windowLedgerUsd: p.windowLedgerUsd, windowEntries: p.windowEntries } : {}), ...(p.nearWindowEdge ? { nearWindowEdge: true } : {}), ...(p.note ? { note: p.note } : {}) })) }))
    .map(e => ({ ...e, match: e.parts.every(p => p.match === 'single') ? 'single' : e.parts.some(p => p.match === 'unmapped') ? 'unmapped' : e.parts.every(p => p.match === 'single' || p.match === 'aggregate') ? 'aggregate' : e.parts.find(p => ['pending', 'unbilled'].includes(p.match))?.match || 'aggregate',
      varianceUsd: e.parts.every(p => p.match === 'single') ? round(e.parts.reduce((t, p) => t + p.billedUsd - p.ledgerUsd, 0), 6) : null }))
    .sort((a, b) => a.at.localeCompare(b.at));

  // Model-level control totals over the whole range (the dependable comparison).
  const byModel = new Map();
  for (const w of windows) { const m = byModel.get(w.model) || { model: w.model, ledgerUsd: 0, billedUsd: 0, windows: 0 }; m.ledgerUsd += w.ledgerUsd; m.billedUsd += w.billedUsd; m.windows++; byModel.set(w.model, m); }
  const matchedKeys = new Set(); for (const c of cells.values()) for (const k of c.groupKeys) matchedKeys.add(k);
  // Billing in the range that the windows above do not cover: model groups no ledger entry maps to, and billed windows with no ledger entry.
  const unattributed = usage.rows.filter(r => !matchedKeys.has(r.key) && r.usd >= 0.005).map(r => ({ key: r.key, name: r.name, billedUsd: round(r.usd, 4) }));
  const coveredBilled = new Set([...cells.values()].flatMap(c => c.groupKeys.map(k => `${k}|${c.windowStart}`)));
  const extraWindows = usage.buckets.filter(b => b.key && matchedKeys.has(b.key) && b.usd >= 0.005 && !coveredBilled.has(`${b.key}|${Date.parse(b.start)}`)).map(b => ({ key: b.key, windowStart: b.start, billedUsd: round(b.usd, 4) }));
  return {
    granularity, windows, entries: out,
    byModel: [...byModel.values()].map(m => ({ ...m, ledgerUsd: round(m.ledgerUsd), billedUsd: round(m.billedUsd), varianceUsd: round(m.billedUsd - m.ledgerUsd) })).sort((a, b) => Math.abs(b.billedUsd - b.ledgerUsd) - Math.abs(a.billedUsd - a.ledgerUsd)),
    unattributed, billedWithoutLedger: extraWindows,
    counts: { entries: out.length, single: out.filter(e => e.match === 'single').length, aggregate: out.filter(e => e.match === 'aggregate').length, pending: out.filter(e => e.match === 'pending').length, unbilled: out.filter(e => e.match === 'unbilled').length, unmapped: out.filter(e => e.match === 'unmapped').length },
    unmappedModels: [...new Set(out.flatMap(e => e.parts).filter(p => p.match === 'unmapped').map(p => p.model || '(none)'))],
  };
}

const money = x => (x === null || x === undefined ? '—' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`);
const signed = x => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(3)}`);
const pad = (s, n) => (String(s).length >= n ? String(s).slice(0, n - 1) + '…' : String(s).padEnd(n));
const lpad = (s, n) => String(s).padStart(n);

export function formatSettlement({ args, usage, result }) {
  const out = [], from = localDate(args.start, args.tz), toIncl = localDate(args.end.getTime() - 1, args.tz);
  out.push(`Ledger vs billing ${from}${toIncl !== from ? ` → ${toIncl}` : ''} (${args.tz}); billing buckets are ${result.granularity === 'hour' ? 'hourly' : 'daily'} UTC, as of ${usage.asOf || 'unknown'} (invoice-derived, lags)`);
  out.push('Matching is by model and time window only: the timeseries carries no job IDs, so no entry is matched to a billed job.');
  if (result.granularity !== 'hour') out.push('  The API returned daily buckets, so every entry shares its model\'s day window: only the aggregate comparison is meaningful.');
  const c = result.counts;
  out.push(`Ledger entries ${c.entries}: ${c.single} single-in-window, ${c.aggregate} aggregate-only (no per-entry variance), ${c.pending} pending, ${c.unbilled} unbilled, ${c.unmapped} unmapped model`);
  out.push('', 'By model (whole range: the dependable comparison)', `  ${pad('', 22)} ${lpad('ledger', 9)} ${lpad('billed', 9)} ${lpad('variance', 10)}`);
  for (const m of result.byModel) out.push(`  ${pad(m.model, 22)} ${lpad(m.ledgerUsd.toFixed(2), 9)} ${lpad(m.billedUsd.toFixed(2), 9)} ${lpad(signed(m.varianceUsd), 10)}`);
  if (!result.byModel.length) out.push('  (no ledger entry in range maps to a billing model)');
  const single = result.entries.filter(e => e.match === 'single');
  out.push('', `Per entry: exact only where an entry is alone on its model in its window (${single.length})`);
  for (const e of single.slice(0, 40)) out.push(`  ${e.at.slice(0, 16)}Z  ${pad(`${e.source} · ${e.model || '?'}`, 40)} ledger ${money(e.ledgerUsd)}  billed ${money(e.ledgerUsd + e.varianceUsd)}  ${signed(e.varianceUsd)}${e.parts.some(p => p.nearWindowEdge) ? '  (near the window edge)' : ''}`);
  if (single.length > 40) out.push(`  … ${single.length - 40} more (use --json)`);
  const shared = result.windows.filter(w => w.match === 'aggregate');
  out.push('', `Windows shared by several entries: window total only, no per-entry split (${shared.length})`);
  for (const w of shared.slice(0, 30)) out.push(`  ${w.windowStart.slice(0, 16)}Z  ${pad(w.model, 20)} ${w.entries} entries  ledger ${money(w.ledgerUsd)}  billed ${money(w.billedUsd)}  ${signed(w.varianceUsd)}`);
  const pending = result.entries.filter(e => e.match === 'pending'), unbilled = result.entries.filter(e => e.match === 'unbilled');
  if (pending.length) out.push('', `Pending (no billing yet, under 24 h old; not zero): ${pending.length} entries, ledger ${money(pending.reduce((t, e) => t + e.ledgerUsd, 0))}`);
  if (unbilled.length) out.push('', `Unbilled in their window after 24 h: ${unbilled.length} entries, ledger ${money(unbilled.reduce((t, e) => t + e.ledgerUsd, 0))}. Recheck; past 72 h ask Comfy for the raw events. No charge is invented.`);
  if (result.unmappedModels.length) out.push('', `Not compared (no billing model known): ${result.unmappedModels.join(', ')}. Add a matcher in scripts/usage-settle.mjs once their billing key is seen.`);
  if (result.unattributed.length) { out.push('', 'Billed but unattributed (no ledger entry maps to these: other checkouts, other users, runs outside the app)'); for (const u of result.unattributed.slice(0, 15)) out.push(`  ${pad(u.name, 52)} ${lpad(u.billedUsd.toFixed(2), 9)}`); }
  if (result.billedWithoutLedger.length) out.push('', `Billed on a mapped model in a window with no ledger entry: ${result.billedWithoutLedger.length} windows, ${money(result.billedWithoutLedger.reduce((t, w) => t + w.billedUsd, 0))}`);
  return out.join('\n');
}

async function readLedger(dir) {
  try { return JSON.parse(await readFile(join(dir, 'ledger.json'), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function main() {
  const argv = process.argv.slice(2), g = argv.indexOf('--granularity');
  const granularity = g >= 0 ? argv.splice(g, 2)[1] : 'hour';
  if (!['hour', 'day'].includes(granularity)) throw Error('--granularity must be hour or day');
  const args = parseArgs(argv);
  if (args.help) { console.log('Usage: pnpm usage:settle [-- --from YYYY-MM-DD|ISO] [--to YYYY-MM-DD|ISO (exclusive)] [--tz Area/City] [--ledger dir] [--granularity hour|day] [--json]'); return; }
  const key = process.env.COMFY_CLOUD_API_KEY;
  if (!key) throw Error('Set COMFY_CLOUD_API_KEY in the environment (or .env)');
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const ledgerDir = resolve(args.ledger || process.env.PREVIS_BUDGET_DIR || join(process.env.PREVIS_DATA_DIR || join(root, '.previs'), 'budget'));
  const [usage, ledger] = await Promise.all([fetchUsage({ ...args, groupBy: 'model', granularity, key }), readLedger(ledgerDir)]);
  if (!ledger) throw Error(`No ledger at ${ledgerDir} (nothing was reserved by this checkout; pass --ledger <dir>)`);
  const result = settleLedger({ ledger, usage, start: args.start, end: args.end });
  if (args.json) console.log(JSON.stringify({ fetchedAt: new Date().toISOString(), timeZone: args.tz, startingOn: args.start.toISOString(), endingBefore: args.end.toISOString(), asOf: usage.asOf, ledgerDir, ...result }, null, 2));
  else console.log(formatSettlement({ args, usage, result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error(`usage-settle: ${e.message}`); process.exit(1); });
