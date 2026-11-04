import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBudget, followJob, quoteEstimate, periodKey, budgetSettings } from '../server/previs/budget.mjs';

const dir = () => mkdtemp(join(tmpdir(), 'previs-budget-'));
// These tests pin exact amounts, so they run with no safety margin; tests/budget-margin.test.mjs covers the margin.
const NO_MARGIN = { PREVIS_BUDGET_MARGIN: '0' };
const open = async (env = {}, extra = {}) => { const d = await dir(); return { d, budget: await openBudget(d, { env: { ...NO_MARGIN, ...env }, ...extra }) }; };
const refused = (promise, pattern) => assert.rejects(promise, e => e.status === 402 && e.apiCode === 'budget' && pattern.test(e.message) && Boolean(e.budget?.account));

test('reserve persists before dispatch, settles to its estimate, and is idempotent per request id', async () => {
  const { d, budget } = await open({ PREVIS_BUDGET_CAP_USD: '5' });
  await budget.reserve({ id: 'a', source: 'refgen', projectId: 'p1', estimateUsd: 1.25, label: 'Hero · FLUX 3' });
  const saved = JSON.parse(await readFile(join(d, 'ledger.json'), 'utf8')).reservations.a;
  assert.equal(saved.state, 'reserved'); assert.equal(saved.reserveMicros, 1250000); assert.equal(saved.costStatus, 'estimated');
  // A resubmit of the same request never counts twice.
  await budget.reserve({ id: 'a', source: 'refgen', projectId: 'p1', estimateUsd: 1.25 });
  assert.equal(budget.status('p1').account.reservedUsd, 1.25);
  await budget.settle('a');
  const st = budget.status('p1');
  assert.equal(st.account.spentUsd, 1.25); assert.equal(st.account.reservedUsd, 0); assert.equal(st.account.remainingUsd, 3.75);
  assert.equal(budget.get('a').state, 'settled');
  // A billed amount replaces the estimate.
  await budget.reserve({ id: 'b', source: 'generation', projectId: 'p1', estimateUsd: 2 });
  await budget.settle('b', { costUsd: 1.5 });
  assert.equal(budget.status('p1').account.spentUsd, 2.75); assert.equal(budget.get('b').costStatus, 'billed');
});

test('release frees the reservation; a released request can be admitted again', async () => {
  const { budget } = await open({ PREVIS_BUDGET_CAP_USD: '1' });
  await budget.reserve({ id: 'a', source: 'refgen', estimateUsd: 0.8 });
  await refused(budget.reserve({ id: 'b', source: 'refgen', estimateUsd: 0.3 }), /Account budget cap reached/);
  await budget.release('a', 'Upload failed before dispatch');
  assert.equal(budget.get('a').state, 'released'); assert.equal(budget.status().account.remainingUsd, 1);
  await budget.reserve({ id: 'b', source: 'refgen', estimateUsd: 0.3 });
  await budget.reserve({ id: 'a', source: 'refgen', estimateUsd: 0.7 }); // re-admitted after its release
  assert.equal(budget.get('a').state, 'reserved'); assert.equal(budget.status().account.remainingUsd, 0);
});

test('stale reservations and holds expire after the TTL', async () => {
  let t = Date.parse('2026-10-30T12:00:00Z');
  const { budget } = await open({ PREVIS_BUDGET_CAP_USD: '1', PREVIS_BUDGET_RESERVATION_TTL_HOURS: '2' }, { now: () => t });
  await budget.reserve({ id: 'a', source: 'generation', estimateUsd: 0.6 });
  await budget.reserve({ id: 'b', source: 'generation', estimateUsd: 0.3 });
  await budget.hold('b', 'Failed after dispatch');
  assert.equal(budget.get('b').state, 'held');
  await refused(budget.reserve({ id: 'c', source: 'refgen', estimateUsd: 0.2 }), /\$0\.10 left/);
  t += 2 * 3600e3 + 1;
  await budget.refresh();
  assert.equal(budget.get('a').state, 'expired'); assert.equal(budget.get('b').state, 'expired');
  await budget.reserve({ id: 'c', source: 'refgen', estimateUsd: 0.2 });
  // A job that completes after its reservation expired still counts as spent.
  await budget.settle('a');
  assert.equal(budget.status().account.spentUsd, 0.6);
});

