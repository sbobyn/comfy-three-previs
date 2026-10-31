#!/usr/bin/env node
// Read-only Comfy Cloud usage report: billed spend per model and per product for a date range (the documented
// GET /api/billing/usage/timeseries), joined with this checkout's local budget ledger (reserved / settled estimates).
//
//   pnpm usage:report                                   # yesterday, in the local time zone
//   pnpm usage:report -- --from 2026-10-29 --to 2026-10-31 --tz America/Los_Angeles
//   pnpm usage:report -- --from 2026-10-29T00:00:00-07:00 --to 2026-10-30T00:00:00-07:00 --json
//
// Dates are local midnights in --tz (default: this machine's zone); --to is exclusive. Needs COMFY_CLOUD_API_KEY in the
// environment (pnpm usage:report loads .env if present); the key is only sent to https://cloud.comfy.org and never printed.
// Units: cost_micros and spend_micros are millionths of a dollar; the balance is in cents (the API also returns the same
// cents value under misleading *_micros names). Billing totals are invoice-derived and lag; recent usage may be missing.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENDPOINT = 'https://cloud.comfy.org/api/billing/usage/timeseries';
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const finite = Number.isFinite;

/** Offset (ms) of a time zone at an instant: local wall time − UTC. */
function zoneOffset(at, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at / 1000) * 1000;
}
/** A YYYY-MM-DD date at local midnight in timeZone, or an ISO timestamp with its own offset, as a Date. */
export function boundary(value, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (m) {
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    let at = wall - zoneOffset(wall, timeZone);
    at = wall - zoneOffset(at, timeZone); // DST: re-check at the found instant
    return new Date(at);
  }
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(value || ''))) throw Error(`Pass a date (YYYY-MM-DD) or an ISO timestamp with an offset, not "${value}"`);
  const d = new Date(value);
  if (!finite(+d)) throw Error(`Invalid time "${value}"`);
  return d;
}
/** Local calendar date (YYYY-MM-DD) of an instant in timeZone. */
export const localDate = (at, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));

export function parseArgs(argv, { now = Date.now(), timeZone: zone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const a = { json: false, ledger: null, tz: zone };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], next = () => { const v = argv[++i]; if (v === undefined) throw Error(`${k} needs a value`); return v; };
    if (k === '--') continue;
    else if (k === '--from') a.from = next(); else if (k === '--to') a.to = next(); else if (k === '--tz') a.tz = next();
    else if (k === '--ledger') a.ledger = next(); else if (k === '--json') a.json = true;
    else if (k === '-h' || k === '--help') a.help = true;
    else throw Error(`Unknown option ${k}`);
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: a.tz }); } catch { throw Error(`Unknown time zone ${a.tz}`); }
  const today = localDate(now, a.tz), yesterday = localDate(boundary(today, a.tz).getTime() - 12 * 3600e3, a.tz);
  const start = boundary(a.from || yesterday, a.tz), end = boundary(a.to || (a.from && /^\d{4}-\d{2}-\d{2}$/.test(a.from) ? localDate(start.getTime() + 36 * 3600e3, a.tz) : today), a.tz);
  if (!(start < end)) throw Error('--from must be before --to (--to is exclusive)');
  return { ...a, start, end };
}

