// Masked-edit offline foundation: geometry, composite preservation, cut eligibility (no provider).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  sourceEligible, normalizeMask, rasterizeFixedMask, cropFromMask, validateCropEnvelope,
  compositeFrame, verifyOutsideExact, ELIGIBLE_WIDTH, ELIGIBLE_HEIGHT, ELIGIBLE_FRAMES,
  offlineQuoteEnvelope, validateAcceptanceState, buildMaskedEditProvenance, isMaskedEditAsset,
  MASKED_EDIT_WORKFLOW,
} from '../shared/masked-edit.mjs';
import { automaticCutEligible, cutAsset, winnerOps, newestAutomaticVideo, videoResults } from '../shared/takes.mjs';
import { videoStale } from '../shared/director.mjs';
import { cameraSourceForMaskedEdit } from '../shared/camera-source.mjs';
import { openMaskedEdit, grayPng } from '../server/previs/masked-edit.mjs';
import { rectMask, rgbFrame, checkerFrame, videoAsset } from './fixtures/masked-edit/helpers.mjs';

test('sourceEligible accepts only silent 720p/24fps with 81|89|113 frames', () => {
  for (const frameCount of ELIGIBLE_FRAMES) {
    assert.equal(sourceEligible({ width: 1280, height: 720, fps: 24, frameCount, audio: false }).ok, true);
  }
  assert.equal(sourceEligible({ width: 1280, height: 720, fps: 24, frameCount: 88 }).ok, false);
  assert.equal(sourceEligible({ width: 1920, height: 1080, fps: 24, frameCount: 81 }).ok, false);
  assert.equal(sourceEligible({ width: 1280, height: 720, fps: 30, frameCount: 81 }).ok, false);
  assert.equal(sourceEligible({ width: 1280, height: 720, fps: 24, frameCount: 81, audio: true }).ok, false);
});

test('fixed mask raster + inside feather + crop envelope are deterministic', () => {
  const mask = rectMask({ x: 400, y: 200, w: 160, h: 160, featherPx: 8 });
  const a = rasterizeFixedMask(mask);
  const b = rasterizeFixedMask(mask);
  assert.equal(a.maskHash, b.maskHash);
  assert.ok(a.nonzero > 0 && a.nonzero < a.alpha.length);
  // Outside painted support stays 0 (no dilation).
  assert.equal(a.alpha[0], 0);
  const crop = cropFromMask(a.alpha, ELIGIBLE_WIDTH, ELIGIBLE_HEIGHT);
  assert.equal(validateCropEnvelope(crop).ok, true);
  assert.equal(crop.w % 16, 0);
  assert.equal(crop.h % 16, 0);
  assert.ok(crop.w >= 320 && crop.h >= 320);
  assert.ok(crop.contains.minX >= crop.x && crop.contains.maxX < crop.x + crop.w);
});

test('empty and full-frame masks are refused', () => {
  assert.throws(() => rasterizeFixedMask(rectMask({ x: -10, y: -10, w: 1, h: 1 })), /empty|Mask/i);
  assert.throws(
    () => rasterizeFixedMask({ v: 1, mode: 'fixed', width: 1280, height: 720, coordinateSpace: 'source-pixels', featherPx: 0, strokes: [{ type: 'rect', x: 0, y: 0, w: 1280, h: 720 }] }),
    /entire frame|full/i,
  );
});

test('normalizeMask bounds hostile / unknown payloads', () => {
  assert.throws(() => normalizeMask({ v: 2, mode: 'fixed', coordinateSpace: 'source-pixels', strokes: [] }), /version/i);
  assert.throws(() => normalizeMask({ v: 1, mode: 'tracked', coordinateSpace: 'source-pixels', strokes: [] }), /fixed/i);
  assert.throws(() => normalizeMask({ v: 1, mode: 'fixed', coordinateSpace: 'display', width: 1280, height: 720, strokes: [] }), /source-pixels/i);
  assert.throws(() => normalizeMask({ v: 1, mode: 'fixed', coordinateSpace: 'source-pixels', width: 1280, height: 720, strokes: Array.from({ length: 300 }, () => ({ type: 'rect', x: 1, y: 1, w: 2, h: 2 })) }), /256/i);
});

test('compositeFrame: alpha==0 copies source exactly; white replaces from crop', () => {
  const w = 32, h = 32, crop = { x: 8, y: 8, w: 16, h: 16 };
  const src = checkerFrame(w, h);
  const patch = rgbFrame(crop.w, crop.h, [255, 0, 255]);
  const alpha = new Uint8Array(w * h);
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) alpha[y * w + x] = 255;
  const out = compositeFrame(src, patch, alpha, w, h, crop);
  assert.equal(verifyOutsideExact(src, out, alpha).ok, true);
  const i = (12 * w + 12) * 3;
  assert.deepEqual([out[i], out[i + 1], out[i + 2]], [255, 0, 255]);
  // Inverted mask would change outside — prove polarity by checking a black pixel stayed.
  assert.deepEqual([out[0], out[1], out[2]], [src[0], src[1], src[2]]);
});