test('caps: account and per-project, from env and the data-dir config; the error body says what is left', async () => {
  const { d, budget } = await open({ PREVIS_BUDGET_CAP_USD: '10', PREVIS_BUDGET_PROJECT_CAP_USD: '2' });
  await budget.reserve({ id: 'a', source: 'refgen', projectId: 'p1', estimateUsd: 1.5 });
  await refused(budget.reserve({ id: 'b', source: 'refgen', projectId: 'p1', estimateUsd: 1 }), /Project budget cap reached: \$0\.00 spent \+ \$1\.50 reserved \+ \$1\.00 for this request is over the \$2\.00 cap \(\$0\.50 left\)\. Nothing was sent\./);
  assert.equal(budget.get('b'), null, 'nothing reserved on refusal');
  await budget.reserve({ id: 'c', source: 'refgen', projectId: 'p2', estimateUsd: 1.9 }); // another project has its own cap
  // The data-dir config overrides env: raise this project's cap, lower the account cap.
  await budget.setCaps({ projectId: 'p1', projectCapUsd: 5 });
  await budget.reserve({ id: 'b', source: 'refgen', projectId: 'p1', estimateUsd: 1 });
  await budget.setCaps({ accountCapUsd: 4.5 });
  await refused(budget.reserve({ id: 'd', source: 'refgen', projectId: 'p1', estimateUsd: 0.2 }), /Account budget cap reached/);
  const config = JSON.parse(await readFile(join(d, 'config.json'), 'utf8'));
  assert.deepEqual(config, { projectCaps: { p1: 5 }, accountCapUsd: 4.5 });
  const st = budget.status('p1');
  assert.equal(st.project.capUsd, 5); assert.equal(st.account.capUsd, 4.5); assert.equal(st.remainingUsd, 0.1);
  // A second authority on the same directory (another server) sees the same ledger and caps.
  const other = await openBudget(d, { env: { ...NO_MARGIN } });
  await refused(other.reserve({ id: 'e', source: 'generation', estimateUsd: 0.5 }), /Account budget cap reached/);
  await assert.rejects(budget.setCaps({ accountCapUsd: -1 }), /non-negative/);
});

test('concurrent reserves from two servers on one ledger never overshoot the cap', async () => {
  const d = await dir(), env = { ...NO_MARGIN, PREVIS_BUDGET_CAP_USD: '1' };
  const [a, b] = [await openBudget(d, { env }), await openBudget(d, { env })];
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).reserve({ id: `r${i}`, source: 'refgen', estimateUsd: 0.3 })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.apiCode === 'budget'));
  await a.refresh(); assert.equal(a.status().account.reservedUsd, 0.9);
});

test('unknown price is refused unless PREVIS_ALLOW_UNKNOWN_COST=1', async () => {
  const { budget } = await open({});
  await refused(budget.reserve({ id: 'a', source: 'generation', label: 'Shot · Mystery model', estimateUsd: null }), /Mystery model has no price estimate.*PREVIS_ALLOW_UNKNOWN_COST=1/);
  assert.equal(budget.get('a'), null);
  const allowed = (await open({ PREVIS_ALLOW_UNKNOWN_COST: '1' })).budget;
  const { reservation } = await allowed.reserve({ id: 'a', source: 'generation', estimateUsd: null });
  assert.equal(reservation.costStatus, 'unknown'); assert.equal(allowed.status().account.unknownCostHolds, 1);
});

test('alerts fire once at 50, 80 and 95% and at the cap, and are published to listeners', async () => {
  const seen = [];
  const { budget } = await open({ PREVIS_BUDGET_CAP_USD: '10' }, { onChange: e => seen.push(...e.alerts.map(a => a.level)) });
  const r1 = await budget.reserve({ id: 'a', source: 'refgen', estimateUsd: 4 });
  assert.deepEqual(r1.alerts, []);
  const r2 = await budget.reserve({ id: 'b', source: 'refgen', estimateUsd: 1.5 });
  assert.equal(r2.alerts[0].level, 50); assert.match(r2.alerts[0].message, /Account budget 50% used: \$4\.50 of \$10\.00 left/);
  await budget.reserve({ id: 'c', source: 'refgen', estimateUsd: 0.5 }); // 60%: no new alert
  await budget.reserve({ id: 'd', source: 'refgen', estimateUsd: 3.6 }); // 96%: jumps straight to 95
  await budget.reserve({ id: 'e', source: 'refgen', estimateUsd: 0.4 }); // 100%
  assert.deepEqual(seen, [50, 95, 100]);
  assert.equal(budget.status().alert, 100);
  await budget.release('e');
  assert.equal(budget.status().account.alert, 95);
});

