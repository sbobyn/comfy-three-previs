// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { animationCode } from '../server/previs/video-blender.mjs';
import { VIDEO_LIMITS, videoOptions, createFrameStage, releaseFrameStage, writeFrame, encodeFrames, probeVideo, saveVideoAsset, browserSnapshotHash, videoReadiness } from '../server/previs/video.mjs';
import { openProject } from '../server/previs/store.mjs';

const binding = { source: 'blender', file: '/fixture.blend', scene: 'Target', camera: 'Selected', start: 3, end: 5, frame: 4, fps: 30 };
const program = name => process.env[name === 'ffmpeg' ? 'PREVIS_FFMPEG' : 'PREVIS_FFPROBE'] || name;
const mediaAvailable = ['ffmpeg', 'ffprobe'].every(name => spawnSync(program(name), ['-version'], { stdio: 'ignore' }).status === 0);
const pythonAvailable = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
const options = { width: 16, height: 16, fps: 24, frameCount: 3 };

// Tiny valid RGB PNGs keep real encoder tests independent of fixtures or downloads.
function png(width, height, color = 30) {
  const chunk = (kind, bytes) => {
    const type = Buffer.from(kind), body = Buffer.concat([type, bytes]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const prefix = Buffer.alloc(4), suffix = Buffer.alloc(4);
    prefix.writeUInt32BE(bytes.length); suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([prefix, body, suffix]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(height * (width * 3 + 1), color);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
async function fill(stage) {
  for (let index = 0; index < stage.frameCount; index++) await writeFrame({ directory: stage.directory, index, bytes: png(stage.width, stage.height, 30 + index) });
}
function execute(command, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(Error(`${command} exited ${code}: ${stderr}`)));
    child.stdin.end(input);
  });
}

test('bounded output timing includes the final frame and preserves exact rational FPS', () => {
  assert.equal(videoOptions({ frameCount: 72 }).duration, 3);
  assert.equal(videoOptions({ frameCount: 1, fps: 60 }).duration, 1 / 60);
  assert.equal(videoOptions({ frameCount: 24, fps: '24000/1001' }).duration, 1.001);
  assert.equal(videoOptions({ frameCount: 24, fps: 24000 / 1001 }).fpsRational, '24000/1001');
  assert.equal(videoOptions({ frameCount: 24, fps: '48/2' }).fpsRational, '24/1');
  assert.equal(videoOptions({ frameCount: 24, fps: 23.976 }).fpsRational, '2997/125');
  assert.equal(videoOptions({ frameCount: 120, width: 1280, height: 720, fps: 1 }).duration, 120);
  for (const change of [{ frameCount: 0 }, { frameCount: 121 }, { frameCount: 1.1 }, { fps: 0 }, { fps: 61 }, { fps: NaN }, { fps: '24' }, { fps: '1/0' }, { fps: '24/1;touch nope' }, { width: 1282 }, { height: 722 }, { width: 15 }, { height: 0 }]) assert.throws(() => videoOptions({ ...options, ...change }));
});

test('staging refuses client paths, duplicates, wrong dimensions and out-of-range indices; files are retained', async () => {
  const stage = await createFrameStage(options);
  try {
    assert.throws(() => animationCode(binding, { ...stage, outputDir: '/tmp/client-path' }), /arbitrary paths/);
    await assert.rejects(encodeFrames({ ...stage, directory: '/tmp/client-path' }), /arbitrary paths/);
    await assert.rejects(encodeFrames({ ...stage, outputPath: '/tmp/client.mp4' }), /Output path/);
    await assert.rejects(writeFrame({ directory: stage.directory, index: -1, bytes: png(16, 16) }), /index/);
    await assert.rejects(writeFrame({ directory: stage.directory, index: 3, bytes: png(16, 16) }), /index/);
    await assert.rejects(writeFrame({ directory: stage.directory, index: 0, bytes: png(32, 16) }), /dimensions/);
    await assert.rejects(writeFrame({ directory: stage.directory, index: 0, bytes: Buffer.alloc(40) }), /PNG/);
    await writeFrame({ directory: stage.directory, index: 0, bytes: png(16, 16) });
    await assert.rejects(writeFrame({ directory: stage.directory, index: 0, bytes: png(16, 16) }), { code: 'EEXIST' });
    await assert.rejects(encodeFrames(stage), /complete PNG frame sequence/);
  } finally { releaseFrameStage(stage.directory); }
  assert.ok((await lstat(join(stage.directory, 'frame-000000.png'))).isFile());
  await assert.rejects(writeFrame({ directory: stage.directory, index: 1, bytes: png(16, 16) }), /Unknown video stage/);
});

test('concurrent stage allocation is bounded', async () => {
  const results = await Promise.allSettled(Array.from({ length: VIDEO_LIMITS.maxStages + 2 }, () => createFrameStage(options)));
  try { assert.equal(results.filter(r => r.status === 'fulfilled').length, VIDEO_LIMITS.maxStages); }
  finally { for (const result of results) if (result.status === 'fulfilled') releaseFrameStage(result.value.directory); }
});

test('encoder refuses symlink frames and corrupt data without publishing an asset', { skip: !mediaAvailable }, async () => {
  const stage = await createFrameStage({ ...options, frameCount: 1 });
  const external = await mkdtemp(join(tmpdir(), 'previs-video-test-'));
  await writeFile(join(external, 'external.png'), png(16, 16));
  try {
    await symlink(join(external, 'external.png'), join(stage.directory, 'frame-000000.png'));
    await assert.rejects(encodeFrames(stage), /regular local file/);
  } finally { releaseFrameStage(stage.directory); }
  const corrupt = await createFrameStage({ ...options, frameCount: 1 });
  try {
    await writeFrame({ directory: corrupt.directory, index: 0, bytes: png(16, 16).subarray(0, 33) });
    await assert.rejects(encodeFrames(corrupt), /ffmpeg failed|frame|Video/);
  } finally { releaseFrameStage(corrupt.directory); }
});

test('real ffmpeg and ffprobe verify exact size, count, fractional FPS, duration, and no audio', { skip: !mediaAvailable, timeout: 30000 }, async () => {
  for (const change of [{}, { fps: '24000/1001', frameCount: 24 }, { fps: 60, frameCount: 1 }, { width: 1280, height: 720, frameCount: 72 }]) {
    const stage = await createFrameStage({ ...options, ...change });
    try {
      await fill(stage);
      const encoded = await encodeFrames(stage), probed = await probeVideo(encoded.file);
      assert.deepEqual(encoded.metadata, probed);
      for (const key of ['width', 'height', 'frameCount', 'fpsRational', 'duration']) assert.equal(probed[key], stage[key]);
      assert.equal(probed.audio, false); assert.equal(probed.codec, 'h264');
      await assert.rejects(encodeFrames(stage), /already encoded/);
      await assert.rejects(writeFrame({ directory: stage.directory, index: 0, bytes: png(16, 16) }), /already encoding or encoded/);
    } finally { releaseFrameStage(stage.directory); }
  }
});

test('probe rejects audio, false durations and inconsistent rational FPS or frame counts', { skip: !mediaAvailable, timeout: 30000 }, async () => {
  const stage = await createFrameStage(options), fixtures = await mkdtemp(join(tmpdir(), 'previs-video-probe-'));
  const originalProbe = process.env.PREVIS_FFPROBE;
  try {
    await fill(stage); const encoded = await encodeFrames(stage);
    const withAudio = join(fixtures, 'audio.mp4');
    await execute(program('ffmpeg'), ['-v', 'error', '-nostdin', '-n', '-i', encoded.file, '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-c:v', 'copy', '-c:a', 'aac', '-shortest', withAudio]);
    await assert.rejects(probeVideo(withAudio), /no audio/);
    const raw = JSON.parse(await execute(program('ffprobe'), ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-show_packets', '-of', 'json', encoded.file]));
    const fakeProbe = join(fixtures, 'probe tool;literal');
    for (const mutate of [data => data.streams[0].duration_ts++, data => data.format.duration = 'NaN', data => data.streams[0].r_frame_rate = '25/1', data => data.streams[0].nb_read_frames = '2', data => data.packets[1].pts++, data => data.streams.push({ codec_type: 'audio' })]) {
      const corrupted = structuredClone(raw); mutate(corrupted);
      await writeFile(fakeProbe, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(corrupted))});\n`); await chmod(fakeProbe, 0o700);
      process.env.PREVIS_FFPROBE = fakeProbe;
      await assert.rejects(probeVideo(encoded.file), /duration|FPS|count|sequence|audio/);
    }
  } finally {
    if (originalProbe === undefined) delete process.env.PREVIS_FFPROBE; else process.env.PREVIS_FFPROBE = originalProbe;
    releaseFrameStage(stage.directory);
  }
});

test('missing configured encoder fails without changing project state or removing frames', async () => {
  const stage = await createFrameStage({ ...options, frameCount: 1 }), previous = process.env.PREVIS_FFMPEG;
  try {
    await fill(stage); process.env.PREVIS_FFMPEG = join(stage.directory, 'missing executable;not-shell');
    await assert.rejects(encodeFrames(stage), /ffmpeg could not start/);
    const readiness = await videoReadiness(); assert.equal(readiness.available, false);
    assert.equal(readiness.tools.find(t => t.name === 'ffmpeg').available, false);
    assert.deepEqual(await readdir(stage.directory), ['frame-000000.png']);
  } finally {
    if (previous === undefined) delete process.env.PREVIS_FFMPEG; else process.env.PREVIS_FFMPEG = previous;
    releaseFrameStage(stage.directory);
  }
});

test('immutable versioned assets retain source binding, request revision and browser snapshot across restart', { skip: !mediaAvailable, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'previs-video-project-')), project = await openProject(root);
  const browser = { subject: [1, 2, 3], camera: { t: 0, p: [0, 1, 2], q: [0, 0, 0, 1], mm: 35 }, frames: [], sceneVersion: 1 };
  const browserBinding = { source: 'three', scene: 'Camera study', camera: 'Operated camera', fps: 24, start: 0, end: 2, frame: 0 };
  await project.mutate(project.get().revision, p => p.shots.push({ id: 'blender', binding }, { id: 'browser', binding: browserBinding, browser }));
  const stage = await createFrameStage(options);
  try {
    await fill(stage); const encoded = await encodeFrames(stage);
    const save = extra => saveVideoAsset({ root, project, revision: project.get().revision, shotId: 'blender', binding, ...encoded, ...extra });
    await assert.rejects(save({ metadata: { ...encoded.metadata, duration: 999 } }), /metadata changed/);
    await assert.rejects(save({ binding: { ...binding, camera: 'Other' } }), /binding changed/);
    const firstRevision = project.get().revision, first = await save();
    assert.equal(first.asset.version, 1); assert.equal(first.asset.requestRevision, firstRevision);
    assert.deepEqual(first.asset.binding, binding); assert.equal(first.asset.fps, 24); assert.equal(first.asset.timing.sourceFps, 30);
    assert.equal(first.asset.timing.sampling, 'one-output-frame-per-source-frame');
    const firstBytes = await readFile(join(root, 'assets', first.asset.id + '.mp4'));
    assert.equal((await lstat(join(root, 'assets', first.asset.id + '.mp4'))).mode & 0o222, 0);
    // Additive result saves may use an older revision, but still validate the exact source snapshot.
    const second = await save({ revision: firstRevision }); assert.equal(second.asset.version, 2); assert.notEqual(first.asset.id, second.asset.id);
    assert.deepEqual(await readFile(join(root, 'assets', first.asset.id + '.mp4')), firstBytes);
    await assert.rejects(save({ shotId: 'browser', binding: browserBinding }), /exact saved browser/);
    await assert.rejects(save({ shotId: 'browser', binding: browserBinding, provenance: { browserSnapshot: browser, browserSnapshotHash: 'wrong' } }), /snapshot hash/);
    const saved = await save({ shotId: 'browser', binding: browserBinding, provenance: { browserSnapshot: browser } });
    assert.equal(saved.asset.provenance.browserSnapshotHash, browserSnapshotHash(browser));
    assert.deepEqual(saved.asset.provenance.browserSnapshot, browser);
    await project.mutate(project.get().revision, p => { p.shots[0].binding.camera = 'Rebound'; p.shots[1].browser.subject[0] = 99; });
    await assert.rejects(save({ revision: firstRevision }), /binding changed/);
    await assert.rejects(save({ revision: firstRevision, shotId: 'browser', binding: browserBinding, provenance: { browserSnapshot: browser } }), /exact saved browser/);
    const reopened = (await openProject(root)).get(); assert.equal(reopened.assets.length, 3);
    assert.equal(reopened.assets[0].binding.camera, 'Selected'); assert.equal(reopened.assets[2].provenance.browserSnapshot.subject[0], 1);
    assert.deepEqual(reopened.assets, project.get().assets);
    // Persistence failure retains the copied media and does not publish project metadata.
    const failing = { get: project.get, append: fn => project.append(async p => { await fn(p); throw Error('simulated disk failure'); }) };
    const before = project.get();
    await assert.rejects(save({ project: failing, binding: before.shots[0].binding }), /simulated disk failure/);
    assert.deepEqual(project.get(), before); assert.equal((await readdir(join(root, 'assets'))).length, 4);
  } finally { releaseFrameStage(stage.directory); }
});

// Simulated bpy executes the ACTUAL generated Python; it is not a Blender/GPU job.
const mockBlender = `import sys, json, types, struct
from types import SimpleNamespace as N
payload = json.load(sys.stdin)
class Scene:
    def __init__(self, name):
        self.name = name
        self.objects = {'Selected': N(name='Selected', type='CAMERA'), 'Original': N(name='Original', type='CAMERA'), 'Marker': N(name='Marker', type='CAMERA')}
        self.objects['Selected'].data = N(type='PERSP', lens=50, sensor_width=36, sensor_height=24, sensor_fit='AUTO', ortho_scale=6)
        self.camera = self.objects['Original']
        self.frame_start, self.frame_end, self.frame_current, self.frame_subframe = 1, 90, 7, 0.25
        self.timeline_markers = [N(camera=self.objects['Marker']), N(camera=None)]
        self.render = N(fps=30, fps_base=1.0, filepath='original.exr', resolution_x=99, resolution_y=51, resolution_percentage=42, use_file_extension=False, use_compositing=True, use_sequencer=True, use_border=True, use_crop_to_border=True, pixel_aspect_x=2.0, pixel_aspect_y=1.5, use_multiview=True, use_stamp=True, use_overwrite=True, use_placeholder=True, image_settings=N(file_format='OPEN_EXR', color_mode='RGBA', color_depth='16', compression=32))
    def frame_set(self, frame, subframe=0):
        if getattr(self, 'fail_restore', False) and frame == 7: raise RuntimeError('simulated restoration failure')
        self.frame_current, self.frame_subframe = frame, subframe
        if 'Selected' in self.objects: self.objects['Selected'].data.lens = 50 + frame
        for marker in self.timeline_markers:
            if marker.camera: self.camera = marker.camera
class Window:
    def __init__(self, scene): self._scene, self.view_layer = scene, 'Original layer'
    @property
    def scene(self): return self._scene
    @scene.setter
    def scene(self, value):
        self._scene, self.view_layer = value, 'Switched layer'
        if value.name == 'Target' and payload.get('mode') == 'setupError': raise RuntimeError('simulated setup failure')
target, active = Scene('Target'), Scene('Active')
window = Window(target if payload.get('sameScene') else active)
bpy = types.ModuleType('bpy')
bpy.data = N(filepath='/fixture.blend', scenes={'Target': target, 'Active': active})
bpy.context = N(window=window)
observed = []
def snapshot():
    def scene_state(s):
        return {'camera': s.camera.name, 'frame': s.frame_current, 'subframe': s.frame_subframe, 'render': {k: v if k != 'image_settings' else vars(v).copy() for k,v in vars(s.render).items()}, 'markers': [m.camera.name if m.camera else None for m in s.timeline_markers]}
    return {'target': scene_state(target), 'active': scene_state(active), 'scene': window.scene.name, 'viewLayer': window.view_layer}
def render(write_still, scene):
    assert window.scene == target, 'wrong scene context'
    assert target.camera.name == 'Selected', 'wrong camera'
    assert target.frame_subframe == 0, 'wrong subframe'
    assert all(m.camera is None for m in target.timeline_markers), 'camera markers were not neutralized'
    assert target.render.fps == 30, 'source FPS was changed'
    assert target.render.resolution_percentage == 100 and not target.render.use_border and not target.render.use_multiview
    observed.append({'scene': scene, 'camera': target.camera.name, 'frame': target.frame_current, 'fps': target.render.fps})
    if payload.get('mode') == 'restoreFailure': target.fail_restore = True
    if payload.get('mode') == 'exception' and len(observed) == 2: raise RuntimeError('simulated render error')
    if payload.get('mode') == 'cancelled': return {'CANCELLED'}
    width = target.render.resolution_x + (2 if payload.get('mode') == 'wrongSize' else 0)
    header = bytes([137,80,78,71,13,10,26,10]) + struct.pack('>I', 13) + b'IHDR' + struct.pack('>II', width, target.render.resolution_y) + bytes(9)
    with open(target.render.filepath, 'xb') as f: f.write(header)
    return {'FINISHED'}
bpy.ops = N(render=N(render=render))
sys.modules['bpy'] = bpy
if payload.get('mode') == 'staleFps': target.render.fps = 25
if payload.get('mode') == 'staleFile': bpy.data.filepath = '/changed.blend'
if payload.get('mode') == 'staleCamera': del target.objects['Selected']
if payload.get('mode') == 'staleRange': target.frame_end = 4
before = snapshot()
try: exec(payload['code'])
except Exception as error: print('TEST_ERROR:' + str(error))
print('TEST_STATE:' + json.dumps({'before': before, 'after': snapshot(), 'observed': observed}))
`;

test('fixed Python restores render state, context, camera markers and frame/subframe on success and failure', { skip: !pythonAvailable, timeout: 30000 }, async () => {
  for (const mode of ['success', 'exception', 'cancelled', 'wrongSize', 'setupError', 'restoreFailure', 'staleFps', 'staleFile', 'staleCamera', 'staleRange']) {
    const stage = await createFrameStage(options);
    try {
      const code = animationCode(binding, { ...stage, outputDir: stage.directory });
      assert.doesNotMatch(code, /save_as_mainfile|save_mainfile|os\.unlink|shutil\.rmtree/);
      const stdout = await execute('python3', ['-c', mockBlender], JSON.stringify({ code, mode, sameScene: mode === 'cancelled' }));
      const state = JSON.parse(stdout.split('\n').find(line => line.startsWith('TEST_STATE:')).slice(11));
      if (mode === 'restoreFailure') {
        assert.match(stdout, /TEST_ERROR:Video state restoration failed/);
        assert.doesNotMatch(stdout, /PREVIS_JSON:/);
        assert.notEqual(state.after.target.frame, state.before.target.frame);
        state.after.target.frame = state.before.target.frame; state.after.target.subframe = state.before.target.subframe;
        assert.deepEqual(state.after, state.before, 'other restoration steps still run after one fails');
        continue;
      }
      const result = JSON.parse(stdout.split('\n').find(line => line.startsWith('PREVIS_JSON:')).slice(12));
      assert.deepEqual(state.after, state.before, mode);
      assert.equal(result.ok, mode === 'success', mode);
      if (mode === 'success') {
        assert.deepEqual(state.observed.map(v => v.frame), [3, 4, 5]);
        assert.deepEqual(result.binding, binding); assert.equal(result.fps, 24); assert.equal(result.sourceFps, 30);
        assert.deepEqual(result.cameraLenses.map(l => [l.frame,l.mm]), [[3,53],[4,54],[5,55]]);
        assert.equal(result.cameraLenses[0].sensorWidth,36);
        assert.equal(result.duration, 3 / 24); assert.equal(result.stateRestored, true); assert.equal(result.fileSaved, false);
      } else if (mode.startsWith('stale')) assert.equal(state.observed.length, 0);
      else assert.equal(result.stateRestored, true);
    } finally { releaseFrameStage(stage.directory); }
  }
});

// ---------- Start-still video model presets (image-to-video and start → end key frames) ----------
test('start-still video presets validate against the live partner schema; partner models get the long timeout', async () => {
  const { builtInPresets } = await import('../server/previs/presets.mjs');
  const { validateGraph, validateWorkflowDefinition } = await import('../server/previs/workflows.mjs');
  const { expectedSeconds } = await import('../server/previs/generation.mjs');
  const { maxReferences } = await import('../shared/video-refs.mjs');
  const live = JSON.parse(await readFile(new URL('./fixtures/partner-object-info.json', import.meta.url), 'utf8'));
  const nodes = { 'seedance-25-i2v-v1': 'ByteDance2ReferenceNodeV2', 'seedance-25-flf-v1': 'ByteDance2FirstLastFrameNode', 'kling-40-i2v-v1': 'Kling4ImageToVideoNode', 'kling-40-flf-v1': 'Kling4ImageToVideoNode', 'veo-31-i2v-v1': 'Veo3VideoGenerationNode', 'veo-31-flf-v1': 'Veo3FirstLastFrameNode', 'hailuo-h3-i2v-v1': 'MinimaxHailuo03FirstLastFrameNode', 'hailuo-h3-flf-v1': 'MinimaxHailuo03FirstLastFrameNode', 'wan27-i2v-v1': 'Wan2ImageToVideoApi', 'wan27-flf-v1': 'Wan2ImageToVideoApi' };
  for (const d of builtInPresets.filter(x => x.task === 'first-frame')) {
    validateWorkflowDefinition(d);
    const deferredInputs = ['firstFrame', 'lastFrame'].filter(k => d.inputs[k]).map(k => ({ ...d.inputs[k], kind: 'image', mime: 'image/png', filename: `${k}.png` }));
    const v = validateGraph(d.graph, live, { deferredInputs });
    assert.ok(v.compatible, `${d.id}: ${JSON.stringify(v.issues.slice(0, 2))}`);
    const model = d.graph['2'];
    if (nodes[d.id]) assert.equal(model.class_type, nodes[d.id], d.id);
    // The start still is wired into the model, the end still too for start → end presets, and nothing else is loaded.
    const links = Object.values(model.inputs).filter(x => Array.isArray(x)).map(x => x[0]).sort();
    assert.deepEqual(links, d.inputs.lastFrame ? ['1', '4'] : ['1'], d.id);
    for (const k of ['prompt', ...Object.keys(d.parameters)]) { const m = k === 'prompt' ? d.inputs.prompt : d.parameters[k]; assert.ok(m.input in d.graph[m.nodeId].inputs, `${d.id} maps ${k} to ${m.input}`); }
    assert.equal(maxReferences(d), 0, `${d.id}: start-still presets take no cast images (the start still is image 1)`);
    if (/generate_audio/.test(JSON.stringify(model.inputs))) assert.ok(Object.entries(model.inputs).every(([k, x]) => !/generate_audio$/.test(k) || x === false), `${d.id} keeps audio off`);
    const job = { definition: d, preparedGraph: d.graph, binding: { parameters: { duration: 5 } } };
    assert.equal(expectedSeconds(job), nodes[d.id] ? 420 : 270, d.id);
  }
  assert.equal(builtInPresets.find(d => d.id === 'seedance-25-i2v-v1').graph['2'].inputs['model.task_type'], 'reference', 'single image → Seedance reference-to-video with image 1 only');
  assert.ok(!JSON.stringify(builtInPresets).includes('reference_assets'), 'never the real-human asset route');
});
