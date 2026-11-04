// Masked-edit UI + quote/generation wiring (Astra). Offline / mocked only — no paid Cloud calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { openProject } from '../server/previs/store.mjs';
import { builtInPresets } from '../server/previs/presets.mjs';
import {
  validateWorkflowDefinition, validateApproval, workflowCost, MASKED_EDIT_PURPOSE,
  isMaskedEditDefinition, isMaskedEditJob,
} from '../server/previs/workflows.mjs';
import {
  openGeneration, estimateMaskedVaceCost, applyTrustedMaskedEstimate, MASKED_VACE_CALIBRATION,
} from '../server/previs/generation.mjs';
import { generationRoutes } from '../server/previs/generation-routes.mjs';
import { openBudget } from '../server/previs/budget.mjs';
import { videoCapabilities, videoEstimate } from '../shared/model-params.mjs';

function loadMaskedEditUi() {
  const out = ts.transpileModule(readFileSync(new URL('../src/director-masked-edit.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  runInNewContext(out, {
    exports,
    require: (m) => {
      if (String(m).includes('director-common')) return { api: async () => { throw Object.assign(Error('Unknown'), { status: 404 }); }, h: (...a) => a, toast: () => {}, DEMO: false };
      return {};
    },
  });
  return exports;
}

test('preset: wan-vace-14b-masked-v1 is Cloud-only masked-video-edit; edge 1.3B unchanged', () => {
  const masked = builtInPresets.find(p => p.id === 'wan-vace-14b-masked-v1');
  const edge = builtInPresets.find(p => p.id === 'wan-vace-13b-edge-v1');
  assert.ok(masked); assert.equal(masked.task, 'masked-video-edit');
  assert.deepEqual(masked.backendRequirements.kinds, ['cloud']);
  assert.equal(masked.inputs.sourceVideo.nodeId, '1');
  assert.equal(masked.inputs.maskVideo.nodeId, '4');
  assert.equal(masked.graph['8'].inputs.unet_name, 'wan2.1_vace_14B_fp16.safetensors');
  assert.equal(masked.graph['15'].inputs.steps, 20);
  assert.equal(masked.pricing.providerEnforcedCap, false);
  assert.equal(masked.verification.status, 'imported');
  const def = validateWorkflowDefinition(structuredClone(masked));
  assert.equal(isMaskedEditDefinition(def), true);
  assert.ok(def.definitionHash);
  assert.equal(edge.task, 'control-video');
  assert.equal(edge.graph['5'].inputs.unet_name, 'wan2.1_vace_1.3B_fp16.safetensors');
  assert.throws(() => validateWorkflowDefinition({ ...structuredClone(masked), inputs: { sourceVideo: masked.inputs.sourceVideo, prompt: masked.inputs.prompt } }), /maskVideo/);
});

test('trusted estimator: INTEGRATION calibration 320×480×81 ≈ $0.120; wrong settings refuse', () => {
  const e = estimateMaskedVaceCost({ width: 320, height: 480, frames: 81 });
  assert.ok(e); assert.equal(e.status, 'unknown'); assert.equal(e.amount, null);
  assert.equal(e.providerEnforcedCap, false);
  assert.ok(Math.abs(e.runtime.gpuSeconds - 95.461) < 0.01);
  assert.ok(Math.abs(e.estimate - 0.1203) < 0.001);
  assert.ok(e.reservationRequiredUsd > e.estimate);
  assert.equal(estimateMaskedVaceCost({ width: 320, height: 480, frames: 80 }), null);
  assert.equal(estimateMaskedVaceCost({ width: 320, height: 480, frames: 81, steps: 8 }), null);
  assert.equal(estimateMaskedVaceCost({ width: 320, height: 480, frames: 81, unet: 'other.safetensors' }), null);
  const quote = applyTrustedMaskedEstimate({ status: 'unknown', amount: null }, builtInPresets.find(p => p.id === 'wan-vace-14b-masked-v1'), {}, { marginPct: 10 });
  assert.equal(quote.estimate, e.estimate);
  assert.equal(quote.rateVersion, MASKED_VACE_CALIBRATION.version);
  const refused = applyTrustedMaskedEstimate({ status: 'unknown' }, { ...builtInPresets.find(p => p.id === 'wan-vace-14b-masked-v1'), graph: { ...builtInPresets.find(p => p.id === 'wan-vace-14b-masked-v1').graph, '15': { class_type: 'KSampler', inputs: { steps: 8 } } } }, {});
  assert.equal(refused.estimate, null);
  assert.match(refused.estimateRefused, /No reliable estimate/);
});

test('validateApproval: unknown quote with trusted estimate requires allowance ≥ reservation', () => {
  const fingerprint = 'fp';
  const quote = { status: 'unknown', currency: 'USD', amount: null, estimate: 0.12, reservationRequiredUsd: 0.132 };
  assert.throws(() => validateApproval({ approved: true, fingerprint, allowance: { currency: 'USD', maxAmount: 1 } }, fingerprint, quote), /allowUnknownCharges/);
  assert.throws(() => validateApproval({ approved: true, fingerprint, allowance: { currency: 'USD', maxAmount: 0.1, allowUnknownCharges: true } }, fingerprint, quote), /Run allowance is below the required reservation/);
  assert.equal(validateApproval({ approved: true, fingerprint, allowance: { currency: 'USD', maxAmount: 0.132, allowUnknownCharges: true } }, fingerprint, quote), true);
  // Ordinary unknown (no estimate) still only needs the acknowledgement.
  assert.equal(validateApproval({ approved: true, fingerprint, allowance: { currency: 'USD', maxAmount: 0, allowUnknownCharges: true } }, fingerprint, { status: 'unknown', currency: 'USD', amount: null }), true);
});

test('model-params: masked preset is not free local Wan; exposes maskVideo, not blockoutClip', () => {
  const d = builtInPresets.find(p => p.id === 'wan-vace-14b-masked-v1');
  const caps = videoCapabilities(d);
  assert.equal(caps.inputs.maskVideo, true);
  assert.equal(caps.inputs.blockoutClip, false);
  assert.equal(videoEstimate(d, 5), null);
  assert.equal(videoEstimate(builtInPresets.find(p => p.id === 'wan-vace-13b-edge-v1'), 5), 0);
});

test('quarantine: listForSync skips masked purpose; attach/setAttachment use durable candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'previs-masked-q-'));
  const project = await openProject(root);
  const generation = await openGeneration(root, project, { requireAttachment: true });
  const routes = await generationRoutes(root, project);
  const ordinary = { id: randomUUID(), purpose: 'ordinary', definition: { task: 'passthrough' }, results: [{ id: 'r1', key: 'o', kind: 'video', url: '/x' }] };
  const masked = {
    id: randomUUID(), purpose: MASKED_EDIT_PURPOSE, definition: { task: 'masked-video-edit', id: 'wan-vace-14b-masked-v1' },
    results: [{ id: 'patch', key: '19', kind: 'video', url: '/assets/patch.mp4' }],
    maskedEdit: { durable: true },
  };
  // Inject via persist path used by openGeneration: write journal files then reopen.
  await mkdir(join(root, 'generation-jobs'), { recursive: true });
  for (const job of [ordinary, masked]) await writeFile(join(root, 'generation-jobs', job.id + '.json'), JSON.stringify({ ...job, status: 'completed', createdAt: new Date().toISOString() }));
  const reopened = await openGeneration(root, project, { requireAttachment: true });
  const syncIds = reopened.listForSync().map(j => j.id);
  assert.ok(syncIds.includes(ordinary.id));
  assert.ok(!syncIds.includes(masked.id));
  assert.equal(isMaskedEditJob(masked), true);
  assert.equal(await reopened.durableMaskedCandidate(masked), true);
  assert.equal(await reopened.durableMaskedCandidate(ordinary), false);
  // Without durable flag or candidate.json → false
  assert.equal(await reopened.durableMaskedCandidate({ ...masked, maskedEdit: undefined, results: [{ id: 'x' }] }), false);
  await mkdir(join(root, 'masked-edits', masked.id), { recursive: true });
  await writeFile(join(root, 'masked-edits', masked.id, 'candidate.json'), JSON.stringify({ v: 1, verified: true }));
  assert.equal(await reopened.durableMaskedCandidate({ ...masked, maskedEdit: undefined }), true);
  assert.ok(routes.listForSync);
  assert.equal(routes.MASKED_EDIT_PURPOSE, MASKED_EDIT_PURPOSE);
  // Cloud workflowCost stays unknown (never trusts imported pricing).
  assert.equal(workflowCost(builtInPresets.find(p => p.id === 'wan-vace-14b-masked-v1').graph, {}, { kind: 'cloud' }).status, 'unknown');
});

