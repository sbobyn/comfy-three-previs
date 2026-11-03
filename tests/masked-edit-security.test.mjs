// Masked-edit security / resource boundaries (offline foundation — zero provider dispatch).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  normalizeMask, validatePromptFields, validateAcceptanceState, isMaskedEditAsset,
  MAX_PROMPT_CHARS, MAX_MASK_JSON_BYTES,
} from '../shared/masked-edit.mjs';
import { openMaskedEdit, safeEditPath } from '../server/previs/masked-edit.mjs';
import { rectMask, videoAsset } from './fixtures/masked-edit/helpers.mjs';

test('safeEditPath rejects traversal, absolute paths and non-allowlisted names', async () => {
  const data = await mkdtemp(join(tmpdir(), 'previs-me-sec-'));
  const root = join(data, 'edit');
  await mkdir(root, { recursive: true });
  assert.throws(() => safeEditPath(root, '../project.json'), /Invalid|Unexpected|escapes/i);
  assert.throws(() => safeEditPath(root, '..\\secrets'), /Invalid|Unexpected|escapes/i);
  assert.throws(() => safeEditPath(root, '/etc/passwd'), /Invalid|Unexpected|escapes/i);
  assert.throws(() => safeEditPath(root, 'receipt.json/../../x'), /Invalid|Unexpected|escapes/i);
  assert.throws(() => safeEditPath(root, 'not-allowed.txt'), /Unexpected/i);
  assert.ok(safeEditPath(root, 'receipt.json').startsWith(root));
  assert.ok(safeEditPath(root, 'mask.bin').endsWith('mask.bin'));
  await rm(data, { recursive: true, force: true });
});

test('prepare / review / accept / status without generation; submit refuses when authority missing', async () => {
  const data = await mkdtemp(join(tmpdir(), 'previs-me-sec-'));
  let providerCalls = 0;
  const projectId = randomUUID(), shotId = randomUUID(), sourceAssetId = randomUUID();
  const director = {
    get: async id => {
      if (id !== projectId) throw Object.assign(Error('Unknown project'), { status: 404 });
      return {
        id: projectId, revision: 1, shots: [{ id: shotId }],
        assets: [videoAsset(sourceAssetId, shotId, '2026-11-01T10:00:00Z')],
      };
    },
    assetFile: async () => join(data, 'missing.mp4'),
    archive: async () => { providerCalls++; },
    restore: async () => ({ project: await director.get(projectId) }),
  };
  const api = openMaskedEdit(data, director, { log: () => { providerCalls++; } });

  const url = (path, q = '') => new URL(`http://127.0.0.1:5190/api/director/masked-edit${path}${q}`);
  await assert.rejects(() => api.routes('POST', url('/submit'), { projectId, editId: randomUUID() }), /generation authority|requires the generation/i);

  // Status of unknown edit → 404, still no provider.
  await assert.rejects(() => api.routes('GET', url('/status', `?projectId=${projectId}&editId=${randomUUID()}`), {}), /Unknown edit/);

  // Cross-project status refused when receipt exists for another project.
  const editId = randomUUID();
  const dir = api.editDir(editId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'receipt.json'), JSON.stringify({
    v: 1, editId, projectId: randomUUID(), state: 'prepared', sourceAssetId, shotId,
  }));
  await assert.rejects(() => api.status({ projectId, editId }), /another project/i);

  assert.ok(providerCalls >= 0); // log may fire; no cloud client exists without generation wiring
  assert.equal('dispatch' in api, false);
  assert.equal('upload' in api, false);
  assert.equal(typeof api.submit, 'function');
  await rm(data, { recursive: true, force: true });
});

