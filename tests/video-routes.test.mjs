import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { videoRoutes } from '../server/previs/video-routes.mjs';
import { VIDEO_LIMITS, assertFrameStage, releaseFrameStage, writeFrame, browserSnapshotHash } from '../server/previs/video.mjs';

// Simulation: call the actual routes and staging/encoding functions with an
// in-memory project and fake Blender transport. No HTTP server or render jobs.
// Encoder cases use real local ffmpeg/ffprobe and tiny generated PNGs.
const mediaAvailable = ['ffmpeg', 'ffprobe'].every(name => spawnSync(process.env[name === 'ffmpeg' ? 'PREVIS_FFMPEG' : 'PREVIS_FFPROBE'] || name, ['-version'], { stdio: 'ignore' }).status === 0);
const camera = { t: 0, p: [0, 1, 4], q: [0, 0, 0, 1], mm: 35 };
const browser = { camera, frames: [camera, { ...camera, t: 1 / 24, p: [2, 3, 0] }], subject: [1, 2, -11], sceneVersion: 1 };
const browserBinding = { source: 'three', scene: 'Camera study', camera: 'Operated camera', fps: 24, start: 0, end: 1, frame: 0 };
const blenderBinding = { source: 'blender', file: '/simulation.blend', scene: 'Target', camera: 'Selected', start: 1, end: 2, frame: 1, fps: 24 };
const options = { width: 16, height: 16, fps: 24, frameCount: 2 };

function png() {
  const chunk = (name, bytes) => {
    const body = Buffer.concat([Buffer.from(name), bytes]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13), rows = Buffer.alloc(16 * 49, 60);
  header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 2;
  for (let y = 0; y < 16; y++) rows[y * 49] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const frame = png(), encodedPng = frame.toString('base64');

async function fixture(t, { blender, operations, failSave = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'previs-route-test-')));
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const directories = async () => (await readdir(root)).filter(name => name.startsWith('previs-video-')).map(name => join(root, name));
  t.after(async () => {
    try {
      for (const directory of await directories()) {
        try { releaseFrameStage(directory); }
        catch (error) { assert.match(error.message, /Unknown video stage/); }
      }
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    }
  });
  let state = structuredClone({ revision: 7, assets: [], shots: [{ id: 'browser', binding: browserBinding, browser }, { id: 'blender', binding: blenderBinding }] });
  const project = {
    get: () => structuredClone(state),
    async mutate(revision, change) {
      if (revision !== state.revision) throw Object.assign(Error('simulated revision conflict'), { status: 409 });
      const next = structuredClone(state); await change(next);
      if (failSave) throw Error('simulated project persistence failure');
      next.revision++; state = next; return structuredClone(state);
    },
  };
  const route = videoRoutes({
    data: join(root, 'project'), project,
    blender: blender || { execute() { assert.fail('browser routes must not dispatch Blender'); } },
    operations: operations || { begin() { assert.fail('browser routes must not begin Blender operations'); } },
    refreshBlender: async () => ({ catalog: { file: blenderBinding.file } }),
  });
  const start = async (extra = {}) => (await route('/api/video/browser/start', { ...options, revision: project.get().revision, shotId: 'browser', ...extra })).stage;
  const upload = (stage, index = 0, png = encodedPng) => route('/api/video/browser/frame', { stageId: stage.id, index, png });
  const abort = stage => route('/api/video/browser/abort', { stageId: stage.id });
  return { root, route, start, upload, abort, project, directories };
}
async function assertAllSlotsUsable(h) {
  const stages = [];
  for (let i = 0; i < VIDEO_LIMITS.maxStages; i++) stages.push(await h.start());
  await assert.rejects(h.start(), /Too many active video stages/);
  for (const stage of stages) await h.abort(stage);
}

test('simulation: repeated terminal frame failures free browser slots and retain uploaded files', async t => {
  const h = await fixture(t);
  for (let i = 0; i < VIDEO_LIMITS.maxStages * 2; i++) {
    const stage = await h.start();
    await h.upload(stage);
    if (i % 2) await assert.rejects(h.upload(stage), { code: 'EEXIST' });
    else await assert.rejects(h.upload(stage, 1, Buffer.from('invalid PNG').toString('base64')), /PNG/);
    await assert.rejects(h.upload(stage, 1), /Unknown browser export stage/);
    await assert.rejects(h.route('/api/video/browser/finish', { stageId: stage.id }), /Unknown browser export stage/);
  }
  const directories = await h.directories();
  assert.equal(directories.length, VIDEO_LIMITS.maxStages * 2);
  for (const directory of directories) {
    assert.deepEqual(await readdir(directory), ['frame-000000.png']);
    assert.deepEqual(await readFile(join(directory, 'frame-000000.png')), frame);
  }
  assert.deepEqual(h.project.get().assets, []);
  await assertAllSlotsUsable(h);
});

test('simulation: repeated incomplete finish failures free browser slots without requiring abort', async t => {
  const h = await fixture(t);
  for (let i = 0; i < VIDEO_LIMITS.maxStages * 2; i++) {
    const stage = await h.start(); await h.upload(stage);
    await assert.rejects(h.route('/api/video/browser/finish', { stageId: stage.id }), /complete PNG frame sequence/);
    await assert.rejects(h.upload(stage, 1), /Unknown browser export stage/);
  }
  for (const directory of await h.directories()) assert.deepEqual(await readFile(join(directory, 'frame-000000.png')), frame);
  assert.deepEqual(h.project.get().assets, []);
  await assertAllSlotsUsable(h);
});

