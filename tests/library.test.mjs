import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDirector, applyOps } from '../server/previs/director.mjs';
import { openLibrary, resolveAssetRef, LIMITS } from '../server/previs/library.mjs';
import { castCard, compilePrompt, entitySize, handleOf, shotSignature } from '../shared/director.mjs';

// The reusable asset library, phase 1: save an object with its Cast Card, look and design sheet, list and find it by
// @handle, and place it into another project through applyOps (.evidence/REUSABLE-ASSETS-DESIGN-20261031.md).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const png = n => Buffer.concat([PNG, Buffer.from(`variant ${n}`)]).toString('base64'); // distinct bytes, still sniffed as PNG
const sha = b => createHash('sha256').update(b).digest('hex');
const CAR = 'c0000000-0000-4000-8000-000000000001', RIVAL = 'c0000000-0000-4000-8000-000000000002';
const CREW = 'c0000000-0000-4000-8000-000000000003', MECH1 = 'c0000000-0000-4000-8000-000000000004', MECH2 = 'c0000000-0000-4000-8000-000000000005';
const REQUEST = 'feed0000-0000-4000-8000-00000000beef';

const withDir = async fn => { const root = await mkdtemp(join(tmpdir(), 'previs-library-')); try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); } };

/** A Final Lap project: a red racecar with a generated look and a 3-view sheet (plus its composed board), a rival
 *  car sharing its look, and a pit crew group whose second mechanic shares the first one's look. */
async function finalLap(director) {
  const p = await director.create({ template: 'empty', title: 'Final Lap' });
  await director.edit(p.id, [
    { op: 'add_entity', entity: { id: CAR, name: 'Red Racecar', shape: 'car', kind: 'vehicle', position: [4, 0, -2], rotation: 90, scale: [1, 1, 1.2], color: '#d9534f', notes: 'a low red single-seater with gold wheels', styleNotes: 'glossy paint' } },
    { op: 'add_entity', entity: { id: RIVAL, name: 'Rival car', shape: 'car', kind: 'vehicle', position: [8, 0, -2], lookFrom: CAR, notes: 'number 7' } },
    { op: 'add_entity', entity: { id: MECH1, name: 'Mechanic 1', shape: 'person', kind: 'character', position: [2, 0, 3], notes: 'orange overalls' } },
    { op: 'add_entity', entity: { id: MECH2, name: 'Mechanic 2', shape: 'person', kind: 'character', position: [4, 0, 3], lookFrom: MECH1 } },
    { op: 'group', id: CREW, ids: [MECH1, MECH2], name: 'Pit crew' },
  ]);
  const look = (await director.reference(p.id, { scope: 'object', entityId: CAR, name: 'Red Racecar · FLUX 3', data: png(0), generated: { requestId: REQUEST, outputKey: 'out-1', presetId: 'flux-3', model: 'FLUX 3 Image', seed: 3, prompt: 'a low red single-seater', backend: 'cloud:https://cloud.comfy.org', promptId: 'prompt-123', signature: 'deadbeef' } })).referenceId;
  const views = [];
  for (const n of [1, 2, 3]) views.push((await director.reference(p.id, { scope: 'object', entityId: CAR, name: `view ${n}`, data: png(n) })).referenceId);
  const board = (await director.reference(p.id, { scope: 'object', entityId: CAR, name: 'sheet', note: 'sheet:sh1:composed', data: png(9) })).referenceId;
  const slot = (id, n) => ({ id, label: id, spec: { framing: 'whole', angle: id }, attempts: [{ id: `a${n}`, requestId: REQUEST, referenceId: views[n], mode: 'generate', note: '', from: null, presetId: 'flux-3', seed: n, error: '', createdAt: '2026-10-31T10:00:00.000Z' }], selected: `a${n}`, accepted: null });
  const sheets = [{ id: 'sh1', setId: 'obj-turn4', label: 'Turnaround · 3', options: {}, presetId: 'flux-3', createdAt: '2026-10-31T10:00:00.000Z', slots: [slot('front', 0), slot('left', 1), slot('back', 2)] }];
  await director.edit(p.id, [{ op: 'update_entity', id: CAR, patch: { sheets } }, { op: 'set_look', entityId: CAR, referenceId: look }]);
  const mechLook = (await director.reference(p.id, { scope: 'object', entityId: MECH1, name: 'mechanic', data: png(20) })).referenceId;
  return { p: await director.get(p.id), look, views, board, mechLook };
}

