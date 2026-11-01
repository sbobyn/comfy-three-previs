// Coplanar surfaces (z-fighting) in blockouts: the lint (shared/blockout-lint.mjs), the gate over every bundled GLB and
// starter, and where it is enforced (agent/MCP edits, library place and import, Blender import). Rules and why:
// docs/blockout-modeling-rules.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPLANAR, parseGlb, lintMesh, lintScene, findCoplanar, describeFinding, offsetFix, entityTriangles } from '../shared/blockout-lint.mjs';
import { BLOCKOUT_MODELS, isDecalMaterial } from '../shared/blockout-models.mjs';
import { loadStarters } from '../server/previs/starters.mjs';
import { lintBundled, bundledMesh, fixCoplanar, sceneAfterOps, changedIds, geometryOf } from '../server/previs/coplanar.mjs';
import { handoffToOps } from '../server/previs/blender-import.mjs';
import { openDirector, directorRoutes, createProjectDocument } from '../server/previs/director.mjs';
import { readAssetBundle, bundleWarnings } from '../server/previs/library.mjs';

const E = (id, shape, position, scale, color, extra = {}) => ({ id, name: id, shape, position, rotation: 0, scale, color, ...extra });
const FLOOR = E('floor', 'box', [0, 0, 0], [10, 0.1, 10], '#333333');
const quad = (y, x0, x1, z0, z1) => [[[x0, y, z0], [x0, y, z1], [x1, y, z1]], [[x0, y, z0], [x1, y, z1], [x1, y, z0]]]; // facing +y

test('every bundled GLB and every starter is free of coplanar overlaps (at proxy size and at every starter scale)', async () => {
  const findings = lintBundled(await loadStarters());
  assert.deepEqual(findings.map(f => `${f.where}: ${f.text}`), []);
  // The gate really looked at every model.
  for (const id of Object.keys(BLOCKOUT_MODELS)) assert.ok(bundledMesh(id)?.length, `${id}.glb parsed`);
});

test('decal parts use -decal materials and keep their gap from the surface below', () => {
  const decals = Object.keys(BLOCKOUT_MODELS).filter(id => bundledMesh(id).some(p => isDecalMaterial(p.material)));
  for (const id of ['track', 'court', 'paint', 'finish', 'studio-floor', 'grass', 'river', 'lake', 'backboard', 'screen', 'video-wall', 'barrier', 'press-box']) assert.ok(decals.includes(id), `${id} has decal parts`);
  // The track's lines sit at least the decal offset above its asphalt at the thinnest starter scale (8 cm tall).
  const track = bundledMesh('track'), top = p => Math.max(...p.triangles.flat().map(v => v[1])), low = p => Math.min(...p.triangles.flat().map(v => v[1]));
  const asphalt = track.find(p => p.material === 'entity-color'), lines = track.filter(p => isDecalMaterial(p.material));
  for (const l of lines) assert.ok((low(l) - top(asphalt)) * 0.08 >= COPLANAR.decalOffset, `${l.material}: ${(low(l) - top(asphalt)) * 80} mm`);
});