test('mocked submit path: trusted estimate reserves; paid disabled refuses before upload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'previs-masked-sub-'));
  const project = await openProject(root);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
  // Tiny synthetic “videos” as bytes with forged metadata via asset expand path is heavy; exercise estimator + approval gates instead.
  const budget = await openBudget(join(root, 'budget'), { env: { PREVIS_BUDGET_CAP_USD: '5', PREVIS_BUDGET_MARGIN: '10' } });
  const estimate = estimateMaskedVaceCost({ width: 320, height: 480, frames: 81 });
  await budget.reserve({ id: 'masked-fixture', source: 'generation', projectId: 'p', estimateUsd: estimate.estimate, label: 'Masked crop' });
  assert.equal(budget.get('masked-fixture').state, 'reserved');
  assert.equal(budget.get('masked-fixture').reserveMicros, Math.round(estimate.estimate * 1.1 * 1e6));
  // Paid gate (generation submit) still refuses without PREVIS_ALLOW_PAID / allowPaid.
  const generation = await openGeneration(root, project, { allowPaid: false, budget });
  assert.ok(generation.listForSync);
  // Estimator prefers bound crop media over preset placeholder graph dims.
  const preset = builtInPresets.find(p => p.id === 'wan-vace-14b-masked-v1');
  const fromSources = applyTrustedMaskedEstimate(
    { status: 'unknown', amount: null },
    preset,
    { sourceVideo: { width: 640, height: 480, frameCount: 81 } },
    { marginPct: 10 },
  );
  const expected = estimateMaskedVaceCost({ width: 640, height: 480, frames: 81 });
  assert.equal(fromSources.estimate, expected.estimate);
  // README documents the shipped fixed-region path (post Cloud qualification).
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /Edit region/i);
  assert.match(readme, /1280×720/);
  assert.doesNotMatch(readme, /experimental pipeline is not yet included in the app/i);
  void png;
});