test('save → place keeps the Cast Card, look and design sheet; the shot prompt lists the placed object', async () => {
  await withDir(async root => {
    const director = await openDirector(root);
    const { p, look, views, board } = await finalLap(director);
    const saved = await director.library.save(p.id, { object: '@red-racecar', tags: ['Car', 'race', 'hero'] });
    assert.equal(saved.action, 'added');
    assert.equal(saved.text, 'Saved @red-racecar v1 with 1 look and a 3-view sheet');
    const a = saved.asset;
    assert.equal(a.handle, 'red-racecar'); assert.equal(a.version, 1); assert.deepEqual(a.tags, ['car', 'race', 'hero']);
    assert.equal(a.description, 'a low red single-seater with gold wheels');
    assert.deepEqual(a.footprint, entitySize(p.scene.entities.find(e => e.id === CAR)).map(v => Math.round(v * 1000) / 1000));
    assert.equal(a.hasLook, true); assert.equal(a.hasSheet, true); assert.equal(a.sheetViews, 3);
    assert.match(a.thumb, new RegExp(`^/library-refs/${a.id}/${look}\\.png$`));
    const m = JSON.parse(await readFile(join(root, 'library', 'assets', a.id, 'asset.json'), 'utf8'));
    assert.deepEqual(m.entities[0].position, [0, 0, 0], 'root sits at the origin'); assert.equal(m.entities[0].rotation, 90, 'its own yaw is kept');
    assert.deepEqual(m.media.map(x => x.path).sort(), [look, ...views, board].map(id => `refs/${id}.png`).sort());
    assert.deepEqual(m.references.find(r => r.id === look).generated, { presetId: 'flux-3', model: 'FLUX 3 Image', seed: 3, prompt: 'a low red single-seater' });

    // Into another project, at the start line, joining shot 1's cast.
    const q0 = await director.create({ template: 'street', title: 'Night race' });
    const placed = await director.library.place(q0.id, { asset: '@red-racecar', position: [10, 0, 5], shot: '1' });
    const q = placed.project, car = q.scene.entities.find(e => e.id === placed.root);
    assert.equal(placed.handle, 'red-racecar'); assert.equal(car.name, 'Red Racecar');
    assert.deepEqual(car.position, [10, 0, 5]); assert.equal(car.rotation, 90); assert.deepEqual(car.scale, [1, 1, 1.2]);
    assert.deepEqual(car.from, { asset: a.id, version: 1, handle: 'red-racecar' });
    const card = castCard(q, car.id), src = castCard(p, CAR);
    assert.equal(card.description, src.description); assert.equal(card.styleNotes, src.styleNotes);
    const newLook = q.scene.references.find(r => r.id === car.look);
    assert.equal(newLook.entityId, car.id); assert.equal(card.imageRefs[0], newLook.id);
    assert.equal(sha(await readFile(join(root, 'director', q.id, 'refs', newLook.file))), sha(await readFile(join(root, 'director', p.id, 'refs', `${look}.png`))));
    const slots = car.sheets[0].slots;
    assert.equal(slots.length, 3);
    for (const [i, s] of slots.entries()) {
      const r = q.scene.references.find(x => x.id === s.attempts[0].referenceId);
      assert.ok(r && r.entityId === car.id, `slot ${i} points at a copied image`);
      assert.equal(s.attempts[0].requestId, null);
      assert.equal(sha(await readFile(join(root, 'director', q.id, 'refs', r.file))), sha(await readFile(join(root, 'director', p.id, 'refs', `${views[i]}.png`))));
    }
    assert.ok(q.scene.references.some(r => r.entityId === car.id && r.note === 'sheet:sh1:composed'), 'the composed board comes along');
    assert.ok(q.shots[0].cast.include.includes(car.id));
    assert.match(compilePrompt(q, q.shots[0]), /Red Racecar \(vehicle, a low red single-seater with gold wheels\)/);

    // A second copy answers to a new handle, and the reply says so.
    const again = await director.library.place(q.id, { asset: 'Red Racecar', position: [10, 0, 9] });
    assert.equal(again.handle, 'red-racecar-2'); assert.match(again.text, /@red-racecar-2 .*@red-racecar was taken/);
  });
});