test('offline quote stays unknown with a planning estimate and no SAM3 line', () => {
  const q = offlineQuoteEnvelope({ frameCount: 81, crop: { w: 320, h: 480 } });
  assert.equal(q.status, 'unknown');
  assert.equal(q.amount, null);
  assert.equal(q.providerEnforcedCap, false);
  assert.ok(Number.isFinite(q.estimate) && q.estimate > 0);
  assert.equal(q.lineItems.sam3, 0);
});

test('automaticCutEligible excludes masked-edit takes from implicit newest; winnerOps uses shared resolver', () => {
  const shotId = randomUUID(), parentId = randomUUID(), editId = randomUUID(), blockId = randomUUID();
  const shot = { id: shotId, title: 'S', duration: 3, winner: undefined };
  const parent = videoAsset(parentId, shotId, '2026-11-01T10:00:00Z', { sourceAssetId: blockId });
  const edited = videoAsset(editId, shotId, '2026-11-01T11:00:00Z', {
    sourceAssetId: parentId,
    source: {
      sourceAssetId: parentId, workflow: MASKED_EDIT_WORKFLOW, backend: 'local', cameraSource: 'blockout',
      maskedEdit: { v: 1, editId: randomUUID(), parentAssetId: parentId, parentSha256: parent.sha256, rootAssetId: parentId, maskMode: 'fixed' },
    },
  });
  const p = {
    assets: [
      { id: blockId, kind: 'camera-render', shotId, file: `assets/${blockId}.mp4`, mime: 'video/mp4', sha256: '', width: 1280, height: 720, fps: 24, frameCount: 81, duration: 3, createdAt: '2026-11-01T09:00:00Z', source: {} },
      parent, edited,
    ],
    shots: [shot],
  };
  assert.equal(automaticCutEligible(parent), true);
  assert.equal(automaticCutEligible(edited), false);
  assert.equal(isMaskedEditAsset(edited), true);
  assert.equal(cutAsset(p, shot).id, parentId, 'no-winner cut stays on ordinary newest, not the edit');
  assert.equal(newestAutomaticVideo(p, shot).id, parentId);
  assert.equal(videoResults(p, shot).length, 2, 'lists still show the edit');

  // Clear-winner fallback must not jump to the masked edit.
  shot.winner = parentId;
  const ops = winnerOps(p, shot, null);
  assert.equal(ops.redo[0].assetId, null);
  // Simulate clear: after = newest automatic = parent (same as before media).
  shot.winner = undefined;
  assert.equal(cutAsset(p, shot).id, parentId);

  // Explicit winner may select the edit.
  const pick = winnerOps(p, shot, editId);
  assert.deepEqual(pick.redo[0], { op: 'set_winner', shotId, assetId: editId });
});

test('videoStale inherits parent; cameraSourceForMaskedEdit retains parent annotation', () => {
  const shotId = randomUUID(), parentId = randomUUID(), editId = randomUUID(), oldBlock = randomUUID(), newBlock = randomUUID();
  const shot = { id: shotId, title: 'S', duration: 3, render: { assetId: newBlock, createdAt: '2026-11-02T00:00:00Z' } };
  const parent = videoAsset(parentId, shotId, '2026-11-01T10:00:00Z', {
    sourceAssetId: oldBlock,
    source: { sourceAssetId: oldBlock, workflow: 'x', cameraSource: 'blockout' },
  });
  const edited = videoAsset(editId, shotId, '2026-11-01T12:00:00Z', {
    source: {
      sourceAssetId: parentId, workflow: MASKED_EDIT_WORKFLOW, cameraSource: 'blockout',
      maskedEdit: { v: 1, parentAssetId: parentId, parentSha256: parent.sha256, rootAssetId: parentId },
    },
  });
  const p = {
    shots: [shot],
    scene: { name: 's', environment: { preset: 'stage', description: '' }, entities: [] },
    assets: [
      // No signature/regen → clipCurrent is null; a newer blockout still marks the parent stale.
      { id: oldBlock, kind: 'camera-render', shotId, file: `a.mp4`, mime: 'video/mp4', sha256: '', width: 1280, height: 720, fps: 24, frameCount: 81, duration: 3, createdAt: '2026-11-01T08:00:00Z', source: {} },
      { id: newBlock, kind: 'camera-render', shotId, file: `b.mp4`, mime: 'video/mp4', sha256: '', width: 1280, height: 720, fps: 24, frameCount: 81, duration: 3, createdAt: '2026-11-02T00:00:00Z', source: {} },
      parent, edited,
    ],
  };
  assert.equal(videoStale(p, shot, parent), true, 'parent made from older blockout');
  assert.equal(videoStale(p, shot, edited), true, 'edit inherits parent staleness');
  assert.equal(cameraSourceForMaskedEdit(parent), 'blockout');
  assert.equal(cameraSourceForMaskedEdit({ source: {} }), null);
});

