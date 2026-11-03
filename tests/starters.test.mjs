import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createProjectDocument, openDirector } from '../server/previs/director.mjs';
import { loadStarters, starterSnapshot, instantiateStarter, attachStarterMedia, starterCard, MODEL_BASE } from '../server/previs/starters.mjs';
import { shotSignature } from '../shared/director.mjs';
import { projectMesh } from '../shared/blockout-models.mjs';
import { FINISHED_STARTERS, BLOCKOUT_STARTERS, LOOK_LAB_VIDEOS, LOOK_LAB_STILL_MODELS, BLOCKOUT_TAKES } from './helpers/starters.mjs';

test('starter snapshots load in launch-page order, carry no absolute paths, and list media that is present', async () => {
  const starters = await loadStarters();
  assert.deepEqual(starters.map(s => s.slug), [...FINISHED_STARTERS, ...BLOCKOUT_STARTERS]);
  for (const s of starters) {
    const text = JSON.stringify(s);
    assert.ok(!/"\/(Users|home)\//.test(text), `${s.slug} has an absolute path`);
    assert.equal(s.version, 2);
    for (const shot of s.shots) assert.equal(shot.render, undefined, `${s.slug} shot keeps render`);
    // Every listed file is on disk with the recorded hash, and every image or clip the snapshot uses is listed.
    for (const m of s.media) {
      assert.match(m.path, /^media\/(refs\/[a-f0-9-]{36}\.(webp|glb)|assets\/[a-f0-9-]{36}\.mp4)$/);
      assert.equal(m.from, undefined);
      assert.equal(createHash('sha256').update(readFileSync(join(s.dir, m.path))).digest('hex'), m.sha256, `${s.slug} ${m.path}`);
    }
    const listed = new Set(s.media.map(m => m.path));
    for (const r of [...s.scene.references, ...s.shots.flatMap(x => x.references)]) assert.ok(listed.has(`media/refs/${r.file}`), `${s.slug} ${r.name}`);
    for (const a of s.assets) assert.ok(listed.has(`media/${a.file}`), `${s.slug} ${a.id}`);
    // An imported model ships its GLB and points at the placeholder project, never at a real one.
    for (const e of s.scene.entities.filter(x => projectMesh(x.model))) { assert.ok(e.model.startsWith(MODEL_BASE), `${s.slug}: ${e.name}`); assert.ok(listed.has(`media/refs/${e.model.split('/').pop()}`), `${s.slug}: ${e.name} model file`); }
    if (BLOCKOUT_STARTERS.includes(s.slug)) {
      // A blockout starter: every shot has its blockout clip, or shares the exact blocking of a shot that has one (Look Lab's
      // variants); no stills or videos (Look Lab: one current start still per shot, videos for LOOK_LAB_VIDEOS only); every
      // shot's subject has a written Cast Card.
      const clipped = new Set(s.assets.filter(a => a.kind === 'camera-render').map(a => a.shotId)), lookLab = s.slug === 'look-lab';
      for (const shot of s.shots) {
        assert.ok(clipped.has(shot.id) || s.shots.some(o => clipped.has(o.id) && shotSignature(s, o) === shotSignature(s, shot)), `${s.slug} ${shot.title} has no blockout clip`);
        assert.ok(shot.duration >= 4 && shot.duration <= 5);
        assert.ok((s.scene.entities.find(e => e.id === shot.camera.target)?.notes || '').trim(), `${s.slug} ${shot.title}: its subject has no Cast Card`);
        if (!lookLab && !(BLOCKOUT_TAKES[s.slug] || []).includes(shot.title)) { assert.equal(shot.references.length, 0, `${s.slug} ${shot.title}: no stills`); continue; }
        assert.equal(shot.references.length, 1, `${shot.title}: one still`);
        const [still] = shot.references;
        assert.equal(still.role, 'frame'); assert.equal(still.note, 'key frame start');
        assert.equal(still.generated?.signature, shotSignature(s, shot), `${shot.title}: the still shows the current blocking`);
        if (lookLab) assert.equal(still.generated?.presetId, LOOK_LAB_STILL_MODELS[shot.title] || 'gpt-image-25', shot.title);
        assert.equal(still.generated?.regen, undefined, `${shot.title}: no manifest ships`);
      }
      const videos = s.assets.filter(a => a.kind === 'workflow-result');
      if (!lookLab && !BLOCKOUT_TAKES[s.slug]) assert.ok(!videos.length && !s.edit.clips.length, `${s.slug}: no generated media`);
      else {
        assert.deepEqual(videos.map(v => s.shots.find(x => x.id === v.shotId).title).sort(), lookLab ? LOOK_LAB_VIDEOS : [...BLOCKOUT_TAKES[s.slug]].sort(), `${s.slug} videos`);
        // Each video is in the cut and points at its own shot's blockout clip, which shows the current blocking.
        assert.deepEqual(s.edit.clips.map(c => c.assetId).sort(), videos.map(v => v.id).sort());
        for (const v of videos) { const b = s.assets.find(a => a.id === v.source.sourceAssetId); assert.equal(b?.kind, 'camera-render'); assert.equal(b.shotId, v.shotId); assert.equal(b.source.signature, shotSignature(s, s.shots.find(x => x.id === v.shotId))); }
      }
      for (const e of s.scene.entities.filter(x => x.kind === 'character' && x.shape !== 'group')) assert.ok((e.notes || '').trim() || e.lookFrom, `${s.slug}: ${e.name} has no Cast Card`);
      continue;
    }
    // Each shot opens finished: a still, a blockout clip and a chosen video in the cut.
    for (const shot of s.shots) {
      assert.ok(shot.references.some(r => r.role === 'frame'), `${s.slug} ${shot.title} has no still`);
      assert.ok(s.assets.some(a => a.shotId === shot.id && a.kind === 'camera-render'), `${s.slug} ${shot.title} has no blockout clip`);
      assert.ok(s.edit.clips.some(c => c.shotId === shot.id && s.assets.some(a => a.id === c.assetId && a.kind === 'workflow-result')), `${s.slug} ${shot.title} has no video`);
    }
    // Hero cast (not set pieces) always has an image.
    for (const e of s.scene.entities.filter(x => x.kind !== 'environment' && x.shape !== 'group')) {
      let src = e; for (let i = 0; src.lookFrom && i < 4; i++) src = s.scene.entities.find(x => x.id === src.lookFrom);
      assert.ok(src.look || s.scene.references.some(r => r.entityId === src.id) || !(src.notes || '').trim(), `${s.slug}: ${e.name} has no image`);
    }
  }
  const total = starters.reduce((n, s) => n + s.media.reduce((a, m) => a + m.bytes, 0), 0);
  assert.ok(total <= 80 * 1024 * 1024, `starter media is ${total} bytes`);
});

test('a project from a starter gets its media copied in, with fresh ids, and copying again changes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'starter-media-'));
  try {
    const director = await openDirector(root);
    const { project: p } = { project: await director.create({ template: 'final-lap' }) };
    const snap = (await loadStarters()).find(s => s.slug === 'final-lap');
    assert.equal(p.scene.references.length, snap.scene.references.length);
    assert.equal(p.assets.length, snap.assets.length);
    assert.equal(p.edit.clips.length, snap.shots.length);
    const all = [...p.scene.references.map(r => `refs/${r.file}`), ...p.shots.flatMap(s => s.references.map(r => `refs/${r.file}`)), ...p.assets.map(a => a.file)];
    for (const f of all) assert.ok(existsSync(join(root, 'director', p.id, f)), f);
    assert.ok(!p.assets.some(a => snap.assets.some(x => x.id === a.id)), 'asset ids are fresh');
    assert.ok(!p.scene.references.some(r => snap.scene.references.some(x => x.id === r.id)), 'image ids are fresh');
    for (const e of p.scene.entities) if (e.look) assert.ok(p.scene.references.some(r => r.id === e.look && r.entityId === e.id));
    for (const e of p.scene.entities) for (const sh of e.sheets || []) for (const sl of sh.slots) assert.ok(p.scene.references.some(r => r.id === sl.attempts[0].referenceId), `${e.name} sheet slot`);
    for (const c of p.edit.clips) assert.equal(p.assets.find(a => a.id === c.assetId)?.shotId, c.shotId);
    // Each chosen video still points at the blockout clip it was made from (Compare and the seam pair them).
    for (const c of p.edit.clips) { const v = p.assets.find(a => a.id === c.assetId), b = p.assets.find(a => a.id === v.source.sourceAssetId); assert.equal(b?.kind, 'camera-render', `shot ${c.shotId}`); assert.equal(b.shotId, c.shotId); }
    const trims = p.edit.clips.map(c => c.out);
    assert.deepEqual(trims, snap.edit.clips.map(c => c.out));
    // Idempotent: attaching the same files again copies nothing.
    const files = [...p.scene.references.map(r => ({ to: `refs/${r.file}` }))].map(f => ({ ...f, from: 'missing-on-purpose' }));
    assert.equal(await attachStarterMedia(snap.dir, join(root, 'director', p.id), files), 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a starter with an imported model copies its GLB into the new project and points the object at it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'starter-model-'));
  try {
    const director = await openDirector(root);
    const p = await director.create({ template: 'mountain-trail' });
    const hiker = p.scene.entities.find(e => e.name === 'Hiker'), file = hiker.model.split('/').pop();
    assert.equal(hiker.model, `/director-refs/${p.id}/${file}`);
    assert.ok(existsSync(join(root, 'director', p.id, 'refs', file)), 'the GLB is in the project folder');
    assert.equal(hiker.perform.clip, 'Walk'); assert.ok(hiker.source.rig?.humanoid, 'rig and clips survive');
    // Without its media the object falls back to its proxy shape (no dangling model URL).
    const bare = instantiateStarter((await loadStarters()).find(s => s.slug === 'mountain-trail'), { has: () => false, projectId: p.id });
    assert.equal(bare.scene.entities.find(e => e.name === 'Hiker').model, undefined);
    // The launch page cannot load bundle files: its thumbnail draws the proxy.
    assert.ok(starterCard((await loadStarters()).find(s => s.slug === 'mountain-trail')).scene.entities.every(e => !projectMesh(e.model)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Look Lab variants keep their prompt sections in every copy, keyed to the copy’s walker', async () => {
  const snap = (await loadStarters()).find(s => s.slug === 'look-lab'), copy = instantiateStarter(snap);
  const walker = copy.scene.entities.find(e => e.name === 'Walker');
  assert.equal(new Set(copy.shots.map(s => shotSignature(copy, s))).size, 1, 'one blocking for every variant');
  for (const [i, sh] of copy.shots.entries()) {
    assert.deepEqual(Object.keys(sh.promptSections?.video || {}).sort(), Object.keys(sh.promptSections?.image || {}).sort(), sh.title);
    for (const key of Object.keys(sh.promptSections?.video || {})) if (key.startsWith('obj:')) assert.equal(key, `obj:${walker.id}`);
    assert.equal(!!sh.promptSections, i > 0, `${sh.title}: only the base variant inherits everything`);
  }
});

test('a starter whose media is missing still opens, without the missing images or videos', async () => {
  const snap = (await loadStarters()).find(s => s.slug === 'wingspan');
  const x = instantiateStarter(snap, { has: path => path.endsWith('.webp') });
  assert.equal(x.assets, undefined); assert.equal(x.edit, undefined);
  assert.ok(x.scene.references.length > 0);
  const none = instantiateStarter(snap, { has: () => false });
  assert.equal(none.scene.references, undefined);
  assert.ok(none.scene.entities.every(e => !e.look && !e.sheets));
  assert.ok(none.shots.every(s => s.references.length === 0));
  assert.deepEqual(none.files, []);
});

test('creating from a starter deep-copies it with fresh, consistent ids', async () => {
  const starters = await loadStarters();
  const snap = starters.find(s => s.slug === 'final-lap');
  const a = createProjectDocument({ template: 'final-lap' }, undefined, starters);
  const b = createProjectDocument({ template: 'final-lap', title: 'Mine' }, undefined, starters);
  assert.equal(a.title, 'Final Lap'); assert.equal(b.title, 'Mine'); assert.equal(a.template, 'final-lap');
  assert.equal(a.scene.entities.length, snap.scene.entities.length);
  assert.equal(a.shots.length, snap.shots.length);
  const ids = new Set(a.scene.entities.map(e => e.id));
  assert.ok(!a.scene.entities.some(e => snap.scene.entities.some(x => x.id === e.id)), 'ids are fresh');
  assert.ok(!a.scene.entities.some(e => b.scene.entities.some(x => x.id === e.id)), 'projects do not share ids');
  for (const e of a.scene.entities) { if (e.parent) assert.ok(ids.has(e.parent)); if (e.lookFrom) assert.ok(ids.has(e.lookFrom)); }
  a.shots.forEach((s, i) => {
    const t = snap.shots[i].camera.target;
    if (t) assert.equal(a.scene.entities.find(e => e.id === s.camera.target)?.name, snap.scene.entities.find(e => e.id === t).name);
    for (const id of [...s.cast.include, ...s.cast.exclude]) assert.ok(ids.has(id));
  });
  assert.equal(a.scene.entities.filter(e => e.parent).length, snap.scene.entities.filter(e => e.parent).length, 'groups survive');
  // Mutating the copy never touches the snapshot.
  a.scene.entities[0].name = 'changed';
  assert.notEqual(snap.scene.entities[0].name, 'changed');
});

test('unknown templates still fall back to the empty stage; built-in blockouts still work', () => {
  assert.equal(createProjectDocument({ template: 'nope' }, undefined, []).template, 'empty');
  assert.equal(createProjectDocument({ template: 'street' }).template, 'street');
});

test('version 1 snapshots (media: false) strip renders, references and looks from a project', () => {
  const p = createProjectDocument({ template: 'street' });
  p.shots[0].render = { file: '/abs/x.mp4' }; p.shots[0].references = [{ id: 'r' }]; p.scene.entities[0].look = 'r';
  const s = starterSnapshot(p, { slug: 'x', title: 'X', description: 'd', media: false });
  assert.equal(s.shots[0].render, undefined); assert.equal(s.shots[0].references, undefined); assert.equal(s.scene.entities[0].look, undefined);
  assert.equal(s.format, 'comfy-previs-starter'); assert.equal(s.version, 1); assert.deepEqual(s.media, []);
});

test('update_entity with sheets: [] removes an object’s design sheets', async () => {
  const { applyOps } = await import('../server/previs/director.mjs');
  const p = structuredClone((await loadStarters()).find(s => s.slug === 'final-lap'));
  const doc = createProjectDocument({ template: 'final-lap' }, undefined, [Object.assign(p, {})]);
  const car = doc.scene.entities.find(e => e.name === 'Comfy car');
  car.sheets = [{ id: 'sabc', setId: 'obj-turn4', label: 'T', options: {}, presetId: 'flux-2-pro', createdAt: new Date().toISOString(), slots: [] }];
  applyOps(doc, [{ op: 'update_entity', id: car.id, patch: { sheets: [] } }]);
  assert.equal(car.sheets, undefined);
  applyOps(doc, [{ op: 'update_entity', id: car.id, patch: { notes: 'blue' } }]);
  assert.equal(car.notes, 'blue');
});
