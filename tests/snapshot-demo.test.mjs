import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { demoKeep, demoClosure, slimProject, pickProjects, demoStillFile, downscaleStill, snapshotDemo, DEFAULT_MEDIA_MB } from '../scripts/snapshot-demo.mjs';

function fixture() {
  const ref = (id, note, extra = {}) => ({ id, file: `${id}.png`, mime: 'image/png', role: 'frame', note, ...extra });
  const asset = (id, kind, createdAt, source = {}) => ({ id, shotId: 's', file: `assets/${id}.mp4`, mime: 'video/mp4', kind, createdAt, source });
  return { id: 'p', scene: { entities: [{ id: 'e', look: 'look', sheets: [{ id: 'sheet', slots: [{ selected: 'rejected', accepted: 'accepted', attempts: [{ id: 'rejected', referenceId: 'reject' }, { id: 'accepted', referenceId: 'sheet-ref' }] }] }] }, { id: 'shared', lookFrom: 'e' }], references: [ref('look', '', { entityId: 'e', role: 'character' }), ref('reject', ''), ref('sheet-ref', '')] },
    shots: [{ id: 's', render: { assetId: 'current-block' }, references: [ref('old-start', 'key frame start'), ref('current-start', 'key frame start'), ref('end', 'key frame end')] }],
    assets: [asset('old-block', 'camera-render', '1'), asset('current-block', 'camera-render', '3'), asset('chosen', 'workflow-result', '2', { sourceAssetId: 'old-block', jobId: 'video-job' }), asset('rejected-video', 'workflow-result', '4')],
    edit: { clips: [{ id: 'c', shotId: 's', assetId: 'chosen', in: 1, out: 2.4 }] } };
}

test('demo selection keeps the actual older Cut take, both blockouts, key stills and accepted/shared looks', () => {
  const p = fixture(), before = structuredClone(p), keep = demoKeep(p), slim = slimProject(p, keep);
  assert.deepEqual([...keep.assets].sort(), ['chosen', 'current-block', 'old-block']);
  assert.deepEqual([...keep.refs].sort(), ['current-start', 'end', 'look', 'sheet-ref']);
  assert.deepEqual(slim.edit, p.edit);
  assert.equal(slim.scene.entities[0].sheets[0].slots[0].attempts[0].id, 'accepted');
  assert.equal(slim.scene.entities[1].lookFrom, 'e');
  assert.deepEqual(p, before);
});

test('Cut auto-selection and empty/excluded clips preserve their meaning; invalid explicit selection fails', () => {
  const p = fixture(); p.edit.clips[0].assetId = null;
  assert.ok(demoKeep(p).assets.has('rejected-video'));
  assert.deepEqual(slimProject(p).edit, p.edit);
  p.edit.clips = []; assert.deepEqual(slimProject(p).edit, p.edit);
  p.edit.clips = [{ shotId: 's', assetId: 'missing' }];
  assert.throws(() => demoKeep(p), /Unresolved Cut asset/);
  p.edit.clips[0].assetId = 'current-block';
  assert.ok(demoKeep(p).assets.has('current-block'));
});

test('selection closes over video inputs and image input receipts without retaining sibling output takes', () => {
  const p = fixture();
  p.shots[0].references[0].generated = { requestId: 'still-job' };
  const refgen = { jobs: [{ id: 'still-job', referenceIds: ['old-start', 'reject'], refs: [{ referenceId: 'look' }], graph: { seed: 42 } }] };
  const gen = { jobs: [{ id: 'video-job', sources: { firstFrame: { directorRef: { referenceId: 'old-start' } } } }, { id: 'unrelated' }] };
  const keep = demoClosure(p, refgen, gen);
  assert.ok(keep.refs.has('old-start')); assert.ok(!keep.refs.has('reject'));
  assert.deepEqual(keep.refJobs.map(j => j.id), ['still-job']);
  assert.deepEqual(keep.videoJobs.map(j => j.id), ['video-job']);
  assert.deepEqual(keep.refJobs[0].graph, { seed: 42 });
  assert.throws(() => demoClosure(p, refgen, { jobs: [] }), /Missing video receipt/);
  p.assets.find(a => a.id === 'chosen').source.sourceAssetId = 'missing-blockout';
  assert.throws(() => demoClosure(p, refgen, gen), /Unresolved source asset/);
});

test('archived and Regen scratch projects are excluded even when explicitly requested', () => {
  const picked = pickProjects(['a', 'b', 'c', 'd'], [{ id: 'a', title: 'Starter' }, { id: 'b', title: 'Regen Final Lap' }, { id: 'c', title: 'Archived' }], [{ id: 'c' }]);
  assert.deepEqual(picked.projects.map(p => p.id), ['a']);
  assert.deepEqual(picked.skipped.map(p => p.id), ['b', 'c']); assert.deepEqual(picked.missing, ['d']);
});

