import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage } from '../scripts/usage-report.mjs';
import { settleLedger, entryParts, formatSettlement, MODEL_MATCHERS } from '../scripts/usage-settle.mjs';

const T = s => Date.parse(s);
const NOW = T('2026-10-31T12:00:00Z');
const range = { start: new Date('2026-10-30T00:00:00Z'), end: new Date('2026-10-31T00:00:00Z') };
// An API-shaped by-model timeseries (hourly), parsed the way the script does.
const usageOf = (buckets, extra = {}) => parseUsage({
  as_of: '2026-10-31T11:00:00Z', granularity: 'hour', group_by: 'model',
  summary: { spend_micros: buckets.reduce((t, b) => t + b.usd * 1e6, 0) },
  breakdown: [...new Set(buckets.map(b => b.key))].map(k => ({ group_key: k, cost_micros: buckets.filter(b => b.key === k).reduce((t, b) => t + b.usd * 1e6, 0), run_count: 1, share: 0 })),
  group_labels: [{ key: 'flux-2-pro', display_name: 'flux-2-pro', provider: 'bfl' }, { key: 'gemini-3.5-flash', display_name: 'Gemini 3.5 Flash', provider: 'google' }],
  buckets: buckets.map(b => ({ group_key: b.key, cost_micros: b.usd * 1e6, period_start: b.start, period_end: new Date(T(b.start) + 3600e3).toISOString() })), ...extra });
const entry = (id, o = {}) => ({ id, source: 'refgen', model: 'Flux.2 [pro] (BFL)', state: 'settled', createdAt: o.at || '2026-10-30T10:05:00Z', endedAt: o.at || '2026-10-30T10:06:00Z', reserveMicros: 30800, expectedMicros: 28000, costMicros: 28000, costStatus: 'estimated', ...o });
const ledgerOf = (...rs) => ({ version: 1, reservations: Object.fromEntries(rs.map(r => [r.id, r])) });

test('a lone entry in its model and hour gets a variance; shared hours get only the window total', () => {
  const usage = usageOf([{ key: 'flux-2-pro', start: '2026-10-30T10:00:00Z', usd: 0.03 }, { key: 'flux-2-pro', start: '2026-10-30T11:00:00Z', usd: 0.2 }]);
  const ledger = ledgerOf(entry('solo', { at: '2026-10-30T10:20:00Z' }), entry('a', { at: '2026-10-30T11:10:00Z' }), entry('b', { at: '2026-10-30T11:40:00Z' }));
  const r = settleLedger({ ledger, usage, ...range, now: NOW });
  const by = id => r.entries.find(e => e.id === id);
  assert.equal(by('solo').match, 'single'); assert.equal(by('solo').varianceUsd, 0.002); assert.match(by('solo').parts[0].note, /nothing else billed/);
  for (const id of ['a', 'b']) { assert.equal(by(id).match, 'aggregate'); assert.equal(by(id).varianceUsd, null, 'no per-entry variance is invented'); assert.equal(by(id).parts[0].windowEntries, 2); }
  const w = r.windows.find(x => x.windowStart.startsWith('2026-10-30T11'));
  assert.deepEqual([w.entries, w.ledgerUsd, w.billedUsd, w.varianceUsd, w.match], [2, 0.056, 0.2, 0.144, 'aggregate']);
  assert.deepEqual(r.byModel.map(m => [m.model, m.ledgerUsd, m.billedUsd, m.varianceUsd]), [['FLUX.2 Pro', 0.084, 0.23, 0.146]]);
  assert.deepEqual(r.counts, { entries: 3, single: 1, aggregate: 2, pending: 0, unbilled: 0, unmapped: 0 });
});

test('no billing yet is pending (not zero) inside 24 h, unbilled after, with the 72 h advice; billing never invented', () => {
  const usage = usageOf([{ key: 'flux-2-pro', start: '2026-10-29T10:00:00Z', usd: 0.01 }]); // some other hour: the entry's own hour has nothing
  const fresh = entry('fresh', { at: '2026-10-31T09:30:00Z' }), day = entry('day', { at: '2026-10-30T09:30:00Z' }), old = entry('old', { at: '2026-10-27T09:30:00Z' });
  const wide = { start: new Date('2026-10-26T00:00:00Z'), end: new Date('2026-11-01T00:00:00Z') };
  const r = settleLedger({ ledger: ledgerOf(fresh, day, old), usage, ...wide, now: NOW });
  const by = id => r.entries.find(e => e.id === id);
  assert.equal(by('fresh').match, 'pending'); assert.match(by('fresh').parts[0].note, /pending, not zero/);
  assert.equal(by('day').match, 'unbilled'); assert.match(by('day').parts[0].note, /recheck/);
  assert.equal(by('old').match, 'unbilled'); assert.match(by('old').parts[0].note, /72 h/);
  for (const id of ['fresh', 'day', 'old']) assert.equal(by(id).varianceUsd, null);
  assert.deepEqual(r.billedWithoutLedger, [{ key: 'flux-2-pro', windowStart: '2026-10-29T10:00:00Z', billedUsd: 0.01 }]);
});