/** One timeseries response → USD. Throws on a schema it does not understand rather than guessing. */
export function parseUsage(data) {
  if (!data || typeof data !== 'object' || !finite(data.summary?.spend_micros) || !Array.isArray(data.breakdown)) throw Error('Unexpected usage schema: no summary.spend_micros or breakdown');
  const labels = new Map((data.group_labels || []).map(l => [l.key, l]));
  const rows = data.breakdown.map(r => {
    if (typeof r.group_key !== 'string' || !finite(r.cost_micros)) throw Error('Unexpected usage schema: a breakdown row has no group_key or cost_micros');
    const l = labels.get(r.group_key);
    return { key: r.group_key, name: l?.display_name || r.group_key, provider: l?.provider_display_name || l?.provider || null, usd: r.cost_micros / 1e6, share: finite(r.share) ? r.share : null, runs: finite(r.run_count) ? r.run_count : null };
  }).sort((x, y) => y.usd - x.usd);
  const days = new Map(), buckets = [];
  for (const b of data.buckets || []) {
    if (!finite(b.cost_micros) || typeof b.period_start !== 'string') throw Error('Unexpected usage schema: a bucket has no period_start or cost_micros');
    days.set(b.period_start, (days.get(b.period_start) || 0) + b.cost_micros / 1e6);
    buckets.push({ key: typeof b.group_key === 'string' ? b.group_key : null, start: b.period_start, end: typeof b.period_end === 'string' ? b.period_end : null, usd: b.cost_micros / 1e6 });
  }
  const bal = data.summary.balance;
  // Balance fields are cents: prefer the *_cents names, fall back to the misnamed *_micros ones (same values).
  const cents = name => finite(bal?.[`${name}_cents`]) ? bal[`${name}_cents`] : finite(bal?.[`${name}_micros`]) ? bal[`${name}_micros`] : null;
  const balance = bal ? { currency: bal.currency || null, totalUsd: cents('amount') === null ? null : cents('amount') / 100, cloudCreditUsd: cents('cloud_credit_balance') === null ? null : cents('cloud_credit_balance') / 100, prepaidUsd: cents('prepaid_balance') === null ? null : cents('prepaid_balance') / 100 } : null;
  return { groupBy: data.group_by || null, granularity: data.granularity || null, asOf: data.as_of || null, servedFrom: data.served_from || null, billedUsd: data.summary.spend_micros / 1e6, balance, rows, buckets, days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([start, usd]) => ({ start, usd })) };
}

/** The local reservation ledger for reservations made in [start, end): read-only, never locked or written. */
export function summarizeLedger(ledger, start, end) {
  const list = Object.values(ledger?.reservations || {}).filter(r => { const t = Date.parse(r.createdAt); return t >= +start && t < +end; });
  const usd = m => (finite(m) ? m : 0) / 1e6, sum = (rows, f) => round(rows.reduce((t, r) => t + f(r), 0), 4);
  const by = state => list.filter(r => r.state === state);
  const outstanding = list.filter(r => r.state === 'reserved' || r.state === 'held');
  const models = new Map();
  for (const r of list) {
    if (!['settled', 'reserved', 'held'].includes(r.state)) continue;
    const k = `${r.source || '?'} · ${r.model || '?'}`, m = models.get(k) || { name: k, settledUsd: 0, reservedUsd: 0, count: 0 };
    if (r.state === 'settled') m.settledUsd += usd(r.costMicros); else m.reservedUsd += usd(r.reserveMicros);
    m.count++; models.set(k, m);
  }
  return {
    reservations: list.length,
    settled: { count: by('settled').length, usd: sum(by('settled'), r => usd(r.costMicros)), billed: by('settled').filter(r => r.costStatus === 'billed').length },
    reserved: { count: by('reserved').length, usd: sum(by('reserved'), r => usd(r.reserveMicros)) },
    held: { count: by('held').length, usd: sum(by('held'), r => usd(r.reserveMicros)) },
    outstandingUsd: sum(outstanding, r => usd(r.reserveMicros)),
    released: by('released').length, expired: by('expired').length,
    unknownCost: list.filter(r => r.costStatus === 'unknown').length,
    byModel: [...models.values()].map(m => ({ ...m, settledUsd: round(m.settledUsd, 4), reservedUsd: round(m.reservedUsd, 4) })).sort((a, b) => b.settledUsd + b.reservedUsd - a.settledUsd - a.reservedUsd),
  };
}

