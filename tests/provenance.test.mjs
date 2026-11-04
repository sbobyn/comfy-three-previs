import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactAsset, expandAsset, compactAssets } from '../server/previs/provenance.mjs';
import { openProject } from '../server/previs/store.mjs';
import { generationRoutes } from '../server/previs/generation-routes.mjs';

// B23: generation provenance by reference to its receipt in the legacy project store.
const JOB = '0b8c7f5e-2f4c-4d7e-9a51-3c1d2e4f5a6b';
const receipt = { id: JOB, shot: { id: 'shot', title: 'Shot', browser: { frames: [{ t: 0, p: [0, 1, 2] }] } }, sources: { firstFrame: { id: 'a1', sha256: 'f'.repeat(64), provenance: { note: 'nested' } } } };
const asset = (provenance = {}) => ({ id: 'r1', key: '2:abc', generationJobId: JOB, provenance: { requestShot: structuredClone(receipt.shot), generationJobId: JOB, sourceAssets: structuredClone(receipt.sources), prompt: 'p', ...provenance } });

test('compact drops only copies equal to the receipt; expand restores them exactly', () => {
  const full = asset(), compact = compactAsset(full, receipt);
  assert.deepEqual(compact.provenance, { generationJobId: JOB, prompt: 'p', byReference: ['requestShot', 'sourceAssets'] });
  assert.deepEqual(expandAsset(compact, id => id === JOB ? receipt : null), full);
  assert.equal(compactAsset(compact, receipt), compact, 'already compact: unchanged');
  // A copy that differs from its receipt stays inline.
  const edited = asset({ requestShot: { ...receipt.shot, title: 'Edited' } }), partly = compactAsset(edited, receipt);
  assert.deepEqual(partly.provenance.byReference, ['sourceAssets']); assert.equal(partly.provenance.requestShot.title, 'Edited');
  assert.deepEqual(expandAsset(partly, () => receipt), edited);
  // No receipt, another job's receipt, or not a generation result: unchanged.
  assert.equal(compactAsset(full, null), full);
  assert.equal(compactAsset(full, { ...receipt, id: 'other' }), full);
  const capture = { id: 'v1', provenance: { browserSnapshot: { frames: [] }, browserSnapshotHash: 'h' } };
  assert.equal(compactAsset(capture, receipt), capture);
  assert.equal(compactAsset(asset({ requestShot: undefined }), { ...receipt, shot: undefined }).provenance.byReference.join(), 'sourceAssets');
});

test('expand with a missing receipt keeps the reference instead of guessing', () => {
  const compact = compactAsset(asset(), receipt), out = expandAsset(compact, () => null);
  assert.deepEqual(out.provenance.byReference, ['requestShot', 'sourceAssets']); assert.equal('requestShot' in out.provenance, false);
  const capture = { id: 'v1', provenance: { browserSnapshotHash: 'h' } };
  assert.equal(expandAsset(capture, () => receipt), capture);
});

test('compactAssets counts changes and leaves a store without assets alone', () => {
  const project = { assets: [asset(), { id: 'blender', provenance: { renderer: 'Blender' } }, compactAsset(asset(), receipt)] };
  assert.equal(compactAssets(project, id => id === JOB ? receipt : null), 1);
  assert.equal(compactAssets(project, () => receipt), 0);
  const empty = { shots: [] };
  assert.equal(compactAssets(empty, () => receipt), 0); assert.equal('assets' in empty, false);
});

// Set PREVIS_MIGRATION_DATA=<data dir> to migrate an APFS clone of a real store (project.json + generation-jobs only;
// the original is never written) and prove every asset reads back exactly.
test('migration: a real legacy store shrinks and every asset reads back exactly', { skip: !process.env.PREVIS_MIGRATION_DATA && 'set PREVIS_MIGRATION_DATA' }, async () => {
  const source = process.env.PREVIS_MIGRATION_DATA, copy = join(await mkdtemp(join(tmpdir(), 'previs-b23-')), 'data');
  await mkdir(copy);
  execFileSync('cp', ['-c', join(source, 'project.json'), join(copy, 'project.json')]);
  execFileSync('cp', ['-c', '-R', join(source, 'generation-jobs'), join(copy, 'generation-jobs')]);
  const before = JSON.parse(await readFile(join(copy, 'project.json'), 'utf8')), beforeBytes = (await stat(join(copy, 'project.json'))).size;
  const project = await openProject(copy);
  const routes = await generationRoutes(copy, project, { backendFactory: () => { throw Error('No backend call expected'); } });
  const after = JSON.parse(await readFile(join(copy, 'project.json'), 'utf8')), afterBytes = (await stat(join(copy, 'project.json'))).size;
  assert.equal(after.revision, before.revision);
  assert.deepEqual({ ...after, assets: null }, { ...before, assets: null }, 'only assets change');
  const receiptOf = id => routes.state().jobs.find(j => j.id === id);
  assert.deepEqual(after.assets.map(a => expandAsset(a, receiptOf)), before.assets, 'every asset reads back exactly');
  const referenced = after.assets.filter(a => a.provenance?.byReference).length;
  console.log(`# B23 migration clone: ${before.assets.length} assets, ${referenced} by reference; project.json ${beforeBytes} → ${afterBytes} bytes`);
  assert.ok(afterBytes < beforeBytes);
});
