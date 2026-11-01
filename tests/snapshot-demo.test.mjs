import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { demoKeep, demoClosure, slimProject, pickProjects, demoStillFile, downscaleStill, snapshotDemo, starterDrift, starterFor, DEFAULT_MEDIA_MB, DEFAULT_PROJECTS } from '../scripts/snapshot-demo.mjs';
import { loadStarters, starterSourceProject, starterSourceId } from '../server/previs/starters.mjs';
import { SOURCES } from '../scripts/export-starters.mjs';
import { importStarters } from '../scripts/import-starters.mjs';

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

test('every repeated Cut clip retains its own take, automatic selection and trims', () => {
  const p = fixture();
  p.edit.clips.push({ shotId: 's', assetId: 'rejected-video', in: 0.5, out: 1.5 }, { shotId: 's', assetId: null, in: 0, out: 1 });
  const before = structuredClone(p), slim = slimProject(p);
  assert.deepEqual(slim.edit, before.edit);
  for (const clip of slim.edit.clips.filter(c => c.assetId)) assert.ok(slim.assets.some(a => a.id === clip.assetId));
  p.edit.clips.push({ shotId: 's', assetId: 'absent' });
  assert.throws(() => demoKeep(p), /Unresolved Cut asset absent/);
});

test('engine-only generated PNG ancestors retain receipts, source media and nested provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'demo-engine-chain-')), data = join(root, 'data'), out = join(root, 'out');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC', 'base64');
  const id = '11111111-1111-4111-8111-111111111111';
  const first = { id: 'first', filename: 'first.png', url: '/assets/first.png', mime: 'image/png', sourceType: 'asset' };
  const image = { id, filename: `${id}.png`, url: `/renders/${id}.png`, mime: 'image/png', sourceType: 'asset', generationJobId: 'upstream', provenance: { generationJobId: 'upstream', sourceAssets: { firstFrame: first } } };
  const p = { id: 'p', scene: { entities: [], references: [] }, shots: [{ id: 's', references: [] }], assets: [{ id: 'v', shotId: 's', file: 'assets/v.mp4', mime: 'video/mp4', kind: 'workflow-result', source: { jobId: 'downstream' } }], edit: { clips: [{ shotId: 's', assetId: 'v' }] } };
  const gen = { jobs: [{ id: 'downstream', sources: { image }, results: [{ id: 'v' }] }, { id: 'upstream', graph: { seed: 21 }, sources: { firstFrame: first }, results: [image, { id: 'unrelated' }] }] };
  const keep = demoClosure(p, { jobs: [] }, gen);
  assert.deepEqual(keep.videoJobs.map(j => j.id), ['downstream', 'upstream']);
  assert.ok(keep.engineAssets.has(id));
  assert.throws(() => demoClosure(p, { jobs: [] }, { jobs: gen.jobs.slice(0, 1) }), /Missing video receipt upstream/);
  const provenanceOnly = structuredClone(gen); delete provenanceOnly.jobs[0].sources.image.generationJobId;
  assert.equal(demoClosure(p, { jobs: [] }, provenanceOnly).videoJobs.length, 2);
  for (const [file, bytes] of [['director/p/assets/v.mp4', Buffer.from('video')], [`renders/${id}.png`, png], ['assets/first.png', png]]) {
    await mkdir(join(data, file, '..'), { recursive: true }); await writeFile(join(data, file), bytes);
  }
  const get = async path => path === 'director/projects' ? { projects: [{ id: 'p' }] } : path === 'director/archived' ? { projects: [] } : path.startsWith('director/project?') ? { project: p } : path === 'generation' ? gen : { jobs: [] };
  const before = structuredClone(gen);
  const manifest = await snapshotDemo({ get, data, out, ids: ['p'] });
  const saved = JSON.parse(await readFile(join(out, 'demo-data/generation.json')));
  assert.equal(saved.jobs.length, 2);
  assert.deepEqual(saved.jobs[1].graph, { seed: 21 });
  assert.deepEqual(saved.jobs[1].results.map(r => r.id), [id]);
  const published = new Set(manifest.media.map(m => '/' + m.path));
  for (const j of saved.jobs) for (const input of Object.values(j.sources)) {
    assert.ok(published.has(input.url));
    for (const ancestor of Object.values(input.provenance?.sourceAssets || {})) assert.ok(published.has(ancestor.url));
  }
  assert.equal(saved.jobs[0].sources.image.demoMedia.original.file, `renders/${id}.png`);
  assert.ok(published.has(saved.jobs[1].results[0].url));
  assert.deepEqual(gen, before);
});

