import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseUsage, summarizeLedger, parseArgs, boundary, fetchUsage, formatReport } from '../scripts/usage-report.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/usage-timeseries.json', import.meta.url), 'utf8'));

test('parseUsage: micros to USD, balance cents to USD, labels and per-day totals', () => {
  const m = parseUsage(fixture.model);
  assert.equal(m.billedUsd, 8.0162005);
  assert.deepEqual(m.balance, { currency: 'USD', totalUsd: 123.45678, cloudCreditUsd: 103.45678, prepaidUsd: 20 });
  assert.deepEqual(m.rows.map(r => [r.name, r.provider, r.usd, r.runs]), [['Seedance 2.5 edit', 'ByteDance', 4.815, 3], ['FLUX 3', 'Black Forest Labs', 3.2000005, 40], ['unspecified', null, 0.0012, 1]]);
  assert.deepEqual(m.days, [{ start: '2026-10-29T00:00:00Z', usd: 5.2000005 }, { start: '2026-10-30T00:00:00Z', usd: 2.8162 }]);
  const p = parseUsage(fixture.product);
  assert.equal(p.groupBy, 'product'); assert.equal(p.rows[0].name, 'BytePlus Video Generation'); assert.equal(p.rows[1].runs, null);
  // Only the misnamed *_micros balance fields (the documented contract): still cents.
  const legacy = structuredClone(fixture.model); for (const k of Object.keys(legacy.summary.balance)) if (k.endsWith('_cents')) delete legacy.summary.balance[k];
  assert.equal(parseUsage(legacy).balance.totalUsd, 123.45678);
});

test('parseUsage refuses a schema it does not understand', () => {
  assert.throws(() => parseUsage({}), /Unexpected usage schema/);
  assert.throws(() => parseUsage({ summary: { spend_micros: 1 }, breakdown: [{ group_key: 'x' }] }), /cost_micros/);
  assert.equal(parseUsage({ summary: { spend_micros: 0 }, breakdown: [] }).balance, null);
});

test('summarizeLedger: settled, outstanding, released and expired in range, by source and model', () => {
  const r = (id, state, createdAt, o = {}) => ({ id, state, createdAt, source: 'refgen', model: 'FLUX 3', reserveMicros: 66000, costMicros: state === 'settled' ? 66000 : null, costStatus: 'estimated', ...o });
  const ledger = { version: 1, reservations: Object.fromEntries([
    r('a', 'settled', '2026-10-29T10:00:00Z'), r('b', 'settled', '2026-10-29T11:00:00Z', { costMicros: 50000, costStatus: 'billed' }),
    r('c', 'reserved', '2026-10-29T12:00:00Z', { source: 'generation', model: 'Seedance 2.5 edit', reserveMicros: 1975000 }), r('d', 'held', '2026-10-29T13:00:00Z'),
    r('e', 'released', '2026-10-29T14:00:00Z'), r('f', 'expired', '2026-10-29T15:00:00Z'), r('old', 'settled', '2026-10-27T15:00:00Z'),
  ].map(x => [x.id, x])) };
  const s = summarizeLedger(ledger, new Date('2026-10-29T07:00:00Z'), new Date('2026-10-30T07:00:00Z'));
  assert.equal(s.reservations, 6);
  assert.deepEqual(s.settled, { count: 2, usd: 0.116, billed: 1 });
  assert.equal(s.outstandingUsd, 2.041); assert.equal(s.reserved.count, 1); assert.equal(s.held.count, 1);
  assert.equal(s.released, 1); assert.equal(s.expired, 1);
  assert.deepEqual(s.byModel.map(m => [m.name, m.settledUsd, m.reservedUsd, m.count]), [['generation · Seedance 2.5 edit', 0, 1.975, 1], ['refgen · FLUX 3', 0.116, 0.066, 3]]);
});