test('simulation: repeated explicit abort is idempotent, frees slots and retains partial output', async t => {
  const h = await fixture(t);
  for (let i = 0; i < VIDEO_LIMITS.maxStages * 2; i++) {
    const stage = await h.start(); await h.upload(stage);
    assert.deepEqual(await h.abort(stage), { retained: true });
    assert.deepEqual(await h.abort(stage), { retained: true });
    await assert.rejects(h.upload(stage, 1), /Unknown browser export stage/);
  }
  for (const directory of await h.directories()) assert.deepEqual(await readFile(join(directory, 'frame-000000.png')), frame);
  await assertAllSlotsUsable(h);
});

test('simulation: route-entry expiry reclaims abandoned stages and respects upload activity', async t => {
  let now = 1000000; t.mock.method(Date, 'now', () => now);
  const h = await fixture(t);
  const recent = await h.start(), stale = [];
  for (let i = 1; i < VIDEO_LIMITS.maxStages; i++) stale.push(await h.start());
  now += 299999; await h.upload(recent);
  now += 2;
  const replacement = await h.start();
  for (const stage of stale) await assert.rejects(h.upload(stage), /Unknown browser export stage/);
  await h.upload(recent, 1);
  await h.abort(recent); await h.abort(replacement);

  // More abandonment cycles than available slots catch leaks in either stage map.
  for (let cycle = 0; cycle < VIDEO_LIMITS.maxStages + 1; cycle++) {
    const abandoned = [];
    for (let i = 0; i < VIDEO_LIMITS.maxStages; i++) abandoned.push(await h.start());
    await assert.rejects(h.start(), /Too many active video stages/);
    now += 300001;
    const next = await h.start();
    for (const stage of abandoned) await assert.rejects(h.upload(stage), /Unknown browser export stage/);
    await h.abort(next);
  }
  assert.deepEqual(h.project.get().assets, []);
  await assertAllSlotsUsable(h);
});

for (const failSave of [false, true]) {
  test(`simulation: ${failSave ? 'persistence failure' : 'successful finish'} releases slots and retains encoded files`, { skip: !mediaAvailable, timeout: 30000 }, async t => {
    const h = await fixture(t, { failSave });
    for (let i = 0; i < VIDEO_LIMITS.maxStages + 1; i++) {
      const revision = h.project.get().revision, stage = await h.start();
      await h.upload(stage); await h.upload(stage, 1);
      const finishing = h.route('/api/video/browser/finish', { stageId: stage.id });
      if (failSave) await assert.rejects(finishing, /simulated project persistence failure/);
      else {
        const { asset, project } = await finishing;
        assert.equal(project.revision, revision + 1); assert.equal(asset.requestRevision, revision);
        assert.equal(asset.shotId, 'browser'); assert.equal(asset.version, i + 1);
        assert.deepEqual(asset.binding, browserBinding); assert.deepEqual(asset.provenance.browserSnapshot, browser);
        assert.equal(asset.provenance.browserSnapshotHash, browserSnapshotHash(browser));
        assert.equal(asset.provenance.recordedDuration, 1 / 24); assert.equal(asset.provenance.sampledEndTime, 1 / 24);
        assert.equal(asset.frameCount, 2); assert.equal(asset.duration, 2 / 24);
        assert.equal(asset.fps, 24); assert.equal(asset.audio, false);
        assert.ok((await lstat(join(h.root, 'project', 'assets', asset.id + '.mp4'))).isFile());
      }
      await assert.rejects(h.upload(stage, 1), /Unknown browser export stage/);
    }
    if (failSave) { assert.deepEqual(h.project.get().assets, []); assert.equal(h.project.get().revision, 7); }
    for (const directory of await h.directories()) {
      assert.deepEqual((await readdir(directory)).sort(), ['frame-000000.png', 'frame-000001.png', 'video.mp4']);
      assert.ok((await lstat(join(directory, 'video.mp4'))).size > 0);
    }
    await assertAllSlotsUsable(h);
  });
}

test('simulation: browser abort and expiry never release an uncertain Blender stage', async t => {
  let now = 1000000, operation, executed = 0;
  t.mock.method(Date, 'now', () => now);
  const blender = { uncertain: false, async execute(code) {
    executed++; assert.match(code, /def previs_animation/);
    this.uncertain = true; throw Error('simulated unknown Blender result');
  } };
  const operations = {
    async begin(kind, input) { operation = { id: 'operation-1', kind, ...input, status: 'running' }; return operation.id; },
    get: () => operation,
    async finish(id, status, result) { assert.equal(id, operation.id); operation = { ...operation, status, result }; },
  };
  const h = await fixture(t, { blender, operations });
  await assert.rejects(h.route('/api/video/blender', { revision: 7, shotId: 'blender', width: 16, height: 16, fps: 24 }), /simulated unknown Blender result/);
  const stage = operation.stage;
  assert.equal(operation.status, 'uncertain'); assert.equal(operation.result.retainedDirectory, stage.directory);
  for (let i = 0; i < VIDEO_LIMITS.maxStages + 1; i++) {
    now += 300001;
    assert.deepEqual(await h.abort(stage), { retained: true });
    assert.equal(assertFrameStage(stage.directory).id, stage.id);
    const browsers = [];
    for (let slot = 1; slot < VIDEO_LIMITS.maxStages; slot++) browsers.push(await h.start());
    await assert.rejects(h.start(), /Too many active video stages/);
    for (const browserStage of browsers) await h.abort(browserStage);
  }
  // A delayed simulated Blender writer still owns its capability after expiry.
  await writeFrame({ directory: stage.directory, index: 0, bytes: frame });
  assert.deepEqual(await readFile(join(stage.directory, 'frame-000000.png')), frame);
  assert.equal(executed, 1); assert.equal(operation.status, 'uncertain');
  assert.deepEqual(h.project.get().assets, []);
});