test('shared upstream receipts retain the union of outputs needed by all projects in either order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'demo-shared-receipt-')), data = join(root, 'data');
  const input = id => ({ id, filename: `${id}.mp4`, url: `/assets/${id}.mp4`, mime: 'video/mp4', sourceType: 'asset', generationJobId: 'shared' });
  const projects = ['a', 'b'].map(id => ({ id, scene: { entities: [], references: [] }, shots: [{ id: 's', references: [] }],
    assets: [{ id: `video-${id}`, shotId: 's', file: `assets/video-${id}.mp4`, mime: 'video/mp4', kind: 'workflow-result', source: { jobId: `job-${id}` } }] }));
  const gen = { jobs: [{ id: 'shared', sources: {}, results: [input('a'), input('b'), input('unused')] },
    ...projects.map(p => ({ id: `job-${p.id}`, sources: { sourceVideo: input(p.id) }, results: [] }))] };
  for (const p of projects) for (const file of [`director/${p.id}/assets/video-${p.id}.mp4`, `assets/${p.id}.mp4`]) {
    await mkdir(join(data, file, '..'), { recursive: true }); await writeFile(join(data, file), Buffer.from(file));
  }
  const get = async path => path === 'director/projects' ? { projects: projects.map(p => ({ id: p.id })) } : path === 'director/archived' ? { projects: [] } : path.startsWith('director/project?') ? { project: projects.find(p => path.endsWith(`=${p.id}`)) } : path === 'generation' ? gen : { jobs: [] };
  for (const ids of [['a', 'b'], ['b', 'a']]) {
    const out = join(root, ids.join('-')); await snapshotDemo({ get, data, out, ids });
    const saved = JSON.parse(await readFile(join(out, 'demo-data/generation.json')));
    const results = saved.jobs.find(j => j.id === 'shared').results;
    assert.deepEqual(results.map(r => r.id).sort(), ['a', 'b']);
    for (const result of results) assert.deepEqual(await readFile(join(out, 'demo-media', result.url)), Buffer.from(`assets/${result.id}.mp4`));
  }
});

test('the demo defaults to the bundled starters’ source projects, and an imported bundle shows no drift', async () => {
  assert.deepEqual(DEFAULT_PROJECTS, SOURCES.map(s => s.id));
  const starters = await loadStarters();
  assert.equal(starters.length, SOURCES.length);
  for (const s of starters) {
    const { project } = starterSourceProject(s);
    assert.equal(starterFor(project, starters), s);
    assert.ok(project.scene.entities.some(e => e.model), `${s.slug} uses Blender display models`);
    assert.deepEqual(starterDrift(slimProject(project), s), [], s.slug);
  }
  // Drift a project the way the old dev projects had drifted: no display model, a different camera, another cut.
  const s = starters.find(x => x.slug === 'breaking-news'), { project } = starterSourceProject(s);
  const anchor = project.scene.entities.find(e => e.model === 'anchor');
  delete anchor.model;
  project.shots[1].camera.keys[0].p[0] += 0.5;
  project.edit.clips[0].out = 1;
  assert.deepEqual(starterDrift(project, s), [`shot “${project.shots[1].title}” differs in camera`, 'cut differs', `entity “${anchor.name}” differs in model`]);
  // An old dev project pairs by its "Starter · " title.
  assert.equal(starterFor({ id: 'legacy', title: 'Starter · Breaking News' }, starters), s);
});

test('the snapshot is built from the imported bundle and refuses a starter project that drifted from it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'demo-starter-sync-')), data = join(root, 'data');
  try {
    const starters = (await loadStarters()).filter(s => s.slug === 'wingspan'), [s] = starters;
    await importStarters({ dataDir: data, only: s.slug, log: () => {} });
    const id = starterSourceId(s.slug), file = join(data, 'director', id, 'project.json');
    const read = async () => JSON.parse(await readFile(file, 'utf8'));
    let doc = await read();
    const get = async path => path === 'director/projects' ? { projects: [{ id, title: doc.title }] } : path === 'director/archived' ? { projects: [] }
      : path.startsWith('director/project?') ? { project: doc } : path === 'director/starters' ? { starters: starters.map(x => ({ slug: x.slug, title: x.title })) } : { jobs: [] };
    await snapshotDemo({ get, data, out: join(root, 'ok'), ids: [id], starters });
    const shown = JSON.parse(await readFile(join(root, 'ok', `demo-data/project-${id}.json`))).project;
    assert.deepEqual(shown.scene.entities.map(e => e.model ?? null), s.scene.entities.map(e => e.model ?? null));
    assert.deepEqual(shown.shots.map(x => x.camera), s.shots.map(x => x.camera));
    assert.deepEqual(shown.edit.clips.map(c => c.assetId), s.edit.clips.map(c => c.assetId), 'the cut keeps the bundle’s chosen videos');
    assert.deepEqual(JSON.parse(await readFile(join(root, 'ok', 'demo-data/starters.json'))).starters.map(x => x.projectId), [id]);

    doc = await read();
    for (const e of doc.scene.entities) delete e.model;
    doc.shots[0].camera.keys[0].p[1] += 1;
    await assert.rejects(snapshotDemo({ get, data, out: join(root, 'drifted'), ids: [id], starters }),
      e => /differs from its bundled starter examples\/starters\/wingspan/.test(e.message) && /differs in model/.test(e.message) && e.message.includes(`shot “${doc.shots[0].title}” differs in camera`));
    await assert.rejects(snapshotDemo({ get, data, out: join(root, 'missing'), starters }), /Requested projects missing.*pnpm starters:import/s);
  } finally { await rm(root, { recursive: true, force: true }); }
});