test('the lint finds flush decals, overlapping boxes and capped walls; ignores identical surfaces, bases and lifted decals', () => {
  const at = (y, extra) => E('decal', 'box', [0, y, 0], [2, 0.01, 2], '#ffffff', extra);
  const flush = lintScene([FLOOR, at(0.09)]);
  assert.equal(flush.length, 1); assert.deepEqual(flush[0].normal, [0, 1, 0]); assert.equal(flush[0].area, 4);
  assert.match(describeFinding(flush[0], { floor: 'Floor', decal: 'Decal' }), /“Decal” and “Floor” share a surface on one plane \(facing \+y, 4 m² overlap .*z-fight.*2 mm along its normal/);
  assert.equal(lintScene([FLOOR, at(0.0905)]).length, 1, '0.5 mm is the same plane');
  assert.equal(lintScene([FLOOR, at(0.093)]).length, 0, 'lifted 3 mm');
  assert.equal(lintScene([FLOOR, at(0.09, { color: '#333333' })]).length, 0, 'same colour, same material: draws the same pixel whichever wins');
  assert.equal(lintScene([E('a', 'box', [0, 0, 0], [2, 1, 2], '#ff0000'), E('b', 'box', [0, 0, 0], [2, 0.5, 2], '#0000ff', { rotation: 45 })]).length, 0, 'two bases on one floor are hidden by it');
  const boxes = lintScene([E('a', 'box', [0, 0, 0], [2, 1, 2], '#ff0000'), E('b', 'box', [1, 0, 0], [2, 1, 2], '#0000ff')]);
  assert.deepEqual(boxes.map(f => f.normal.join()).sort(), ['0,0,-1', '0,0,1', '0,1,0'], 'top and both shared sides');
  // Pitch and roll: a tilted panel with a flush sticker is still caught; one lifted 3 mm is not.
  const ramp = E('ramp', 'box', [0, 0, 0], [4, 0.2, 4], '#555555', { pitch: 20, roll: 5 });
  const sticker = lintScene([ramp, { ...ramp, id: 'sticker', scale: [1, 0.2, 1], color: '#ffff00' }]);
  assert.ok(sticker.some(f => f.normal[1] > 0.9 && f.normal[1] < 0.99), 'the tilted top face');
  assert.equal(lintScene([ramp, { ...ramp, id: 'sticker', position: [0, 0.003, 0], scale: [1, 0.2, 1], color: '#ffff00' }]).filter(f => f.normal[1] > 0).length, 0, 'lifted 3 mm');
  // The reported Final Lap artefact: a dark cap exactly as wide as the wall body under it.
  const box = (x0, x1, y0, y1, z0, z1) => entityTriangles(E('m', 'box', [0, y0, 0], [x1 - x0, y1 - y0, z1 - z0], '#000000'));
  const cap = [{ material: 'entity-color', color: '#ffffff', triangles: box(-0.5, 0.5, 0, 1, -0.5, 0.5).map(t => t.v) }, { material: 'charcoal', color: '#202932', triangles: box(-0.5, 0.5, 0.87, 0.99, -0.5, 0.5).map(t => t.v) }];
  assert.deepEqual(lintMesh(cap, { scale: [40.2, 1.2, 0.4] }).map(f => f.normal.join()).sort(), ['-1,0,0', '0,0,-1', '0,0,1', '1,0,0']);
  // Inside one mesh only different-looking parts count.
  assert.equal(findCoplanar([{ v: quad(1, 0, 1, 0, 1)[0], owner: 'm', look: 'a' }, { v: quad(1, 0, 1, 0, 1)[0], owner: 'm', look: 'a' }]).length, 0);
  assert.equal(findCoplanar([{ v: quad(1, 0, 1, 0, 1)[0], owner: 'm', look: 'a' }, { v: quad(1, 0.5, 2, 0, 1)[0], owner: 'm', look: 'b' }]).length, 1);
  assert.equal(findCoplanar([{ v: quad(1, 0, 1, 0, 1)[0], owner: 'm', look: 'a' }, { v: quad(1, 1, 2, 0, 1)[0], owner: 'm', look: 'b' }]).length, 0, 'a shared edge is not an overlap');
});

test('the bundled GLB parser reads node transforms, indices and materials', () => {
  const parts = parseGlb(readFileSync(fileURLToPath(new URL('../public/models/blockouts/barrier.glb', import.meta.url))));
  assert.deepEqual(parts.map(p => p.material).sort(), ['charcoal', 'entity-color', 'glass-blue-decal']);
  const ys = parts.flatMap(p => p.triangles.flat().map(v => v[1]));
  assert.ok(Math.abs(Math.min(...ys)) < 1e-6 && Math.abs(Math.max(...ys) - 1) < 1e-6, 'fitted to the unit proxy');
  assert.throws(() => parseGlb(Buffer.from('not a glb at all, not at all')), /Not a GLB/);
});

test('offsetFix lifts the thinner static object 2 mm and never moves animated, protected or group objects', () => {
  const decal = E('decal', 'box', [0, 0.09, 0], [2, 0.01, 2], '#ffffff'), [f] = lintScene([FLOOR, decal]);
  assert.deepEqual(offsetFix(f, [FLOOR, decal]), { id: 'decal', position: [0, 0.092, 0] });
  assert.deepEqual(offsetFix(f, [FLOOR, decal], { protect: new Set(['decal']) }), { id: 'floor', position: [0, 0.002, 0] });
  const moving = { ...decal, path: [{ t: 0, p: [0, 0.09, 0] }, { t: 1, p: [1, 0.09, 0] }] };
  assert.equal(offsetFix(f, [{ ...FLOOR, path: moving.path }, moving]), null);
  const fixed = fixCoplanar([FLOOR, decal], { meshOf: bundledMesh, movable: new Set(['decal']) });
  assert.deepEqual([...fixed.moves], [['decal', [0, 0.092, 0]]]); assert.deepEqual(fixed.warnings, []);
  assert.match(fixed.fixed[0], /Lifted “decal” 2 mm off “floor”/);
  assert.equal(lintScene([FLOOR, { ...decal, position: fixed.moves.get('decal') }]).length, 0);
});

test('agent and MCP edits that put an object on another object’s plane get a warning; others do not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'previs-zfight-'));
  try {
    const director = await openDirector(root), route = directorRoutes(director, { get: () => ({}) });
    const post = (path, body) => route('POST', new URL('http://x' + path), body, { agent: true });
    const p = await director.create({ template: 'empty' });
    let r = await post('/api/director/edit', { projectId: p.id, ops: [{ op: 'add_entity', entity: { name: 'Stage floor', shape: 'box', kind: 'environment', position: [0, 0, 0], scale: [10, 0.1, 10], color: '#333333' } }] });
    assert.equal(r.warnings, undefined);
    r = await post('/api/director/edit', { projectId: p.id, ops: [{ op: 'add_entity', entity: { name: 'Finish line', shape: 'box', kind: 'environment', position: [0, 0.05, 0], scale: [1, 0.05, 8], color: '#ffffff' } }] });
    assert.equal(r.warnings.length, 1); assert.match(r.warnings[0], /“(Finish line|Stage floor)” and “(Finish line|Stage floor)” share a surface .*facing \+y.*z-fight/);
    assert.deepEqual(Object.keys(r)[0], 'warnings', 'first, so an agent reads it');
    r = await post('/api/director/edit', { projectId: p.id, ops: [{ op: 'update_entity', id: 'Finish line', patch: { position: [0, 0.052, 0] } }] });
    assert.equal(r.warnings, undefined, 'lifted 2 mm');
    r = await post('/api/director/edit', { projectId: p.id, ops: [{ op: 'update_entity', id: 'Finish line', patch: { notes: 'chequered' } }] });
    assert.equal(r.warnings, undefined, 'edits that move nothing are not re-checked');
    // A bundled display mesh is checked with its own surfaces: a lake model's top is not its proxy's top.
    const before = geometryOf(r.project.scene.entities), after = sceneAfterOps(r.project.scene.entities, [{ op: 'update_entity', id: r.project.scene.entities[0].id, patch: { scale: [10, 0.2, 10] } }]);
    assert.deepEqual([...changedIds(before, after)], [r.project.scene.entities[0].id]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('library: placing an asset flush on a floor lifts it 2 mm; importing a bundle with an overlap warns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'previs-zfight-lib-'));
  try {
    const director = await openDirector(root);
    const src = await director.create({ template: 'empty' });
    await director.edit(src.id, [{ op: 'add_entity', entity: { name: 'Rug', shape: 'box', kind: 'prop', position: [0, 0, 0], scale: [2, 0.05, 3], color: '#aa3333' } }]);
    await director.library.save(src.id, { object: 'Rug' });
    const q = await director.create({ template: 'empty' });
    await director.edit(q.id, [{ op: 'add_entity', entity: { name: 'Stage floor', shape: 'box', kind: 'environment', position: [0, 0, 0], scale: [10, 0.1, 10], color: '#333333' } }]);
    const placed = await director.library.place(q.id, { asset: '@rug', position: [1, 0.05, 1] });
    assert.match(placed.warnings[0], /Lifted “Rug” 2 mm off “Stage floor”/);
    assert.deepEqual(placed.project.scene.entities.find(e => e.id === placed.root).position, [1, 0.052, 1]);
    // A bundle whose own parts share a plane: reported (the bundle is content-hashed, so nothing is moved).
    const m = { entities: [E('a0000000-0000-4000-8000-000000000001', 'box', [0, 0, 0], [4, 0.1, 4], '#333333'), E('a0000000-0000-4000-8000-000000000002', 'box', [0, 0.09, 0], [1, 0.01, 1], '#ffffff')], media: [] };
    assert.match(bundleWarnings(m, new Map())[0], /share a surface/);
    assert.equal(typeof readAssetBundle, 'function');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Blender import lifts a thin static object off a shared plane and warns about what it cannot lift', async () => {
  const sidecar = JSON.parse(await readFile(fileURLToPath(new URL('./fixtures/blender-handoff/shot.previs-blender/blender-previs.json', import.meta.url)), 'utf8'));
  const object = (name, position, size, color) => ({ name, blenderName: name, cast: false, shape: 'box', color, frames: [{ frame: 1, position, yaw: 0, size }] });
  // Blender Z-up, bottom centre: a 10 × 10 m stage 10 cm thick and a 5 cm mat whose top is flush with it.
  const m = { ...sidecar, warnings: [], objects: [object('Stage', [0, 0, 0], [10, 0.1, 10], '#333333'), object('Mat', [0, 0, 0.05], [2, 0.05, 2], '#aa3333')] };
  const plan = handoffToOps(createProjectDocument({ template: 'empty' }), m);
  const mat = plan.ops.find(o => o.entity?.name === 'Mat').entity;
  assert.deepEqual(mat.position.map(v => Math.round(v * 1e4) / 1e4 + 0), [0, 0.052, 0]);
  assert.ok(plan.warnings.some(w => /Lifted “Mat” 2 mm off “Stage”/.test(w)), plan.warnings.join('\n'));
  // Two crates sharing a top and sides: both are static, so one is lifted and the rest reported or resolved.
  const crates = handoffToOps(createProjectDocument({ template: 'empty' }), { ...sidecar, warnings: [], objects: [object('Crate', [0, 0, 0], [1, 1, 1], '#ff0000'), object('Crate 2', [0.5, 0, 0], [1, 1, 1], '#0000ff')] });
  const scene = sceneAfterOps([], crates.ops);
  assert.equal(lintScene(scene, { meshOf: bundledMesh }).length, 0, crates.warnings.join('\n'));
});