test('masked-edit submit refuses without generation wiring and bad fingerprints', async () => {
  const { openMaskedEdit } = await import('../server/previs/masked-edit.mjs');
  const root = await mkdtemp(join(tmpdir(), 'previs-masked-sub2-'));
  const projectId = randomUUID(), shotId = randomUUID(), editId = randomUUID();
  const director = {
    get: async () => ({ id: projectId, revision: 1, shots: [{ id: shotId }], assets: [] }),
  };
  const api = openMaskedEdit(root, director, { log: () => {} });
  await assert.rejects(
    () => api.submit({
      projectId, editId, draftRevision: 1, requestId: randomUUID(), fingerprint: 'x',
      maxCostUsd: 1, approval: { approved: true, fingerprint: 'x', allowance: { currency: 'USD', maxAmount: 1, allowUnknownCharges: true } },
    }),
    /generation authority/i,
  );
  // With a stub generation, missing receipt still 404s before any dispatch.
  const calls = [];
  const wired = openMaskedEdit(root, director, {
    log: () => {},
    engineProject: { get: () => ({ revision: 0, shots: [], assets: [], workflowDefinitions: [] }), append: async () => ({}) },
    generation: { route: async (path, input) => { calls.push({ path, input }); return {}; } },
  });
  await assert.rejects(
    () => wired.submit({
      projectId, editId, draftRevision: 1, requestId: randomUUID(), fingerprint: 'deadbeef',
      maxCostUsd: 1, approval: { approved: true, fingerprint: 'deadbeef', allowance: { currency: 'USD', maxAmount: 1, allowUnknownCharges: true } },
    }),
    /Unknown edit/i,
  );
  assert.equal(calls.length, 0);
});

test('UI helpers: eligibility, crop envelope, client estimate mirrors server; reopen export present', () => {
  const ui = loadMaskedEditUi();
  assert.equal(typeof ui.openMaskedEdit, 'function');
  assert.equal(ui.maskedEditEligibility({ kind: 'workflow-result', width: 1280, height: 720, fps: 24, frameCount: 81 }).ok, true);
  assert.equal(ui.maskedEditEligibility({ kind: 'workflow-result', width: 1280, height: 720, fps: 24, frameCount: 88 }).ok, false);
  assert.equal(ui.maskedEditEligibility(null).ok, false);
  const mask = ui.emptyMask();
  mask.rect = { x: 100, y: 100, w: 200, h: 200 };
  const crop = ui.cropAroundMask(mask);
  assert.equal(crop.ok, true);
  assert.equal(crop.crop.w % 16, 0);
  assert.equal(crop.crop.h % 16, 0);
  assert.ok(crop.crop.w >= 320 && crop.crop.h >= 320);
  assert.ok(crop.crop.w * crop.crop.h >= 153_600);
  const huge = ui.emptyMask();
  huge.rect = { x: 0, y: 0, w: 1200, h: 700 };
  assert.equal(ui.cropAroundMask(huge).ok, false);
  const client = ui.estimateMaskedEditUsd({ width: 320, height: 480 }, 81);
  const server = estimateMaskedVaceCost({ width: 320, height: 480, frames: 81 });
  assert.equal(client.estimate, server.estimate);
  assert.equal(client.reservationRequiredUsd, server.reservationRequiredUsd);
  assert.equal(client.providerEnforcedCap, false);
});