test('date range: local midnights with DST-aware offsets, exclusive end, yesterday by default', () => {
  assert.equal(boundary('2026-10-29', 'America/Los_Angeles').toISOString(), '2026-10-29T07:00:00.000Z');
  assert.equal(boundary('2026-11-02', 'America/Los_Angeles').toISOString(), '2026-11-02T08:00:00.000Z'); // after DST ends
  assert.equal(boundary('2026-10-29T00:00:00-07:00', 'UTC').toISOString(), '2026-10-29T07:00:00.000Z');
  assert.throws(() => boundary('2026-10-29T00:00:00', 'UTC'), /offset/);
  const now = Date.parse('2026-10-30T15:00:00Z'), tz = 'America/Los_Angeles';
  const y = parseArgs([], { now, timeZone: tz });
  assert.equal(y.start.toISOString(), '2026-10-29T07:00:00.000Z'); assert.equal(y.end.toISOString(), '2026-10-30T07:00:00.000Z');
  const one = parseArgs(['--', '--from', '2026-11-01', '--json'], { now, timeZone: tz });
  assert.equal(one.end.toISOString(), '2026-11-02T08:00:00.000Z'); assert.equal(one.json, true); // a 25-hour day
  assert.throws(() => parseArgs(['--from', '2026-10-30', '--to', '2026-10-29'], { now, timeZone: tz }), /before/);
  assert.throws(() => parseArgs(['--tz', 'Mars/Base'], { now }), /time zone/);
});

test('fetchUsage sends the key only as X-API-Key to cloud.comfy.org and never echoes an error body', async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(fixture.model), { status: 200 }); };
  const start = new Date('2026-10-29T07:00:00Z'), end = new Date('2026-10-30T07:00:00Z');
  await fetchUsage({ start, end, groupBy: 'model', key: 'SIMULATED-KEY', fetcher });
  assert.equal(calls[0].url, 'https://cloud.comfy.org/api/billing/usage/timeseries?group_by=model&granularity=day&starting_on=2026-10-29T07%3A00%3A00.000Z&ending_before=2026-10-30T07%3A00%3A00.000Z');
  assert.equal(calls[0].init.headers['X-API-Key'], 'SIMULATED-KEY'); assert.equal(calls[0].init.redirect, 'error');
  // Hourly buckets (used by usage:settle) are a parameter; the default stays daily.
  await fetchUsage({ start, end, groupBy: 'model', granularity: 'hour', key: 'SIMULATED-KEY', fetcher });
  assert.match(calls[1].url, /granularity=hour/);
  const parsed = parseUsage(fixture.model);
  assert.deepEqual(parsed.buckets[0], { key: 'seedance-2-5-edit', start: '2026-10-29T00:00:00Z', end: '2026-10-30T00:00:00Z', usd: 2 }); assert.equal(parsed.granularity, 'day');
  const failing = async () => new Response('{"error":"key SIMULATED-KEY is invalid"}', { status: 401 });
  await assert.rejects(fetchUsage({ start, end, groupBy: 'model', key: 'SIMULATED-KEY', fetcher: failing }), e => /HTTP 401/.test(e.message) && !e.message.includes('SIMULATED'));
});

test('formatReport: billed totals, both views, and the ledger join', () => {
  const args = { tz: 'America/Los_Angeles', start: new Date('2026-10-29T07:00:00Z'), end: new Date('2026-10-31T07:00:00Z') };
  const ledger = summarizeLedger({ reservations: { a: { id: 'a', state: 'settled', createdAt: '2026-10-29T10:00:00Z', source: 'refgen', model: 'FLUX 3', reserveMicros: 66000, costMicros: 66000 } } }, args.start, args.end);
  const text = formatReport({ args, model: parseUsage(fixture.model), product: parseUsage(fixture.product), ledger, ledgerDir: '/data/budget' });
  assert.match(text, /usage 2026-10-29 → 2026-10-30 \(America\/Los_Angeles/);
  assert.match(text, /Billed: \$8\.02 {4}Balance: \$123\.46 USD \(cloud credit \$103\.46, prepaid \$20\.00\)/);
  assert.match(text, /Seedance 2\.5 edit \(ByteDance\)\s+4\.82\s+60\.0%\s+3/);
  assert.match(text, /\(1 more under half a cent\)/);
  assert.match(text, /By product \(the same spend in another view; never add the two\)/);
  assert.match(text, /Settled \$0\.07 \(1\)/); assert.match(text, /Billed minus settled locally: \$7\.95/);
  assert.match(formatReport({ args, model: parseUsage(fixture.model), product: parseUsage(fixture.product), ledger: null, ledgerDir: '/x' }), /No ledger found/);
});