test('a graded still is two parts that bill under different models; an unknown model is reported, not guessed', () => {
  // List 0.028 + guide 0.017 + one grade 0.05, quoted with a grader allowance of 0.05 and settled for the one grade.
  const graded = entry('graded', { components: { listUsd: 0.045, refsUsd: 0, graderUsd: 0.05, expectedUsd: 0.095 }, expectedMicros: 95000, reserveMicros: 104500, costMicros: 95000, at: '2026-10-30T10:20:00Z' });
  assert.deepEqual(entryParts(graded), [{ model: 'Flux.2 [pro] (BFL)', usd: 0.045 }, { model: 'Still grader', usd: 0.05 }]);
  // Graded twice (one verdict unusable but billed): cost = 0.045 + 2 × 0.05.
  assert.deepEqual(entryParts({ ...graded, costMicros: 145000 }), [{ model: 'Flux.2 [pro] (BFL)', usd: 0.045 }, { model: 'Still grader', usd: 0.1 }]);
  // Not graded: the whole cost stays with the image model.
  assert.deepEqual(entryParts({ ...graded, costMicros: 45000 }), [{ model: 'Flux.2 [pro] (BFL)', usd: 0.045 }]);
  const usage = usageOf([{ key: 'flux-2-pro', start: '2026-10-30T10:00:00Z', usd: 0.046 }, { key: 'gemini-3.5-flash', start: '2026-10-30T10:00:00Z', usd: 0.052 }]);
  const mystery = entry('mystery', { model: 'Some New Model', at: '2026-10-30T10:30:00Z' });
  const r = settleLedger({ ledger: ledgerOf(graded, mystery), usage, ...range, now: NOW });
  const g = r.entries.find(e => e.id === 'graded');
  assert.deepEqual(g.parts.map(p => [p.billingModel, p.match, p.varianceUsd]), [['FLUX.2 Pro', 'single', 0.001], ['Still grader', 'single', 0.002]]);
  assert.equal(g.match, 'single'); assert.equal(g.varianceUsd, 0.003);
  assert.equal(r.entries.find(e => e.id === 'mystery').match, 'unmapped'); assert.deepEqual(r.unmappedModels, ['Some New Model']);
});

test('billing groups with no ledger entry are unattributed; entries outside the range and released ones are ignored', () => {
  const usage = usageOf([{ key: 'flux-2-pro', start: '2026-10-30T10:00:00Z', usd: 0.03 }, { key: 'veo-3.1-generate-001', start: '2026-10-30T12:00:00Z', usd: 5 }]);
  const ledger = ledgerOf(entry('in', { at: '2026-10-30T10:20:00Z' }), entry('before', { at: '2026-10-29T10:20:00Z' }), entry('released', { state: 'released', at: '2026-10-30T10:30:00Z' }), entry('held', { state: 'held', at: '2026-10-30T10:40:00Z', costMicros: null }));
  const r = settleLedger({ ledger, usage, ...range, now: NOW });
  assert.deepEqual(r.entries.map(e => e.id).sort(), ['held', 'in']);
  assert.equal(r.entries.find(e => e.id === 'held').ledgerUsd, 0.028, 'a held charge is compared at its expected amount');
  assert.deepEqual(r.unattributed.map(u => [u.key, u.billedUsd]), [['veo-3.1-generate-001', 5]]);
});

test('daily buckets degrade to aggregate-only comparison and the report says so', () => {
  const usage = parseUsage({ as_of: 'x', granularity: 'day', group_by: 'model', summary: { spend_micros: 30000 }, breakdown: [{ group_key: 'flux-2-pro', cost_micros: 30000 }],
    buckets: [{ group_key: 'flux-2-pro', cost_micros: 30000, period_start: '2026-10-30T00:00:00Z', period_end: '2026-10-31T00:00:00Z' }] });
  const r = settleLedger({ ledger: ledgerOf(entry('a', { at: '2026-10-30T10:20:00Z' }), entry('b', { at: '2026-10-30T20:20:00Z' })), usage, ...range, now: NOW });
  assert.equal(r.granularity, 'day'); assert.deepEqual(r.entries.map(e => e.match), ['aggregate', 'aggregate']);
  const text = formatSettlement({ args: { tz: 'UTC', ...range }, usage, result: r });
  assert.match(text, /daily buckets, so every entry shares/); assert.match(text, /no entry is matched to a billed job/);
  assert.match(text, /FLUX\.2 Pro\s+0\.06\s+0\.03\s+-\$0\.026/);
  assert.match(text, /Windows shared by several entries: window total only, no per-entry split \(1\)/);
});

test('every ledger model title used by the app maps to a billing model (or is knowingly absent)', async () => {
  const { imagePresets } = await import('../server/previs/refgen.mjs');
  const { builtInPresets } = await import('../server/previs/presets.mjs');
  const unmapped = [...imagePresets.filter(p => p.backend === 'cloud').map(p => p.title), ...builtInPresets.filter(d => !d.id.startsWith('wan-vace')).map(d => d.title), 'Still grader'].filter(t => !MODEL_MATCHERS.some(m => m.ledger.test(t.toLowerCase().replace(/[^a-z0-9]/g, ''))));
  assert.deepEqual(unmapped, []);
});
