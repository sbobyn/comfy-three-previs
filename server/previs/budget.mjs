// Budget authority for paid Comfy Cloud work. Every paid dispatch path (video generation, refgen looks/sheets/stills,
// the paid still grader, and through them batches and the MCP tools) reserves its estimated cost here, durably, before
// anything is sent; the reservation is settled when the job completes, released when it provably never ran, and kept
// as a hold when it ran but failed or its outcome is unknown (a charge may still arrive). Holds and stale reservations
// expire after PREVIS_BUDGET_RESERVATION_TTL_HOURS. Admission is one transaction under a file lock in the ledger
// directory, so separate servers that share PREVIS_BUDGET_DIR (or one PREVIS_DATA_DIR) share one budget.
//
// Amounts are estimates from list prices: Comfy Cloud returns no binding per-job price, and the provider has no
// spending cap of its own. A reservation is the expected charge (list price + reference images + the paid grader) plus a
// safety margin (PREVIS_BUDGET_MARGIN percent, default 10); settling without a billed amount counts the expected charge,
// not the margin. scripts/usage-report.mjs reads the billed account totals; scripts/usage-settle.mjs matches them to this ledger.
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson } from './atomic.mjs';
import { parseMarginPct, GRADER_PRICES } from '../../shared/tiers.mjs';

/** Ledger directory: PREVIS_BUDGET_DIR (share it between servers for one account budget), else <data dir>/budget. */
export const budgetDir = (dataDir, env = process.env) => env.PREVIS_BUDGET_DIR || join(dataDir, 'budget');
export const ALERT_LEVELS = [50, 80, 95];
const HELD = new Set(['reserved', 'held']); // counted at reserveUsd until settled, released or expired
const micros = usd => Math.round(Number(usd) * 1e6);
const usd = m => Math.round(m) / 1e6;
const money = x => `$${Number(x).toFixed(2)}`;
const capOf = value => { if (value === undefined || value === null || value === '') return null; const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null; };
const fail = (message, status = 400) => { const e = Error(message); e.status = status; throw e; };

/** The budget fields of an HTTP error body: the status object and the itemized request that was refused. Empty for other errors. */
export const refusalFields = e => ({ ...(e?.budget ? { budget: e.budget } : {}), ...(e?.breakdown ? { breakdown: e.breakdown } : {}) });

/** Itemize a reservation: refs and grader as the caller knew them, the rest of the expected charge is list; plus the margin. */
function itemize(expectedUsd, components, marginUsd, marginPct) {
  const r4 = x => Math.round(x * 10000) / 10000;
  const refsUsd = Math.max(0, Number(components?.refsUsd) || 0), graderUsd = Math.max(0, Number(components?.graderUsd) || 0);
  const listUsd = r4(Math.max(0, expectedUsd - refsUsd - graderUsd));
  return { listUsd, refsUsd: r4(refsUsd), graderUsd: r4(graderUsd), expectedUsd: r4(expectedUsd), marginPct, marginUsd: r4(marginUsd), reserveUsd: r4(expectedUsd + marginUsd) };
}
/** " (list $0.03 + references $0.02 + grader $0.05 + 10% margin $0.01)" for a message; empty when the request is just its list price. */
const describe = p => (p.refsUsd || p.graderUsd || p.marginUsd ? ` (list ${money(p.listUsd)}${p.refsUsd ? ` + references ${money(p.refsUsd)}` : ''}${p.graderUsd ? ` + grader ${money(p.graderUsd)}` : ''}${p.marginUsd ? ` + ${p.marginPct}% margin ${money(p.marginUsd)}` : ''})` : '');

/** USD estimate for a quote: a known amount, $0 for local work without partner API nodes, the quote's estimate, else null. */
export function quoteEstimate(quote, backend) {
  if (quote?.status === 'known' && Number.isFinite(quote.amount)) return quote.amount;
  if (backend?.kind === 'local' && !(quote?.nodes || []).some(n => n.apiNode)) return 0;
  return Number.isFinite(quote?.estimate) ? quote.estimate : null;
}

