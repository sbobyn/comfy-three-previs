import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { openDirector, applyOps, clipAsset, editClips, createProjectDocument } from '../server/previs/director.mjs';
import { planClips } from '../server/previs/edit.mjs';

test('clip planning trims and rejects empty or missing media', () => {
  assert.deepEqual(planClips([{ file: 'a', duration: 3, in: 0.5, out: 2 }]).map(c => c.length), [1.5]);
  assert.equal(planClips([{ file: 'a', duration: 3, in: 0, out: 99 }])[0].out, 3, 'out clamps to the clip');
  assert.throws(() => planClips([]), /at least one/);
  assert.throws(() => planClips([{ file: 'a', duration: 3, in: 2, out: 2 }]), /trimmed to nothing/);
  assert.throws(() => planClips([{ duration: 3 }]), /no rendered video/);
});

test('timeline clips pick the newest result, then the newest render; explicit choices must belong to the shot', () => {
  const p = createProjectDocument({ template: 'street' });
  applyOps(p, [{ op: 'add_shot', shot: { title: 'Two' } }]);
  const [s1, s2] = p.shots;
  p.assets = [
    { id: 'r1', kind: 'camera-render', shotId: s1.id, mime: 'video/mp4', createdAt: '2026-01-01' },
    { id: 'r2', kind: 'camera-render', shotId: s1.id, mime: 'video/mp4', createdAt: '2026-01-02' },
    { id: 'w1', kind: 'workflow-result', shotId: s1.id, mime: 'video/mp4', createdAt: '2026-01-01' },
  ];
  assert.equal(editClips(p).length, 2, 'defaults to every shot in order');
  assert.equal(clipAsset(p, { shotId: s1.id }).id, 'w1');
  assert.equal(clipAsset(p, { shotId: s1.id, assetId: 'r1' }).id, 'r1');
  assert.equal(clipAsset(p, { shotId: s2.id }), null);
  applyOps(p, [{ op: 'set_edit', clips: [{ shotId: '2' }, { shotId: s1.id, assetId: 'r2', in: 0.5, out: 2 }] }]);
  assert.deepEqual(p.edit.clips.map(c => [c.shotId, c.assetId, c.in, c.out]), [[s2.id, null, 0, null], [s1.id, 'r2', 0.5, 2]]);
  applyOps(p, [{ op: 'set_edit', clips: p.edit.clips }]);
  assert.equal(p.edit.clips[0].out, null, 'an untrimmed clip stays untrimmed when saved again');
  assert.throws(() => applyOps(p, [{ op: 'set_edit', clips: [{ shotId: s2.id, assetId: 'r1' }] }]), /does not belong/);
});

const ff = spawnSync(process.env.PREVIS_FFMPEG || 'ffmpeg', ['-version']).status === 0;
test('exporting stitches trimmed clips into one conformed video', { skip: !ff && 'ffmpeg not installed' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'previs-edit-'));
  const director = await openDirector(root);
  const p = await director.create({ template: 'street' });
  await director.edit(p.id, [{ op: 'add_shot', shot: { title: 'Two' } }]);
  const q = await director.get(p.id);
  const made = [];
  for (const [i, s] of q.shots.entries()) {
    const id = crypto.randomUUID(), file = join(root, 'director', p.id, 'assets', id + '.mp4');
    await mkdir(join(root, 'director', p.id, 'assets'), { recursive: true });
    // 2 s test clips at different sizes to prove conforming.
    spawnSync(process.env.PREVIS_FFMPEG || 'ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${i ? '640x360' : '1280x720'}:rate=24:duration=2`, '-pix_fmt', 'yuv420p', file]);
    made.push({ id, kind: 'camera-render', shotId: s.id, file: `assets/${id}.mp4`, mime: 'video/mp4', duration: 2, createdAt: new Date().toISOString() });
  }
  // Inject the fixtures, then trim the second clip.
  const raw = await director.get(p.id);
  await director.edit(p.id, []); // touch
  const store = JSON.parse(JSON.stringify(raw)); store.assets = made;
  await import('node:fs/promises').then(fs => fs.writeFile(join(root, 'director', p.id, 'project.json'), JSON.stringify(store)));
  const fresh = await openDirector(root);
  await fresh.edit(p.id, [{ op: 'set_edit', clips: [{ shotId: store.shots[0].id }, { shotId: store.shots[1].id, in: 0.5, out: 1.5 }] }]);
  const { asset } = await fresh.exportEdit(p.id);
  assert.equal(asset.kind, 'edit'); assert.equal(asset.width, 1280); assert.equal(asset.height, 720);
  assert.equal(asset.frameCount, 72, '2 s + 1 s at 24 fps');
  assert.ok((await readdir(join(root, 'director', p.id, 'assets'))).includes(asset.id + '.mp4'));
  await assert.rejects(fresh.edit(p.id, [{ op: 'add_shot', shot: { title: 'Three' } }]).then(() => fresh.edit(p.id, [{ op: 'set_edit', clips: [] }])).then(() => fresh.exportEdit(p.id)), /Render these shots before exporting: 3/);
});