export async function fetchUsage({ start, end, groupBy, key, granularity = 'day', fetcher = fetch }) {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({ group_by: groupBy, granularity, starting_on: start.toISOString(), ending_before: end.toISOString() }).toString();
  const response = await fetcher(url, { headers: { 'X-API-Key': key, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  // Never echo the body of an error (it is not ours to print); the status says enough.
  if (!response.ok) throw Error(`Usage report HTTP ${response.status} for group_by=${groupBy}${response.status === 401 || response.status === 403 ? ' (check COMFY_CLOUD_API_KEY)' : ''}`);
  return parseUsage(await response.json());
}

const money = x => (x === null || x === undefined ? '—' : `$${x.toFixed(2)}`);
const pad = (s, n) => String(s).length >= n ? String(s).slice(0, n - 1) + '…' : String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

export function formatReport({ args, model, product, ledger, ledgerDir }) {
  const out = [], from = localDate(args.start, args.tz), toIncl = localDate(args.end.getTime() - 1, args.tz);
  out.push(`Comfy Cloud usage ${from}${toIncl !== from ? ` → ${toIncl}` : ''} (${args.tz}; ${args.start.toISOString()} – ${args.end.toISOString()})`);
  out.push(`As of ${model.asOf || 'unknown'}. Invoice-derived: recent usage may be missing.`);
  const b = model.balance;
  out.push(`Billed: ${money(model.billedUsd)}${b ? `    Balance: ${money(b.totalUsd)} ${b.currency || ''} (cloud credit ${money(b.cloudCreditUsd)}, prepaid ${money(b.prepaidUsd)})` : ''}`);
  const table = (title, rows) => {
    out.push('', title);
    out.push(`  ${pad('', 52)} ${lpad('USD', 9)} ${lpad('share', 6)} ${lpad('runs', 5)}`);
    for (const r of rows.filter(r => r.usd >= 0.005)) out.push(`  ${pad(r.provider ? `${r.name} (${r.provider})` : r.name, 52)} ${lpad(r.usd.toFixed(2), 9)} ${lpad(r.share === null ? '' : `${(r.share * 100).toFixed(1)}%`, 6)} ${lpad(r.runs ?? '', 5)}`);
    const small = rows.filter(r => r.usd < 0.005).length; if (small) out.push(`  (${small} more under half a cent)`);
  };
  table('By model', model.rows);
  table('By product (the same spend in another view; never add the two)', product.rows);
  if (model.days.length > 1) { out.push('', 'By day (UTC buckets)'); for (const d of model.days) out.push(`  ${d.start.slice(0, 10)}  ${lpad(d.usd.toFixed(2), 9)}`); }
  out.push('', `Local budget ledger (${ledgerDir}): list-price estimates for reservations made in this range`);
  if (!ledger) out.push('  No ledger found (nothing has been reserved by this checkout, or pass --ledger <dir>).');
  else {
    out.push(`  Settled ${money(ledger.settled.usd)} (${ledger.settled.count}${ledger.settled.billed ? `, ${ledger.settled.billed} billed` : ''})   Outstanding ${money(ledger.outstandingUsd)} (${ledger.reserved.count} reserved, ${ledger.held.count} held)   Released ${ledger.released}   Expired ${ledger.expired}${ledger.unknownCost ? `   Unknown cost ${ledger.unknownCost}` : ''}`);
    for (const m of ledger.byModel.slice(0, 15)) out.push(`  ${pad(m.name, 52)} ${lpad(m.settledUsd.toFixed(2), 9)}${m.reservedUsd ? ` + ${m.reservedUsd.toFixed(2)} outstanding` : ''} (${m.count})`);
    const gap = round(model.billedUsd - ledger.settled.usd);
    out.push(`  Billed minus settled locally: ${money(gap)} (spend outside this app, other checkouts, late invoices, or estimate error; not attributed to jobs)`);
  }
  return out.join('\n');
}

async function readLedger(dir) {
  try { return JSON.parse(await readFile(join(dir, 'ledger.json'), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log('Usage: pnpm usage:report [-- --from YYYY-MM-DD|ISO] [--to YYYY-MM-DD|ISO (exclusive)] [--tz Area/City] [--ledger dir] [--json]'); return; }
  const key = process.env.COMFY_CLOUD_API_KEY;
  if (!key) throw Error('Set COMFY_CLOUD_API_KEY in the environment (or .env)');
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const ledgerDir = resolve(args.ledger || process.env.PREVIS_BUDGET_DIR || join(process.env.PREVIS_DATA_DIR || join(root, '.previs'), 'budget'));
  const [model, product, raw] = await Promise.all([fetchUsage({ ...args, groupBy: 'model', key }), fetchUsage({ ...args, groupBy: 'product', key }), readLedger(ledgerDir)]);
  const ledger = raw ? summarizeLedger(raw, args.start, args.end) : null;
  if (args.json) console.log(JSON.stringify({ fetchedAt: new Date().toISOString(), timeZone: args.tz, startingOn: args.start.toISOString(), endingBefore: args.end.toISOString(), freshness: 'Invoice-derived; recent usage may be missing', model, product, ledgerDir, ledger }, null, 2));
  else console.log(formatReport({ args, model, product, ledger, ledgerDir }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error(`usage-report: ${e.message}`); process.exit(1); });