/** Settings from env; the data-dir config (written by setCaps) overrides the caps. */
export function budgetSettings(env = process.env, config = {}) {
  const ttl = Number(env.PREVIS_BUDGET_RESERVATION_TTL_HOURS);
  const period = ['all', 'day', 'month'].includes(config.period) ? config.period : ['all', 'day', 'month'].includes(env.PREVIS_BUDGET_PERIOD) ? env.PREVIS_BUDGET_PERIOD : 'month';
  return {
    accountCapUsd: 'accountCapUsd' in config ? capOf(config.accountCapUsd) : capOf(env.PREVIS_BUDGET_CAP_USD),
    projectCapUsd: 'projectCapUsd' in config ? capOf(config.projectCapUsd) : capOf(env.PREVIS_BUDGET_PROJECT_CAP_USD),
    projectCaps: config.projectCaps && typeof config.projectCaps === 'object' ? config.projectCaps : {},
    period, timeZone: env.PREVIS_BUDGET_TZ || undefined,
    allowUnknown: env.PREVIS_ALLOW_UNKNOWN_COST === '1',
    marginPct: parseMarginPct(env.PREVIS_BUDGET_MARGIN),
    ttlMs: (Number.isFinite(ttl) && ttl > 0 ? ttl : 24) * 3600e3,
  };
}

/** Calendar key of an instant in the budget's time zone ('all' → one key). */
export function periodKey(at, period, timeZone) {
  if (period === 'all') return 'all';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at)).map(p => [p.type, p.value]));
  return period === 'day' ? `${parts.year}-${parts.month}-${parts.day}` : `${parts.year}-${parts.month}`;
}

/** Exposure of one reservation in micros: its reserve while held, its cost once settled, nothing once released/expired. */
const exposure = r => HELD.has(r.state) ? r.reserveMicros : r.state === 'settled' ? r.costMicros : 0;