test('a group saves with everything under it; placing rotates it rigidly and keeps looks shared inside the group', async () => {
  await withDir(async root => {
    const director = await openDirector(root);
    const { p } = await finalLap(director);
    const { asset } = await director.library.save(p.id, { object: 'Pit crew' });
    assert.equal(asset.objects, 3); assert.equal(asset.shape, 'group');
    const m = await director.library.get('@pit-crew');
    assert.deepEqual(m.entities.map(e => e.position), [[0, 0, 0], [-1, 0, 0], [1, 0, 0]]);
    assert.equal(m.entities[2].lookFrom, MECH1, 'a look shared inside the asset stays shared');
    const q0 = await director.create({ template: 'empty' });
    const r = await director.library.place(q0.id, { asset: 'pit-crew', position: [5, 0, 5], rotation: 90, shot: 1 });
    const [g, a, b] = r.entityIds.map(id => r.project.scene.entities.find(e => e.id === id));
    assert.equal(g.shape, 'group'); assert.equal(a.parent, g.id); assert.equal(b.parent, g.id);
    assert.deepEqual(a.position.map(v => Math.round(v * 1000) / 1000), [5, 0, 6]);
    assert.deepEqual(b.position.map(v => Math.round(v * 1000) / 1000), [5, 0, 4]);
    assert.equal(b.lookFrom, a.id);
    assert.equal(castCard(r.project, b.id).imageRefs[0], a.look);
    assert.deepEqual(r.project.shots[0].cast.include.sort(), [a.id, b.id].sort(), 'a group joins a cast through its members');
  });
});

test('a look shared from outside the asset is copied in, so the asset never depends on another object', async () => {
  await withDir(async root => {
    const director = await openDirector(root);
    const { p, look } = await finalLap(director);
    await director.library.save(p.id, { object: RIVAL });
    const m = await director.library.get('rival-car');
    assert.equal(m.entities[0].lookFrom, null); assert.equal(m.entities[0].look, look);
    assert.equal(m.entities[0].notes, castCard(p, RIVAL).description);
    assert.equal(m.entities[0].styleNotes, 'glossy paint');
    assert.equal(m.references[0].entityId, RIVAL);
    const q0 = await director.create({ template: 'empty' });
    const { project: q, root: id } = await director.library.place(q0.id, { asset: 'rival-car' });
    assert.ok(q.scene.references.some(r => r.id === q.scene.entities.find(e => e.id === id).look));
  });
});