test('periods: the account cap counts the current month (or day) only; projects count all time', async () => {
  let t = Date.parse('2026-10-31T20:00:00Z');
  const { budget } = await open({ PREVIS_BUDGET_CAP_USD: '1', PREVIS_BUDGET_PROJECT_CAP_USD: '1.5', PREVIS_BUDGET_TZ: 'UTC' }, { now: () => t });
  await budget.reserve({ id: 'a', source: 'refgen', projectId: 'p', estimateUsd: 0.9 }); await budget.settle('a');
  await refused(budget.reserve({ id: 'b', source: 'refgen', projectId: 'p', estimateUsd: 0.2 }), /Account/);
  t = Date.parse('2026-11-01T01:00:00Z');
  await budget.reserve({ id: 'b', source: 'refgen', projectId: 'p', estimateUsd: 0.2 });
  await refused(budget.reserve({ id: 'c', source: 'refgen', projectId: 'p', estimateUsd: 0.5 }), /Project/);
  assert.equal(periodKey(Date.parse('2026-11-01T01:00:00Z'), 'day', 'America/Los_Angeles'), '2026-10-31');
  assert.equal(periodKey(Date.parse('2026-11-01T01:00:00Z'), 'month', 'UTC'), '2026-11');
  assert.equal(budgetSettings({}).period, 'month');
  assert.equal(budgetSettings({ PREVIS_BUDGET_PERIOD: 'day' }, { period: 'all' }).period, 'all');
});

test('followJob maps receipts: completed settles, not-sent releases, failed-after-dispatch and uncertain hold', async () => {
  const { budget } = await open({});
  for (const id of ['done', 'refused', 'ran', 'lost', 'back']) await budget.reserve({ id, source: 'generation', estimateUsd: 1 });
  await followJob(budget, { id: 'done', status: 'completed' });
  await followJob(budget, { id: 'refused', status: 'failed', failure: { phase: 'dispatch', notSent: true } });
  await followJob(budget, { id: 'ran', status: 'failed', failure: { phase: 'execution' } });
  await followJob(budget, { id: 'lost', status: 'uncertain' });
  await followJob(budget, { id: 'back', status: 'quoted' }); // interrupted upload returned to its quote
  await followJob(budget, { id: 'unknown', status: 'completed' }); // no reservation: nothing happens
  assert.deepEqual(Object.fromEntries(budget.list().map(r => [r.id, r.state])), { done: 'settled', refused: 'released', ran: 'held', lost: 'held', back: 'released' });
  assert.deepEqual(budget.status().account, { scope: 'account', period: 'month', periodKey: budget.status().account.periodKey, capUsd: null, spentUsd: 1, reservedUsd: 2, remainingUsd: null, percent: null, alert: null, unknownCostHolds: 0 });
});

test('quoteEstimate: known amounts, free local work, estimates and unknowns', () => {
  assert.equal(quoteEstimate({ status: 'known', amount: 0 }, { kind: 'local' }), 0);
  assert.equal(quoteEstimate({ status: 'unknown', nodes: [{ apiNode: false }] }, { kind: 'local' }), 0);
  assert.equal(quoteEstimate({ status: 'unknown', nodes: [{ apiNode: true }] }, { kind: 'local' }), null);
  assert.equal(quoteEstimate({ status: 'unknown', estimate: 0.066 }, { kind: 'cloud' }), 0.066);
  assert.equal(quoteEstimate({ status: 'unknown', estimate: null }, { kind: 'cloud' }), null);
});

test('a stale lock file from a crashed writer is broken; a live one times out with nothing sent', async () => {
  const d = await dir();
  const budget = await openBudget(d, { env: { ...NO_MARGIN }, lockTimeoutMs: 200 });
  await writeFile(join(d, 'ledger.lock'), '1');
  await assert.rejects(budget.reserve({ id: 'a', source: 'refgen', estimateUsd: 0.1 }), e => e.status === 503 && /locked/.test(e.message));
  const { utimes } = await import('node:fs/promises');
  const old = new Date(Date.now() - 60000); await utimes(join(d, 'ledger.lock'), old, old);
  await budget.reserve({ id: 'a', source: 'refgen', estimateUsd: 0.1 });
  assert.equal(budget.get('a').state, 'reserved');
});