export async function openBudget(dir, { env = process.env, now = Date.now, onChange = () => {}, lockTimeoutMs = 10000 } = {}) {
  await mkdir(dir, { recursive: true });
  const ledgerFile = join(dir, 'ledger.json'), configFile = join(dir, 'config.json'), lockFile = join(dir, 'ledger.lock');
  let ledger = { version: 1, reservations: {}, alerts: {} }, config = {};
  const listeners = new Set([onChange]);
  const readJson = async (file, fallback) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
  async function load() {
    const saved = await readJson(ledgerFile, null);
    ledger = saved && saved.version === 1 ? { reservations: {}, alerts: {}, ...saved } : { version: 1, reservations: {}, alerts: {} };
    config = await readJson(configFile, {}) || {};
  }
  // Process-safe: an exclusive lock file (stale after 30 s, e.g. a crashed writer) around every read-modify-write,
  // and an in-process chain so this server never contends with itself.
  let chain = Promise.resolve();
  async function withLock(fn) {
    const run = chain.then(async () => {
      const deadline = Date.now() + lockTimeoutMs;
      let handle;
      for (;;) {
        try { handle = await open(lockFile, 'wx', 0o600); break; } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          const age = await stat(lockFile).then(s => Date.now() - s.mtimeMs, () => 0);
          if (age > 30000) { await unlink(lockFile).catch(() => {}); continue; }
          if (Date.now() > deadline) fail('Budget ledger is locked by another process; nothing was sent', 503);
          await new Promise(r => setTimeout(r, 25 + Math.random() * 50));
        }
      }
      try { await handle.writeFile(String(process.pid)); await load(); return await fn(); }
      finally { await handle.close(); await unlink(lockFile).catch(() => {}); }
    });
    chain = run.catch(() => {});
    return run;
  }
  const save = () => atomicJson(ledgerFile, ledger);
  const settings = () => budgetSettings(env, config);
  const projectCap = (s, projectId) => projectId && projectId in s.projectCaps ? capOf(s.projectCaps[projectId]) : s.projectCapUsd;

  // Releases reservations past their expiry. Returns true when anything changed.
  function expire() {
    let changed = false;
    for (const r of Object.values(ledger.reservations)) if (HELD.has(r.state) && Date.parse(r.expiresAt) <= now()) {
      Object.assign(r, { state: 'expired', endedAt: new Date(now()).toISOString(), note: r.state === 'held' ? 'Hold expired without a confirmed charge' : 'Expired: no completion was recorded in time' });
      changed = true;
    }
    return changed;
  }

  function scopeTotals(filter) {
    let spent = 0, held = 0, unknown = 0;
    for (const r of Object.values(ledger.reservations)) {
      if (!filter(r)) continue;
      if (r.state === 'settled') spent += r.costMicros;
      else if (HELD.has(r.state)) { held += r.reserveMicros; if (r.costStatus === 'unknown') unknown++; }
    }
    return { spent, held, unknown };
  }
  function scopeStatus(capUsd, totals, extra) {
    const used = totals.spent + totals.held, cap = capUsd === null ? null : micros(capUsd);
    const percent = cap === null ? null : cap === 0 ? (used > 0 ? 100 : 0) : Math.round(used / cap * 1000) / 10;
    const level = percent === null ? null : percent >= 100 ? 100 : [...ALERT_LEVELS].reverse().find(l => percent >= l) ?? null;
    return { ...extra, capUsd, spentUsd: usd(totals.spent), reservedUsd: usd(totals.held), remainingUsd: cap === null ? null : usd(Math.max(0, cap - used)), percent, alert: level, unknownCostHolds: totals.unknown };
  }
  /** Account and (optional) project status from the last loaded ledger. Synchronous: safe inside C1 snapshots. */
  function status(projectId) {
    const s = settings(), key = periodKey(now(), s.period, s.timeZone);
    const account = scopeStatus(s.accountCapUsd, scopeTotals(r => periodKey(r.createdAt, s.period, s.timeZone) === key), { scope: 'account', period: s.period, periodKey: key });
    const project = projectId ? scopeStatus(projectCap(s, projectId), scopeTotals(r => r.projectId === projectId), { scope: 'project', projectId }) : null;
    // The tighter of the two is what the next dispatch runs into.
    const binding = [account, project].filter(x => x && x.capUsd !== null).sort((a, b) => a.remainingUsd - b.remainingUsd)[0] || null;
    return { account, project, remainingUsd: binding ? binding.remainingUsd : null, alert: Math.max(account.alert ?? 0, project?.alert ?? 0) || null, allowUnknownCost: s.allowUnknown };
  }
  function notify(projectId, alerts = []) { for (const fn of listeners) { try { fn({ projectId: projectId || null, alerts }); } catch {} } }
  // Alerts fire once per scope and level as spend rises (and re-arm when it falls below a level).
  function checkAlerts(projectId) {
    const st = status(projectId), fired = [];
    for (const scope of [st.account, st.project].filter(Boolean)) {
      const key = scope.scope === 'account' ? `account:${scope.periodKey}` : `project:${scope.projectId}`;
      const level = scope.alert ?? 0, last = ledger.alerts[key] ?? 0;
      if (level !== last) ledger.alerts[key] = level;
      if (level > last) fired.push({ scope: scope.scope, level, capUsd: scope.capUsd, remainingUsd: scope.remainingUsd, message: level >= 100 ? `${scope.scope === 'account' ? 'Account' : 'Project'} budget is used up (${money(scope.capUsd)}). New paid work is refused.` : `${scope.scope === 'account' ? 'Account' : 'Project'} budget ${level}% used: ${money(scope.remainingUsd)} of ${money(scope.capUsd)} left.` });
    }
    return fired;
  }

  /**
   * Reserve before dispatch. Idempotent per id: a live or settled reservation is returned as is (a resubmit of the same
   * request never counts twice); a released or expired one is re-admitted. Throws 402 { apiCode: 'budget' } when a cap
   * would be exceeded, or the price is unknown and PREVIS_ALLOW_UNKNOWN_COST is not 1. Nothing is reserved then.
   * estimateUsd is the expected charge; `components` ({ listUsd, refsUsd, graderUsd }) itemizes it and is kept on the
   * reservation. The reserve is the expected charge plus the safety margin.
   */
  async function reserve({ id, source, projectId = null, kind = null, model = null, label = null, estimateUsd, components = null }) {
    if (typeof id !== 'string' || !id) fail('A reservation id is required');
    const result = await withLock(async () => {
      expire();
      const s = settings(), existing = ledger.reservations[id];
      if (existing && (HELD.has(existing.state) || existing.state === 'settled')) return { reservation: structuredClone(existing), alerts: [] };
      const known = Number.isFinite(estimateUsd) && estimateUsd >= 0;
      if (!known && !s.allowUnknown) {
        throw Object.assign(Error(`${label || model || 'This request'} has no price estimate, so the budget cannot admit it; nothing was sent. Choose a priced model, or set PREVIS_ALLOW_UNKNOWN_COST=1 on the server to allow unknown-cost runs.`), { status: 402, apiCode: 'budget', budget: status(projectId) });
      }
      const expected = known ? micros(estimateUsd) : 0, need = Math.round(expected * (1 + s.marginPct / 100)), at = now(), key = periodKey(at, s.period, s.timeZone);
      const parts = known ? itemize(estimateUsd, components, usd(need) - estimateUsd, s.marginPct) : null;
      const checks = [
        { name: 'Account', cap: s.accountCapUsd, totals: scopeTotals(r => r.id !== id && periodKey(r.createdAt, s.period, s.timeZone) === key) },
        ...(projectId ? [{ name: 'Project', cap: projectCap(s, projectId), totals: scopeTotals(r => r.id !== id && r.projectId === projectId) }] : []),
      ];
      for (const c of checks) {
        if (c.cap === null) continue;
        const used = c.totals.spent + c.totals.held, left = Math.max(0, micros(c.cap) - used);
        if (used + need > micros(c.cap)) {
          const why = `${c.name} budget cap reached: ${money(usd(c.totals.spent))} spent + ${money(usd(c.totals.held))} reserved + ${money(usd(need))} for this request${parts ? describe(parts) : ''} is over the ${money(c.cap)} cap (${money(usd(left))} left). Nothing was sent.`;
          throw Object.assign(Error(why), { status: 402, apiCode: 'budget', budget: status(projectId), ...(parts ? { breakdown: parts } : {}) });
        }
      }
      const reservation = { id, source, projectId, kind, model, label: label ? String(label).slice(0, 160) : null, state: 'reserved',
        estimateUsd: known ? estimateUsd : null, ...(parts ? { components: parts } : {}), marginPct: s.marginPct, expectedMicros: expected, reserveMicros: need, costMicros: null, costStatus: known ? 'estimated' : 'unknown',
        createdAt: new Date(at).toISOString(), expiresAt: new Date(at + s.ttlMs).toISOString(), endedAt: null, note: null };
      ledger.reservations[id] = reservation;
      const alerts = checkAlerts(projectId);
      await save();
      return { reservation: structuredClone(reservation), alerts };
    });
    notify(projectId, result.alerts);
    return result;
  }

  async function transition(id, apply) {
    const result = await withLock(async () => {
      const changedByExpiry = expire(), r = ledger.reservations[id];
      if (!r) { if (changedByExpiry) await save(); return null; }
      const before = JSON.stringify(r);
      apply(r);
      if (JSON.stringify(r) === before && !changedByExpiry) return { reservation: structuredClone(r), alerts: [] };
      const alerts = checkAlerts(r.projectId);
      await save();
      return { reservation: structuredClone(r), alerts };
    });
    if (result) notify(result.reservation.projectId, result.alerts);
    return result;
  }
  const iso = () => new Date(now()).toISOString();
  /** The job ran: replace the reservation with its cost (billed when known, else the expected charge without the margin). */
  const settle = (id, { costUsd = null, costStatus = null, note = null } = {}) => transition(id, r => {
    if (r.state === 'settled') return;
    const billed = Number.isFinite(costUsd) && costUsd >= 0;
    Object.assign(r, { state: 'settled', costMicros: billed ? micros(costUsd) : r.expectedMicros ?? r.reserveMicros, costStatus: costStatus || (billed ? 'billed' : r.costStatus), endedAt: iso(), note });
  });
  /** Provably nothing was sent (or an operator reconciled it): the reservation stops counting. */
  const release = (id, note = 'Released') => transition(id, r => { if (HELD.has(r.state)) Object.assign(r, { state: 'released', endedAt: iso(), note }); });
  /** Sent, then failed or lost: a charge may still arrive, so keep counting it until it expires or is released. */
  const hold = (id, note) => transition(id, r => { if (r.state === 'reserved') Object.assign(r, { state: 'held', note }); });

  async function setCaps(input = {}) {
    await withLock(async () => {
      const next = { ...config };
      if ('accountCapUsd' in input) next.accountCapUsd = input.accountCapUsd === null ? null : capOf(input.accountCapUsd) ?? fail('accountCapUsd must be a non-negative number or null');
      if ('projectCapUsd' in input && !input.projectId) next.projectCapUsd = input.projectCapUsd === null ? null : capOf(input.projectCapUsd) ?? fail('projectCapUsd must be a non-negative number or null');
      if (input.projectId) {
        if (!/^[\w-]{1,128}$/.test(input.projectId)) fail('Unknown project');
        const caps = { ...(next.projectCaps || {}) };
        if (input.projectCapUsd === null) delete caps[input.projectId];
        else caps[input.projectId] = capOf(input.projectCapUsd) ?? fail('projectCapUsd must be a non-negative number or null');
        next.projectCaps = caps;
      }
      if ('period' in input) next.period = ['all', 'day', 'month'].includes(input.period) ? input.period : fail('period must be all, day or month');
      config = next;
      await atomicJson(configFile, config);
    });
    notify(input.projectId);
    return status(input.projectId);
  }

  await load();
  return {
    reserve, settle, release, hold, setCaps, status,
    /** Safety margin (percent) a new reservation adds to the expected charge. */
    marginPct: () => settings().marginPct,
    /** Reload the ledger (another process may have written it) and expire stale reservations. */
    refresh: () => withLock(async () => { if (expire()) await save(); }),
    list: () => Object.values(ledger.reservations).map(r => ({ ...structuredClone(r), reserveUsd: usd(r.reserveMicros), expectedUsd: r.expectedMicros == null ? usd(r.reserveMicros) : usd(r.expectedMicros), costUsd: r.costMicros === null ? null : usd(r.costMicros) })),
    get: id => { const r = ledger.reservations[id]; return r ? structuredClone(r) : null; },
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    dir,
  };
}