test('local compositeFromFrames quarantines a candidate with exact outside preservation (2 synthetic frames)', async () => {
  const data = await mkdtemp(join(tmpdir(), 'previs-me-'));
  const projectId = randomUUID(), shotId = randomUUID(), sourceAssetId = randomUUID(), editId = randomUUID();
  const director = {
    get: async id => {
      if (id !== projectId) throw Object.assign(Error('Unknown project'), { status: 404 });
      return { id: projectId, revision: 1, shots: [{ id: shotId }], assets: [videoAsset(sourceAssetId, shotId, '2026-11-01T10:00:00Z')] };
    },
    assetFile: async () => { throw Error('not used'); },
    archive: async () => {},
    restore: async () => ({ project: await director.get(projectId) }),
  };
  const api = openMaskedEdit(data, director);
  const mask = rasterizeFixedMask(rectMask({ x: 200, y: 200, w: 240, h: 240, featherPx: 4 }));
  const crop = cropFromMask(mask.alpha, ELIGIBLE_WIDTH, ELIGIBLE_HEIGHT);
  const dir = api.editDir(editId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'mask.bin'), Buffer.from(mask.alpha));
  const frames = 2;
  const sourceFrames = [checkerFrame(ELIGIBLE_WIDTH, ELIGIBLE_HEIGHT), checkerFrame(ELIGIBLE_WIDTH, ELIGIBLE_HEIGHT, [10, 20, 30], [40, 50, 60])];
  const patchFrames = [rgbFrame(crop.w, crop.h, [255, 128, 0]), rgbFrame(crop.w, crop.h, [0, 128, 255])];
  const receipt = {
    v: 1, editId, draftRevision: 1, state: 'prepared', projectId, shotId, sourceAssetId,
    sourceSha256: 'b'.repeat(64), maskHash: mask.maskHash, featherPx: 4, cropRect: { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
    sourceTiming: { width: 1280, height: 720, fps: 24, frameCount: frames, duration: frames / 24 },
    prompt: 'Change the coat to red.', negativePrompt: '', seed: 1, inputKey: 'c'.repeat(64),
    quoteFingerprint: 'd'.repeat(64), quote: offlineQuoteEnvelope({ frameCount: frames, crop }),
    providerDispatch: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    candidateSha256: null, review: null, acceptance: null, preservation: null,
  };
  await writeFile(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));

  const ready = await api.compositeFromFrames({ editId, projectId, sourceFrames, patchFrames });
  assert.equal(ready.state, 'ready-for-review');
  assert.match(ready.candidateSha256, /^[a-f0-9]{64}$/);
  assert.equal(ready.preservation.outsideExact, true);

  // Post-Cloud path: receipt stays `submitted` until local composite runs.
  const submittedId = randomUUID();
  const submittedDir = api.editDir(submittedId);
  await mkdir(submittedDir, { recursive: true });
  await writeFile(join(submittedDir, 'mask.bin'), Buffer.from(mask.alpha));
  await writeFile(join(submittedDir, 'receipt.json'), JSON.stringify({
    ...receipt, editId: submittedId, state: 'submitted', jobId: randomUUID(), providerDispatch: true,
  }, null, 2));
  const fromSubmitted = await api.compositeFromFrames({
    editId: submittedId, projectId, sourceFrames, patchFrames,
  });
  assert.equal(fromSubmitted.state, 'ready-for-review');
  assert.equal(fromSubmitted.preservation.outsideExact, true);

  const reviewed = await api.review({
    projectId, editId, candidateSha256: ready.candidateSha256, sourceSha256: receipt.sourceSha256,
    fingerprint: receipt.inputKey, reviewedScope: true,
  });
  assert.match(reviewed.reviewId, /^[a-f0-9-]{36}$/i);

  const acceptCheck = validateAcceptanceState({
    receipt: { ...receipt, state: 'ready-for-review', candidateSha256: ready.candidateSha256, review: { id: reviewed.reviewId } },
    candidateSha256: ready.candidateSha256, sourceSha256: receipt.sourceSha256, reviewId: reviewed.reviewId,
    project: await director.get(projectId), shotId, parentAsset: videoAsset(sourceAssetId, shotId, 't'),
  });
  assert.equal(acceptCheck.ok, true);

  // grayPng round-trip size / signature
  const png = grayPng(8, 8, new Uint8Array(64).fill(255));
  assert.equal(png[0], 137);
  assert.ok(png.length > 40);

  await rm(data, { recursive: true, force: true });
});

test('buildMaskedEditProvenance records parent lineage and local cost status', () => {
  const parent = videoAsset(randomUUID(), randomUUID(), '2026-11-01T10:00:00Z');
  const prov = buildMaskedEditProvenance({
    editId: randomUUID(), parent, rootId: parent.id, maskHash: 'e'.repeat(64), featherPx: 8,
    cropRect: { x: 0, y: 0, w: 320, h: 480 }, sourceTiming: { width: 1280, height: 720, fps: 24, frameCount: 81 },
    prompt: 'red parka', negativePrompt: '', seed: 3, compositeSha256: 'f'.repeat(64), inputKey: '1'.repeat(64),
  });
  assert.equal(prov.v, 1);
  assert.equal(prov.parentAssetId, parent.id);
  assert.equal(prov.maskMode, 'fixed');
  assert.equal(prov.costStatus, 'local-offline');
  assert.equal(prov.patchJobId, null);
});