test('versions: an unchanged save is a no-op, an edit is the next version, a taken handle needs replace', async () => {
  await withDir(async root => {
    const director = await openDirector(root);
    const { p } = await finalLap(director);
    const v1 = (await director.library.save(p.id, { object: CAR })).asset;
    const same = await director.library.save(p.id, { object: CAR });
    assert.equal(same.action, 'unchanged'); assert.equal(same.asset.version, 1);
    await director.edit(p.id, [{ op: 'update_entity', id: CAR, patch: { notes: 'a low red single-seater, number 1' } }]);
    const v2 = await director.library.save(p.id, { object: CAR });
    assert.equal(v2.action, 'updated'); assert.equal(v2.asset.id, v1.id); assert.equal(v2.asset.version, 2); assert.equal(v2.asset.supersedes, v1.contentHash);
    const old = JSON.parse(await readFile(join(root, 'library', 'assets', v1.id, 'versions', '1.json'), 'utf8'));
    assert.equal(old.contentHash, v1.contentHash);
    await assert.rejects(director.library.save(p.id, { object: RIVAL, name: 'Red Racecar' }), e => e.status === 409 && e.message === '@red-racecar is already in the library; choose another name or save over it with replace: true');
    const v3 = await director.library.save(p.id, { object: RIVAL, name: 'Red Racecar', replace: true });
    assert.equal(v3.asset.id, v1.id); assert.equal(v3.asset.version, 3); assert.equal(v3.asset.origin.entityId, RIVAL);
    // A placed copy saved from another project is the same asset (it carries entity.from), not a collision.
    const q0 = await director.create({ template: 'empty' });
    const placed = await director.library.place(q0.id, { asset: '@red-racecar' });
    await director.edit(q0.id, [{ op: 'update_entity', id: placed.root, patch: { styleNotes: 'matte paint' } }]);
    const v4 = await director.library.save(q0.id, { object: placed.root });
    assert.equal(v4.asset.id, v1.id); assert.equal(v4.asset.version, 4);
    assert.deepEqual((await director.library.list()).assets.map(x => x.handle), ['red-racecar']);
  });
});

test('@handle resolution: id, @handle, name, unique prefix or word; otherwise the nearest handles', () => {
  const lib = ['red-racecar', 'blue-racecar', 'elk-herd', 'pine-tree', 'pit-crew', 'police-car'].map((handle, i) => ({ id: `a000000${i}-0000-4000-8000-000000000000`, handle, name: handle, tags: handle === 'police-car' ? ['red'] : [] }));
  const table = [
    ['a0000002-0000-4000-8000-000000000000', 'elk-herd'],
    ['@red-racecar', 'red-racecar'], ['red-racecar', 'red-racecar'], ['Red Racecar', 'red-racecar'], ['@Red-Racecar', 'red-racecar'], ['  red racecar ', 'red-racecar'],
    ['blue', 'blue-racecar'], ['herd', 'elk-herd'], ['@pine', 'pine-tree'], ['crew', 'pit-crew'],
  ];
  for (const [ref, handle] of table) assert.equal(resolveAssetRef(lib, ref).handle, handle, ref);
  assert.throws(() => resolveAssetRef(lib, 'racecar'), e => e.status === 404 && /matches several library assets\. Nearest: @red-racecar, @blue-racecar/.test(e.message));
  assert.throws(() => resolveAssetRef(lib, 'pi'), /matches several.*@pine-tree, @pit-crew/);
  assert.throws(() => resolveAssetRef(lib, 'redwood'), e => /No library asset is called “redwood”\. Nearest: @red-racecar/.test(e.message) && e.message.split('@').length - 1 === 5);
  assert.throws(() => resolveAssetRef([], '@x'), /library is empty/);
  assert.throws(() => resolveAssetRef(lib, ''), /Name a library asset/);
});

test('provenance (entity.from) never changes a shot signature', async () => {
  await withDir(async root => {
    const director = await openDirector(root);
    const { p } = await finalLap(director);
    await director.library.save(p.id, { object: CAR });
    const q0 = await director.create({ template: 'street' });
    const { project: q, root: id } = await director.library.place(q0.id, { asset: 'red-racecar', position: [1, 0, 1] });
    const s = q.shots[0], before = shotSignature(q, s);
    const bare = structuredClone(q); delete bare.scene.entities.find(e => e.id === id).from;
    assert.equal(shotSignature(bare, s), before);
    const tagged = structuredClone(q); applyOps(tagged, [{ op: 'update_entity', id: tagged.scene.entities[0].id, patch: { from: { asset: '00000000-0000-4000-8000-000000000000', version: 3, handle: 'x' } } }]);
    assert.ok(tagged.scene.entities[0].from); assert.equal(shotSignature(tagged, s), before);
    applyOps(tagged, [{ op: 'update_entity', id, patch: { position: [2, 0, 1] } }]);
    assert.notEqual(shotSignature(tagged, s), before, 'moving it still does');
  });
});