test('WebP derivatives bound portrait and landscape dimensions, handle existing WebP, and preserve input bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'demo-image-'));
  // Tiny, tall PPM fixture exercises the height bound without an image generation dependency.
  const src = join(dir, 'portrait.ppm'), dest = join(dir, 'portrait.webp');
  const original = Buffer.concat([Buffer.from('P6\n16 2000\n255\n'), Buffer.alloc(16 * 2000 * 3, 96)]);
  await writeFile(src, original); await downscaleStill(src, dest);
  const probe = f => JSON.parse(execFileSync(process.env.PREVIS_FFPROBE || 'ffprobe', ['-v','error','-show_entries','stream=width,height,codec_name','-of','json',f])).streams[0];
  const out = probe(dest); assert.equal(out.codec_name, 'webp'); assert.equal(out.height, 1280); assert.ok(out.width <= 16);
  assert.deepEqual(await readFile(src), original);
  const again = join(dir, 'again.webp'); await downscaleStill(dest, again); assert.deepEqual(probe(again), out);
  const wide = join(dir, 'wide.ppm'); await writeFile(wide, Buffer.concat([Buffer.from('P6\n2000 16\n255\n'), Buffer.alloc(2000 * 16 * 3, 96)]));
  const wideOut = join(dir, 'wide.webp'); await downscaleStill(wide, wideOut); assert.equal(probe(wideOut).width, 1280);
  assert.notEqual(demoStillFile('same.png'), demoStillFile('same.jpg'));
  assert.equal(demoStillFile('existing.webp'), 'existing.webp.webp');
});

test('snapshot copies videos unchanged, retains Cut and fails closed on missing files and budget without deleting media', async () => {
  const root = await mkdtemp(join(tmpdir(), 'demo-snapshot-')), data = join(root, 'data');
  const p = { id: 'p', scene: { entities: [], references: [] }, shots: [{ id: 's', references: [] }], assets: [{ id: 'v', shotId: 's', file: 'assets/v.mp4', mime: 'video/mp4', kind: 'workflow-result' }], edit: { clips: [{ shotId: 's', assetId: null, in: 0.2, out: 1 }] } };
  const get = async path => path === 'director/projects' ? { projects: [{ id: 'p' }] } : path === 'director/archived' ? { projects: [] } : path.startsWith('director/project?') ? { project: p } : { jobs: [] };
  await mkdir(join(data, 'director/p/assets'), { recursive: true });
  const bytes = Buffer.from('unchanged-video-fixture'); await writeFile(join(data, 'director/p/assets/v.mp4'), bytes);
  assert.equal(DEFAULT_MEDIA_MB, 400);
  const out = join(root, 'over'); await assert.rejects(snapshotDemo({ get, data, out, ids: ['p'], budget: 1 }), /over budget/);
  assert.deepEqual(await readFile(join(out, 'demo-media/director-assets/p/v.mp4')), bytes);
  const manifest = JSON.parse(await readFile(join(out, 'demo-data/snapshot-manifest.json')));
  assert.equal(manifest.complete, true); assert.equal(manifest.withinBudget, false);
  await assert.rejects(snapshotDemo({ get, data, out, ids: ['p'] }), /already exists/);
  p.assets[0].file = 'assets/missing.mp4';
  await assert.rejects(snapshotDemo({ get, data, out: join(root, 'missing'), ids: ['p'] }), /ENOENT/);
});

test('snapshot rewrites image files, MIME, hashes and receipt URLs together while retaining graphs/settings and original metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'demo-provenance-')), out = join(root, 'out'), data = join(root, 'data');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC', 'base64');
  const ref = { id: 'r', file: 'r.png', mime: 'image/png', role: 'frame', note: 'key frame start', generated: { requestId: 'j', seed: 4 } };
  const p = { id: 'p', scene: { entities: [], references: [] }, shots: [{ id: 's', references: [ref] }], assets: [] };
  const job = { id: 'j', graph: { '1': { class_type: 'Image', inputs: { seed: 4, key: 'fixture' } } }, guide: { file: 'guide.png', sha256: 'recorded-original-hash' }, referenceIds: ['r'], results: [{ id: 'r', url: '/director-refs/p/r.png' }] };
  const before = structuredClone({ p, job });
  const get = async path => path === 'director/projects' ? { projects: [{ id: 'p' }] } : path === 'director/archived' ? { projects: [] } : path.startsWith('director/project?') ? { project: p } : path.startsWith('director/refgen?') ? { jobs: [job] } : { jobs: [] };
  for (const [file, bytes] of [['director/p/refs/r.png', png], ['director/p/refgen/guide.png', png]]) { await mkdir(join(data, file, '..'), { recursive: true }); await writeFile(join(data, file), bytes); }
  const manifest = await snapshotDemo({ get, data, out, ids: ['p'] });
  const result = JSON.parse(await readFile(join(out, 'demo-data/project-p.json'))).project.shots[0].references[0];
  const receipt = JSON.parse(await readFile(join(out, 'demo-data/refgen-p.json'))).jobs[0];
  assert.equal(result.file, 'r.png.webp'); assert.equal(result.mime, 'image/webp'); assert.equal(result.width, 1); assert.equal(result.height, 1);
  assert.equal(result.demoMedia.original.mime, 'image/png'); assert.equal(result.demoMedia.original.file, 'director/p/refs/r.png');
  assert.equal(receipt.guide.demoMedia.original.recorded.sha256, 'recorded-original-hash');
  assert.equal(receipt.results[0].url, '/director-refs/p/r.png.webp'); assert.equal(receipt.guide.url, '/director-refgen/p/guide.png.webp');
  assert.deepEqual(receipt.graph, job.graph); assert.deepEqual(result.generated, ref.generated);
  assert.deepEqual({ p, job }, before); assert.deepEqual(await readFile(join(data, 'director/p/refs/r.png')), png);
  const hash = (await import('node:crypto')).createHash;
  for (const m of manifest.media) assert.equal(hash('sha256').update(await readFile(join(out, 'demo-media', m.path))).digest('hex'), m.sha256);
});
