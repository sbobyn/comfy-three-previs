import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBudget, budgetSettings } from '../server/previs/budget.mjs';
import { imagePresets } from '../server/previs/refgen.mjs';
import { GRADER_PRICES, REFERENCE_PRICES, DEFAULT_MARGIN_PCT, parseMarginPct, referenceUsd, estimateBreakdown, sumBreakdowns, estimateFor, IMAGE_PRICES } from '../shared/tiers.mjs';

const open = async (env = {}) => openBudget(await mkdtemp(join(tmpdir(), 'previs-margin-')), { env });

test('margin setting: 10% by default, percent with or without %, bad values fall back', () => {
  assert.equal(DEFAULT_MARGIN_PCT, 10);
  assert.equal(budgetSettings({}).marginPct, 10);
  assert.equal(budgetSettings({ PREVIS_BUDGET_MARGIN: '25' }).marginPct, 25);
  assert.equal(budgetSettings({ PREVIS_BUDGET_MARGIN: '5%' }).marginPct, 5);
  assert.equal(budgetSettings({ PREVIS_BUDGET_MARGIN: '0' }).marginPct, 0);
  for (const bad of ['-1', 'abc', '101', '']) assert.equal(parseMarginPct(bad), 10, bad);
});

test('reference prices cover every image preset and agree with its reference limit', () => {
  for (const p of imagePresets) {
    const r = REFERENCE_PRICES[p.id];
    if (p.id in IMAGE_PRICES) { assert.ok(r, `${p.id} has a reference-price assumption`); assert.equal(r.max, p.maxRefs ?? 0, `${p.id} max references`); assert.ok(typeof r.basis === 'string' && r.basis.length > 10, `${p.id} documents its basis`); }
  }
});

test('breakdown itemizes list, references and grader; the margin touches the reserve only', () => {
  // A GPT Image 2.5 key frame: the blockout guide + 3 cast images = 4 inputs, graded once, 10% margin.
  const b = estimateBreakdown('still', 'gpt-image-25', { refs: 4, grades: 1, marginPct: 10 });
  assert.equal(b.listUsd, 0.076);
  assert.equal(b.refsUsd, 0.0704); // 4 × $0.0176
  assert.equal(b.graderUsd, GRADER_PRICES.gemini);
  assert.equal(b.expectedUsd, 0.1964);
  assert.equal(b.marginUsd, 0.0196);
  assert.equal(b.reserveUsd, 0.216);
  assert.equal(b.listUsd, estimateFor('still', 'gpt-image-25'), 'the list price is the displayed price, unchanged by margin, references or grader');
  // No grader, no references, no margin: exactly the list price.
  assert.deepEqual(estimateBreakdown('look', 'flux-3', { marginPct: 0 }), { listUsd: 0.066, refsUsd: 0, graderUsd: 0, expectedUsd: 0.066, marginPct: 0, marginUsd: 0, reserveUsd: 0.066, refs: 0, grades: 0 });
});

test('references: per-model assumptions, free images, unpriced models, videos and unknown models', () => {
  assert.equal(referenceUsd('flux-2-pro', 7), 0.119); // up to ≈ $0.12 for 7, as the saved badge says
  assert.equal(referenceUsd('seedream-5-pro', 1), 0, 'the first Seedream image is free');
  assert.equal(referenceUsd('seedream-5-pro', 3), 0.006);
  assert.equal(referenceUsd('flux-3', 5), 0, 'FLUX 3 has no documented per-reference price; the margin absorbs it');
  assert.equal(REFERENCE_PRICES['flux-3'].known, false);
  assert.equal(referenceUsd('not-a-model', 5), 0);
  assert.equal(estimateBreakdown('video', 'seedance-25-edit-v1', { duration: 5, refs: 4, marginPct: 10 }).refsUsd, 0);
  assert.equal(estimateBreakdown('look', 'not-a-model'), null);
  // Several images per request (design-sheet views) each carry their own reference.
  assert.equal(estimateBreakdown('sheet', 'gpt-image-25', { count: 4, refs: 1, marginPct: 0 }).refsUsd, 0.0704);
});