/** A bare project document for library.save unit tests (readRef is passed in). */
function bareProject(entities, references = []) {
  return { id: 'b0000000-0000-4000-8000-000000000000', title: 'Caps', scene: { entities, references, environment: { preset: 'stage', description: '' } }, shots: [] };
}
const ent = (id, extra = {}) => ({ id, name: `Object ${id.slice(-4)}`, kind: 'prop', shape: 'box', position: [0, 0, 0], rotation: 0, scale: [1, 1, 1], color: '#888888', notes: '', look: null, lookFrom: null, styleNotes: '', pitch: 0, roll: 0, path: null, parent: null, ...extra });
const id = n => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('caps: at most 50 objects per asset, images ≤ 10 MB and really images, the bundle cap without ffmpeg', async () => {
  await withDir(async root => {
    const lib = openLibrary(join(root, 'library'));
    const group = ent(id(0), { shape: 'group', name: 'Crowd' });
    const kids = n => Array.from({ length: n }, (_, i) => ent(id(i + 1), { parent: group.id }));
    await assert.rejects(lib.save(bareProject([group, ...kids(50)]), group, {}, () => PNG), /at most 50 objects; Crowd has 51/);
    const ok = await lib.save(bareProject([group, ...kids(49)]), group, {}, () => PNG);
    assert.equal(ok.asset.objects, 50);

    const ref = { id: id(900), name: 'big look', file: `${id(900)}.png`, mime: 'image/png', role: 'prop', entityId: id(100), note: '', createdAt: '' };
    const lone = ent(id(100), { name: 'Big', look: ref.id });
    const big = Buffer.concat([PNG, Buffer.alloc(LIMITS.imageBytes + 1 - PNG.length)]);
    await assert.rejects(lib.save(bareProject([lone], [ref]), lone, {}, () => big), /“big look” is over 10 MB/);
    await assert.rejects(lib.save(bareProject([lone], [ref]), lone, {}, () => Buffer.from('<svg onload=alert(1)>')), /not the PNG, JPEG or WebP image/);
    await assert.rejects(lib.save(bareProject([lone], [ref]), lone, {}, () => { throw Object.assign(Error('gone'), { code: 'ENOENT' }); }), /image file of “big look” is missing/);

    const small = openLibrary(join(root, 'small'), { limits: { ...LIMITS, zipBytes: 64 * 1024 + 10 }, ffmpeg: join(root, 'no-ffmpeg-here') });
    await assert.rejects(small.save(bareProject([lone], [ref]), lone, {}, () => Buffer.concat([PNG, Buffer.alloc(100)])), /over the 0\.06\d* MB limit, and ffmpeg is not available to shrink them: big look 0\.0 MB/);
  });
});

test('over the bundle cap, images are shrunk to WebP when ffmpeg is present', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'ffmpeg not installed' }, async () => {
  await withDir(async root => {
    const src = join(root, 'big.png');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x960', '-frames:v', '1', src]).status, 0);
    const bytes = await readFile(src);
    const ref = { id: id(901), name: 'board', file: `${id(901)}.png`, mime: 'image/png', role: 'prop', entityId: id(101), note: '', createdAt: '' };
    const lone = ent(id(101), { name: 'Board', look: ref.id });
    const lib = openLibrary(join(root, 'library'), { limits: { ...LIMITS, zipBytes: 64 * 1024 + Math.floor(bytes.length / 2), shrinkPx: 320 } });
    const { asset } = await lib.save(bareProject([lone], [ref]), lone, {}, () => bytes);
    const m = await lib.get(asset.id);
    assert.equal(m.references[0].file, `${id(901)}.webp`); assert.equal(m.references[0].mime, 'image/webp');
    assert.equal(m.media[0].width, 320); assert.equal(m.media[0].height, 240);
    assert.ok(m.media[0].size < bytes.length / 2);
  });
});