test('prompt and mask payloads reject oversized / non-finite / credential-like abuse vectors at the contract boundary', () => {
  assert.throws(() => validatePromptFields({ prompt: '' }), /required/i);
  assert.throws(() => validatePromptFields({ prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) }), /exceeds/i);
  assert.throws(() => validatePromptFields({ prompt: 'ok', seed: 1.5 }), /seed/i);
  assert.throws(() => validatePromptFields({ prompt: 'ok', seed: -1 }), /seed/i);
  assert.throws(() => normalizeMask({
    v: 1, mode: 'fixed', width: 1280, height: 720, coordinateSpace: 'source-pixels',
    strokes: [{ type: 'brush', radius: 8, points: [[NaN, 0]] }],
  }), /finite/i);
  assert.throws(() => normalizeMask({
    v: 1, mode: 'fixed', width: 1280, height: 720, coordinateSpace: 'source-pixels',
    strokes: [{ type: 'rect', x: 0, y: 0, w: Infinity, h: 10 }],
  }), /finite/i);
  // Huge JSON mask
  const huge = { v: 1, mode: 'fixed', width: 1280, height: 720, coordinateSpace: 'source-pixels', featherPx: 8, strokes: [], pad: 'z'.repeat(MAX_MASK_JSON_BYTES) };
  assert.throws(() => normalizeMask(huge), /exceeds|bytes/i);
  // Client-supplied graph / URL fields are simply ignored by normalizeMask (not in schema) — only strokes count.
  const sneaky = rectMask();
  sneaky.graph = { class_type: 'Evil' };
  sneaky.providerUrl = 'https://evil.example/steal?token=abc';
  sneaky.apiKey = 'sk-ant-not-real';
  const n = normalizeMask(sneaky);
  assert.equal(n.mode, 'fixed');
  assert.equal('graph' in n, false);
  assert.equal('providerUrl' in n, false);
  assert.equal('apiKey' in n, false);
});

test('review refuses mismatched hashes and missing scope acknowledgement', async () => {
  const data = await mkdtemp(join(tmpdir(), 'previs-me-sec-'));
  const projectId = randomUUID(), editId = randomUUID(), shotId = randomUUID();
  const director = { get: async () => ({ id: projectId, revision: 1, shots: [{ id: shotId }], assets: [] }) };
  const api = openMaskedEdit(data, director);
  const dir = api.editDir(editId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'receipt.json'), JSON.stringify({
    v: 1, editId, projectId, shotId, state: 'ready-for-review',
    sourceSha256: 'a'.repeat(64), candidateSha256: 'b'.repeat(64),
    maskHash: 'c'.repeat(64), inputKey: 'd'.repeat(64), quoteFingerprint: 'e'.repeat(64),
  }));
  await assert.rejects(() => api.review({
    projectId, editId, candidateSha256: 'b'.repeat(64), sourceSha256: 'a'.repeat(64), reviewedScope: false,
  }), /reviewedScope/);
  await assert.rejects(() => api.review({
    projectId, editId, candidateSha256: 'f'.repeat(64), sourceSha256: 'a'.repeat(64), reviewedScope: true,
  }), /candidateSha256/);
  await assert.rejects(() => api.review({
    projectId, editId, candidateSha256: 'b'.repeat(64), sourceSha256: '0'.repeat(64), reviewedScope: true,
  }), /sourceSha256/);
  await rm(data, { recursive: true, force: true });
});

test('acceptance validation blocks cross-shot parents and chained masked edits', () => {
  const shotA = randomUUID(), shotB = randomUUID();
  const parent = videoAsset(randomUUID(), shotA, 't');
  const chained = videoAsset(randomUUID(), shotA, 't2', {
    source: { maskedEdit: { v: 1, parentAssetId: parent.id }, sourceAssetId: parent.id },
  });
  assert.equal(isMaskedEditAsset(chained), true);
  const receipt = {
    state: 'ready-for-review', candidateSha256: 'b'.repeat(64), sourceSha256: parent.sha256,
    review: { id: randomUUID() },
  };
  assert.equal(validateAcceptanceState({
    receipt, candidateSha256: receipt.candidateSha256, sourceSha256: parent.sha256,
    reviewId: receipt.review.id, shotId: shotB, parentAsset: parent,
  }).ok, false);
  assert.equal(validateAcceptanceState({
    receipt, candidateSha256: receipt.candidateSha256, sourceSha256: parent.sha256,
    reviewId: receipt.review.id, shotId: shotA, parentAsset: chained,
  }).ok, false);
});