test('the grader is billed on stills only, and only for models that cost something', () => {
  assert.equal(estimateBreakdown('still', 'flux-2-pro', { grades: 2, marginPct: 0 }).graderUsd, 0.1);
  assert.equal(estimateBreakdown('look', 'flux-2-pro', { grades: 2, marginPct: 0 }).graderUsd, 0);
  assert.equal(estimateBreakdown('still', 'local-checkpoint', { grades: 1, marginPct: 0 }).graderUsd, 0, 'local stills are graded by the free score');
  const total = sumBreakdowns([estimateBreakdown('still', 'flux-2-pro', { refs: 1, grades: 1 }), null, estimateBreakdown('look', 'flux-3')]);
  assert.equal(total.graderUsd, 0.05); assert.equal(total.listUsd, 0.094);
});

test('a reservation is the expected charge plus the margin; settling without a bill counts the expected charge', async () => {
  const budget = await open({ PREVIS_BUDGET_CAP_USD: '10' });
  const { reservation } = await budget.reserve({ id: 'a', source: 'refgen', projectId: 'p', estimateUsd: 0.2, components: { refsUsd: 0.05, graderUsd: 0.05 } });
  assert.equal(reservation.reserveMicros, 220000);
  assert.deepEqual(reservation.components, { listUsd: 0.1, refsUsd: 0.05, graderUsd: 0.05, expectedUsd: 0.2, marginPct: 10, marginUsd: 0.02, reserveUsd: 0.22 });
  assert.equal(budget.status('p').account.reservedUsd, 0.22);
  await budget.settle('a');
  assert.equal(budget.get('a').costMicros, 200000, 'the margin is released at settlement');
  const st = budget.status('p').account;
  assert.equal(st.spentUsd, 0.2); assert.equal(st.reservedUsd, 0);
  // A billed amount still wins.
  await budget.reserve({ id: 'b', source: 'generation', estimateUsd: 1 });
  await budget.settle('b', { costUsd: 0.9 });
  assert.equal(budget.get('b').costMicros, 900000);
  assert.equal(budget.list().find(r => r.id === 'a').expectedUsd, 0.2);
  assert.equal(budget.marginPct(), 10);
});

test('the cap counts the margin, and the refusal says what the request was made of', async () => {
  const budget = await open({ PREVIS_BUDGET_CAP_USD: '1', PREVIS_BUDGET_MARGIN: '10' });
  await budget.reserve({ id: 'a', source: 'refgen', estimateUsd: 0.85 }); // reserves 0.935
  await assert.rejects(budget.reserve({ id: 'b', source: 'refgen', estimateUsd: 0.1, components: { refsUsd: 0.02, graderUsd: 0.05 } }), e => {
    assert.equal(e.status, 402); assert.equal(e.apiCode, 'budget');
    assert.match(e.message, /\$0\.94 reserved \+ \$0\.11 for this request \(list \$0\.03 \+ references \$0\.02 \+ grader \$0\.05 \+ 10% margin \$0\.01\) is over the \$1\.00 cap/);
    assert.deepEqual(e.breakdown, { listUsd: 0.03, refsUsd: 0.02, graderUsd: 0.05, expectedUsd: 0.1, marginPct: 10, marginUsd: 0.01, reserveUsd: 0.11 });
    return true;
  });
  assert.equal(budget.get('b'), null, 'nothing was reserved');
  // At exactly the margin-free amount it would have fit: the margin is what refused it.
  const zero = await open({ PREVIS_BUDGET_CAP_USD: '1', PREVIS_BUDGET_MARGIN: '0' });
  await zero.reserve({ id: 'a', source: 'refgen', estimateUsd: 0.85 });
  await zero.reserve({ id: 'b', source: 'refgen', estimateUsd: 0.15 });
});