test('bundles hold no local paths, job ids or request ids; a path in a Cast Card stops the save', async () => {
  await withDir(async root => {
    const director = await openDirector(root);
    const { p } = await finalLap(director);
    const { asset } = await director.library.save(p.id, { object: CAR });
    const text = await readFile(join(root, 'library', 'assets', asset.id, 'asset.json'), 'utf8');
    for (const secret of [REQUEST, 'out-1', 'prompt-123', 'cloud:https', 'deadbeef', root]) assert.ok(!text.includes(secret), secret);
    for (const key of ['"signature"', '"outputKey"', '"promptId"', '"backend"', '"path"', '"messages"', '"refgen"', '"dir"']) assert.ok(!text.replaceAll('"path": "refs/', '').includes(key), key);
    (function walk(v) { if (typeof v === 'string') assert.doesNotMatch(v, /^\/|^[A-Za-z]:[\\/]|^~/); else if (v && typeof v === 'object') Object.values(v).forEach(walk); })(JSON.parse(text));
    await director.edit(p.id, [{ op: 'update_entity', id: CAR, patch: { styleNotes: '/home/me/secret-film/notes.txt' } }]);
    await assert.rejects(director.library.save(p.id, { object: CAR }), /must not contain local paths \(entities\[0\]\.styleNotes/);
    await director.edit(p.id, [{ op: 'update_entity', id: CAR, patch: { styleNotes: 'C:\\film\\car.txt' } }]);
    await assert.rejects(director.library.save(p.id, { object: CAR }), /must not contain local paths/);
  });
});

test('HTTP routes, /library-refs and the previs_library_* MCP tools: "put @red-racecar at the start line"', async () => {
  await withDir(async dir => {
    const port = 15297, base = `http://127.0.0.1:${port}`;
    const server = spawn(process.execPath, ['server/previs/server.mjs'], { env: { ...process.env, PORT: String(port), PREVIS_DATA_DIR: dir, PREVIS_AGENT: 'off', PREVIS_LIBRARY_DIR: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Comfy Previs:')) resolve(); }); server.once('exit', c => reject(Error('server exited ' + c))); });
    const agent = spawn(process.execPath, ['server/previs/agent.mjs'], { env: { ...process.env, PREVIS_URL: base, PREVIS_MCP_LEGACY: '' }, stdio: ['pipe', 'pipe', 'ignore'] });
    const pending = new Map(); let n = 0;
    createInterface({ input: agent.stdout }).on('line', l => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
    const rpc = (method, params) => new Promise(r => { const i = ++n; pending.set(i, r); agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
    const call = async (name, args) => { const m = await rpc('tools/call', { name, arguments: args }); return { error: m.result.isError, out: m.result.isError ? m.result.content[0].text : JSON.parse(m.result.content[0].text) }; };
    const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
    try {
      const init = (await rpc('initialize', {})).result;
      assert.match(init.instructions, /previs_library_place to put one in the scene \(@handle in the user’s words means a library asset when no object in the scene has that handle\)/);
      const tools = (await rpc('tools/list', {})).result.tools, by = Object.fromEntries(tools.map(t => [t.name, t]));
      for (const t of ['previs_library_list', 'previs_library_save', 'previs_library_place']) { assert.ok(by[t], t); assert.equal(by[t].inputSchema.additionalProperties, false); }
      assert.deepEqual(by.previs_library_place.inputSchema.required, ['projectId', 'asset']);

      const { data: { project: lap } } = await post('/api/director/projects', { template: 'final-lap', title: 'Final Lap' });
      const source = lap.scene.entities.find(e => e.name === 'Comfy car');
      const saved = await call('previs_library_save', { projectId: lap.id, object: '@comfy-car', tags: ['car', 'hero'] });
      assert.equal(saved.error, false, saved.out);
      assert.match(saved.out.text, /^Saved @comfy-car v1 with 1 mesh, 1 look and a \d+-view sheet$/);
      const listed = await call('previs_library_list', { query: 'hero' });
      assert.deepEqual(listed.out.assets.map(a => a.handle), ['comfy-car']);
      assert.equal(listed.out.assets[0].hasSheet, true);
      assert.deepEqual((await call('previs_library_list', { kind: 'character' })).out.assets, []);
      const thumb = (await (await fetch(`${base}/api/director/library`)).json()).assets[0].thumb;
      const served = await fetch(base + thumb);
      assert.equal(served.status, 200); assert.equal(served.headers.get('content-type'), 'image/webp');
      assert.ok((await fetch(`${base}/library-refs/${listed.out.assets[0].id}/..%2Fasset.json`)).status >= 400, 'traversal refused');

      const { data: { project: night } } = await post('/api/director/projects', { template: 'street', title: 'Night race' });
      const placed = await call('previs_library_place', { projectId: night.id, asset: '@comfy-car', position: [0, 0, 6], rotation: 180, shot: '1' });
      assert.equal(placed.error, false, placed.out);
      assert.equal(placed.out.handle, 'comfy-car'); assert.match(placed.out.text, /^Placed @comfy-car v1 at \[0, 0, 6\]$/);
      const viaHttp = await post('/api/director/library/place', { projectId: night.id, asset: 'comfy-car', position: [4, 0, 6] });
      assert.deepEqual(viaHttp.data.ops.filter(o => o.op === 'add_entity').map(o => o.entity.id), viaHttp.data.entityIds, 'the browser gets the ops to redo a Place');
      await post('/api/director/edit', { projectId: night.id, ops: [...viaHttp.data.entityIds].reverse().map(id => ({ op: 'remove_entity', id })) });
      const redone = await post('/api/director/edit', { projectId: night.id, ops: viaHttp.data.ops.filter(o => o.op === 'add_entity') });
      assert.equal(redone.status, 200); assert.ok(redone.data.project.scene.entities.find(e => e.id === viaHttp.data.root).look, 'undo then redo keeps its image');
      const { data: got } = await post('/api/director/get', { projectId: night.id });
      const car = got.project.scene.entities.find(e => e.id === placed.out.root);
      assert.equal(car.model, source.model); assert.equal(car.model, 'race-car');
      assert.equal(car.notes, source.notes); assert.equal(car.sheets.length, source.sheets.length); assert.ok(car.look);
      assert.ok(got.project.shots[0].cast.include.includes(car.id));
      assert.match(got.prompts[got.project.shots[0].id], /Comfy car/);
      assert.equal((await fetch(`${base}/director-refs/${night.id}/${got.project.scene.references.find(r => r.id === car.look).file}`)).status, 200);
      assert.ok(got.project.messages.length >= 1);

      const missing = await call('previs_library_place', { projectId: night.id, asset: '@comfy' });
      assert.equal(missing.error, false, 'a unique prefix still resolves');
      assert.equal(missing.out.handle, 'comfy-car-3');
      const none = await call('previs_library_place', { projectId: night.id, asset: '@red-racecar' });
      assert.equal(none.error, true); assert.match(none.out, /No library asset is called “@red-racecar”\. Nearest: @comfy-car/);
      assert.equal((await post('/api/director/library/save', { projectId: night.id, object: car.id })).status, 200);
      assert.ok(existsSync(join(dir, 'library', 'assets', listed.out.assets[0].id, 'versions', '1.json')), 'saving the placed copy is the next version of the same asset');
      assert.deepEqual(await readdir(join(dir, 'library', 'assets')), [listed.out.assets[0].id]);
    } finally { agent.kill(); server.kill(); await new Promise(r => server.once('exit', r)); }
  });
});