/** A budget that admits everything (tests and tools that opt out explicitly). */
export const noBudget = () => {
  const ok = async () => null;
  return { reserve: async () => ({ reservation: null, alerts: [] }), settle: ok, release: ok, hold: ok, setCaps: async () => null, refresh: ok, status: () => null, marginPct: () => 0, list: () => [], get: () => null, subscribe: () => () => {} };
};

/** What a finished job cost, when its receipt says more than the reservation does: { costUsd?, costStatus?, note? } or {}. */
export function settlementOf(job) {
  const q = job?.quote?.breakdown;
  if (!q) return {}; // generation receipts and older refgen receipts settle at the reservation's expected charge
  // Paid grades the job actually requested (its quote allowed for them); each one is billed whether or not the verdict was usable.
  const grades = Math.min(Number(job.graderCalls) || 0, Number(q.grades) || 0);
  return { costUsd: Math.round((q.listUsd + q.refsUsd + grades * GRADER_PRICES.gemini) * 10000) / 10000, costStatus: 'estimated' };
}

// Job receipt → ledger. Generation and refgen share these status names closely enough for one mapping.
const RAN = new Set(['completed', 'orphaned', 'recovery-required', 'attaching']);
const DRAFT = new Set(['prepared', 'quoted', 'invalidated']);
/** Apply a persisted job's state to its reservation. Never throws (a ledger problem must not fail the job's receipt). */
export async function followJob(budget, job, log = () => {}) {
  const state = budget?.get(job?.id)?.state;
  if (!state) return;
  // Only real transitions take the ledger lock (a tracked uncertain job is persisted on every check).
  const live = HELD.has(state);
  try {
    if (RAN.has(job.status)) { if (state !== 'settled') await budget.settle(job.id, settlementOf(job)); }
    else if (DRAFT.has(job.status)) { if (live) await budget.release(job.id, 'Back to its quote; nothing was sent'); }
    // Refused by the provider but still billed (moderation on some models): the charge is known, so settle it; do not hold or release.
    else if (job.status === 'failed' && Number.isFinite(job.failure?.billedUsd)) { if (state !== 'settled') await budget.settle(job.id, { costUsd: job.failure.billedUsd, costStatus: 'billed-on-refusal', note: job.failure.billedNote || 'Refused, but the provider still bills it' }); }
    else if (job.status === 'failed') {
      if (job.failure?.phase === 'preparation' || job.failure?.notSent) { if (live) await budget.release(job.id, 'Refused before it ran; nothing was charged'); }
      else if (state === 'reserved') await budget.hold(job.id, `Failed after dispatch (${job.failure?.phase || 'execution'}); a charge may still arrive`);
    } else if (['uncertain', 'closed'].includes(job.status) && state === 'reserved') await budget.hold(job.id, 'Dispatch outcome unknown; a charge may still arrive');
  } catch (e) { log(`budget: ${job.id}: ${e.message}`); }
}
