import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeEntity, makeShot, shotCast } from '../shared/director.mjs';
import { shotProjector, frameLayout, describeFrame, stillPrompt, momentLine, stillReferences, guideMatchScore, followsGuide, retryModelFor, STRONG_GUIDE_MODEL, editsGuide, WEAK_MATCH } from '../shared/still-match.mjs';
import { parseGrade, graderGraph, GRADER_PROMPT } from '../server/previs/still-match.mjs';
import { imagePresets, publicPresets } from '../server/previs/refgen.mjs';
import { openBatches } from '../server/previs/batch.mjs';
import { fakeBackend } from '../server/previs/batch-drivers.mjs';

// A stage with a car (and optional others) and one shot whose camera is given.
function scene(camera, entities = [{ name: 'Hero car', shape: 'car', position: [0, 0, 0], rotation: 90 }], extra = {}) {
  const es = entities.map((e, i) => makeEntity(e, `e${i}`));
  const shot = makeShot({ title: 'Test', duration: 4, camera: { target: 'e0', ...camera }, ...extra }, 's1', 1, es);
  return { project: { scene: { entities: es, environment: { preset: 'stage' }, references: [] }, shots: [shot] }, shot };
}

test('projection: the target lands mid-frame; right, up and depth follow the shot camera', () => {
  const { project, shot } = scene({ move: 'static', angle: 0, distance: 8, height: 1.5, mm: 35 });
  const cam = shotProjector(shot, project.scene.entities, 0);
  assert.equal(Math.round(cam.tanV * 1e5) / 1e5, 0.28125, '35 mm on a 35 mm gauge, 16:9: same lens as shotCast and three.js');
  const look = cam.project(cam.look);
  assert.ok(Math.abs(look.x - 0.5) < 1e-9 && Math.abs(look.y - 0.5) < 1e-9);
  assert.ok(cam.project([cam.look[0] + 1, cam.look[1], cam.look[2]]).x > 0.5, '+x is screen-right for a camera on +z');
  assert.ok(cam.project([cam.look[0], cam.look[1] + 1, cam.look[2]]).y < 0.5, 'up is toward the top');
  assert.ok(Math.abs(cam.project(cam.look).z - Math.hypot(...cam.look.map((v, i) => v - cam.p[i]))) < 1e-9, 'z is depth along the view axis');
  // Agrees with shotCast (the same frustum decides who is in the cast).
  const layout = frameLayout(project, shot, 0);
  assert.deepEqual(layout.items.map(i => i.id), shotCast(project, shot).map(c => c.entity.id));
});

test('layout: headings and the seen side come from the object’s rotation through the camera', () => {
  const at = (rotation, angle) => { const { project, shot } = scene({ move: 'static', angle, distance: 8, height: 1.5 }, [{ name: 'Car', shape: 'car', position: [0, 0, 0], rotation }]); return frameLayout(project, shot, 0).items[0]; };
  assert.equal(at(90, 0).heading, 90, 'facing +x from a camera on +z: screen-right');
  assert.equal(at(90, 0).view, 90, 'and we see its right side');
  assert.equal(at(270, 0).heading, -90);
  assert.equal(at(0, 0).heading, 0, 'facing the camera');
  assert.equal(Math.abs(at(180, 0).heading), 180, 'facing away');
  assert.equal(Math.abs(at(0, 180).view), 180, 'camera behind it');
});

test('a bird keeps its spread-wing bounds and +z heading through the scene model and still prompt', () => {
  const { project, shot } = scene({ move: 'static', angle: 0, distance: 8, height: 3, mm: 40 }, [{ name: 'Eagle', shape: 'bird', position: [0, 3, 0], rotation: 90 }]);
  const item = frameLayout(project, shot).items[0];
  assert.equal(project.scene.entities[0].shape, 'bird');
  assert.equal(item.heading, 90);
  assert.ok(item.size[0] > item.size[2] * 2, 'spread wings are wider than the body is long');
  assert.match(describeFrame(project, shot).text, /Eagle:.*front facing screen-right/);
});

test('camera sentence: fixed cameras give the expected phrases', () => {
  const side = describeFrame(...Object.values(scene({ move: 'static', angle: 0, distance: 8, height: 1.5, mm: 35 }))).text;
  for (const p of ['Camera: First frame of a locked-off shot, 35mm normal lens', 'we see Hero car side-on, from its right side', 'Hero car: centre of frame', 'nose pointing screen-right: a flat side profile with its wheels in a level row, tail lights and rear at the left end, headlights and front at the right end', 'horizon'])
    assert.ok(side.includes(p), `${p}\n— in —\n${side}`);

  const truck = scene({ move: 'truck-right', angle: -90, distance: 8, height: 1.8, mm: 35 }, [{ name: 'Comfy car', shape: 'car', position: [0, 0, 0], rotation: 270 }]);
  const draft = describeFrame(truck.project, truck.shot, 0).text;
  assert.match(draft, /^Camera: First frame of a truck right move, 35mm normal lens; /);
  assert.match(draft, /camera 1\.8 m high, about level with Comfy car's top/);
  assert.match(draft, /looking slightly down/);
  assert.match(describeFrame(truck.project, truck.shot, 4).text, /^Camera: Last frame of a truck right move/);

  const face = describeFrame(...Object.values(scene({ move: 'static', angle: 0, distance: 3, height: 1.65, mm: 50 }, [{ name: 'Anchor', shape: 'person', position: [0, 0, 0], rotation: 0 }]))).text;
  assert.match(face, /at eye level/); assert.match(face, /we see Anchor from straight in front/); assert.match(face, /Anchor: [^.]*facing the camera\./);
  assert.match(face, /medium shot, Anchor from the waist up|medium long shot/);
  const close = describeFrame(...Object.values(scene({ move: 'static', angle: 0, distance: 1.1, height: 1.65, mm: 50 }, [{ name: 'Anchor', shape: 'person', position: [0, 0, 0], rotation: 0 }]))).camera;
  assert.match(close, /close-up/);

  const back = describeFrame(...Object.values(scene({ move: 'static', angle: 180, distance: 5, height: 1.4 }, [{ name: 'Guard', shape: 'person', position: [0, 0, 0], rotation: 0 }]))).text;
  assert.match(back, /from directly behind/); assert.match(back, /back to the camera/); assert.match(back, /just below Guard's eye line/);

  const high = describeFrame(...Object.values(scene({ move: 'static', angle: 30, distance: 6, height: 20 }))).camera;
  assert.match(high, /high above Hero car/); assert.match(high, /looking steeply down|looking straight down/);

  const ground = describeFrame(...Object.values(scene({ move: 'static', angle: 0, distance: 6, height: 0.3 }))).camera;
  assert.match(ground, /camera at ground level/);

  const indoor = scene({ move: 'static', angle: 0, distance: 8, height: 1.5 }); indoor.project.scene.environment.preset = 'interior';
  assert.doesNotMatch(describeFrame(indoor.project, indoor.shot, 0).camera, /horizon/, 'no horizon indoors');
});

test('camera sentence: relations, crops and same heading between objects', () => {
  const { project, shot } = scene({ move: 'static', angle: 0, distance: 6, height: 1.5, mm: 35 }, [
    { name: 'Lead', shape: 'car', position: [1.5, 0, 0], rotation: 90 },
    { name: 'Chaser', shape: 'car', position: [-1.5, 0, -4], rotation: 90 },
  ]);
  const text = describeFrame(project, shot, 0).layout;
  assert.match(text, /Chaser: [^.]*behind Lead to the left/);
  assert.match(text, /same direction as Lead/);
  const crop = scene({ move: 'static', angle: 0, distance: 3, height: 1.5, mm: 35 }, [{ name: 'Big', shape: 'car', position: [1.6, 0, 0], rotation: 90 }]);
  assert.match(describeFrame(crop.project, crop.shot, 0).layout, /cut off by the right edge/);
});

test('still prompt: guide line, camera words, shot text, identity lines; edit phrasing for Gemini; only the shot text is shortened', () => {
  const { project, shot } = scene({ move: 'truck-right', angle: -90, distance: 8, height: 1.8 });
  const looks = [{ label: 'Hero car' }, { label: 'Track' }];
  const flux = stillPrompt({ project, shot, t: 0, text: 'A race at dusk.', presetId: 'flux-3', looks, prevImage: 4 });
  const lines = flux.split('\n');
  assert.match(lines[0], /^Image 1 is a grey 3D blockout of this exact frame\. Match its camera position, lens, framing, horizon and every object's position, size, heading and pose exactly\./);
  assert.match(lines[1], /^Camera: First frame of a truck right move/);
  assert.match(lines[2], /^In frame: Hero car:/);
  assert.match(lines[3], /^Moment: the first instant of the shot\. The action described below is only beginning; show the poses in image 1, not the climax\./);
  assert.equal(lines[4], 'A race at dusk.');
  assert.match(lines[5], /^The Hero car looks exactly like image 2\. The Track looks exactly like image 3\. Image 4 is the previous shot/);
  assert.match(lines[5], /Images 2–4 show only what things look like: take their design, livery and colours, never their pose, angle, direction or framing/);
  assert.match(lines[6], /red marks are tail lights/);
  // The shot text describes the whole action; the moment line says which instant this key frame is.
  assert.equal(momentLine(shot, shot.duration), 'Moment: the last instant of the shot. The action described below has just happened; show the poses in image 1.');
  assert.equal(momentLine(shot, 1.5), 'Moment: 1.5 s into the 4 s shot; show the poses in image 1.');
  assert.equal(momentLine({ duration: 0 }, 0), '');
  assert.ok(flux.indexOf('Camera:') < flux.indexOf('looks exactly like'), 'camera words come before the identity lines');
  const nb = stillPrompt({ project, shot, t: 0, text: 'A race.', presetId: 'nano-banana-2-1', looks });
  assert.match(nb, /^Edit image 1: repaint this grey 3D blockout as one photoreal film frame\. Keep image 1's camera position/);
  assert.ok(editsGuide('nano-banana-2-1') && !editsGuide('flux-3'));
  const long = stillPrompt({ project, shot, t: 0, text: 'word '.repeat(1000), presetId: 'flux-3', looks, max: 2500 });
  assert.ok(long.length <= 2500); assert.match(long, /Camera: /); assert.match(long, /looks exactly like image 3/); assert.match(long, /…\n/);
});

test('still references: objects in frame (largest first), one environment image, then the previous shot', () => {
  const { project, shot } = scene({ move: 'static', angle: 0, distance: 8, height: 1.5 }, [
    { name: 'Hero car', shape: 'car', position: [0, 0, 0], rotation: 90 },
    { name: 'Offscreen', shape: 'person', position: [0, 0, 30] },
    { name: 'Track', shape: 'box', kind: 'environment', position: [0, -0.05, 0], scale: [40, 0.1, 10] },
    { name: 'Stands', shape: 'building', kind: 'environment', position: [0, 0, -20] },
  ]);
  const ref = (id, entityId) => ({ id, name: id, file: `${id}.png`, mime: 'image/png', role: 'prop', entityId, note: '', createdAt: '' });
  project.scene.references = [ref('r-car', 'e0'), ref('r-off', 'e1'), { ...ref('r-track', 'e2'), role: 'environment' }, { ...ref('r-stands', 'e3'), role: 'environment' }];
  project.shots.unshift({ ...structuredClone(shot), id: 's0', references: [{ ...ref('r-prev', null), role: 'frame' }] });
  const r = stillReferences(project, shot, 0, 9);
  assert.deepEqual(r.refIds, ['r-car', 'r-track', 'r-prev']);
  assert.equal(r.prevImage, 4);
  assert.deepEqual(stillReferences(project, shot, 0, 0).refIds, [], 'models without reference slots get none');
});

test('still references: the lead and the cast the action names get their look even when tiny in frame', () => {
  const { project, shot } = scene({ move: 'static', angle: 270, distance: 6, height: 0.8, mm: 50 }, [
    { name: 'Hero car', shape: 'car', position: [-120, 0, 0], rotation: 90 },
    { name: 'Rival car', shape: 'car', position: [-110, 0, 3], rotation: 90 },
    { name: 'Pace car', shape: 'car', position: [-100, 0, -3], rotation: 90 },
    { name: 'Track', shape: 'box', kind: 'environment', position: [0, -0.05, 0], scale: [300, 0.1, 14] },
  ], { description: '@rival-car leads, then @hero-car blows past.' });
  // A head-on camera 120 m down the track: every car is well under 1% of the frame.
  shot.camera = { ...shot.camera, move: 'custom', keys: [{ t: 0, p: [10, 0.8, 0], look: [-120, 1, 0], mm: 50 }] };
  const ref = (id, entityId, role = 'prop') => ({ id, name: id, file: `${id}.png`, mime: 'image/png', role, entityId, note: '', createdAt: '' });
  project.scene.references = [ref('r-hero', 'e0'), ref('r-rival', 'e1'), ref('r-pace', 'e2'), ref('r-track', 'e3', 'environment')];
  assert.ok(frameLayout(project, shot, 0).items.filter(i => i.kind !== 'environment').every(i => i.coverage < 0.01));
  const r = stillReferences(project, shot, 0, 9);
  assert.deepEqual(new Set(r.refIds), new Set(['r-hero', 'r-rival', 'r-track']), 'named and lead cars kept; the unnamed pace car is not');
});

test('match heuristic: identical frames score 10, unrelated noise scores low, sizes are checked', () => {
  const w = 32, h = 18, img = (f) => Float64Array.from({ length: w * h }, (_, i) => f(i % w, Math.floor(i / w)));
  const scene1 = img((x, y) => (y < 6 ? 220 : 60) + (x > 18 && x < 28 && y > 8 && y < 14 ? 120 : 0));
  assert.equal(guideMatchScore(scene1, scene1, w, h).score, 10);
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const noise = img(() => rnd() * 255);
  assert.ok(guideMatchScore(scene1, noise, w, h).score < 3);
  const darker = img((x, y) => scene1[y * w + x] * 0.5 + 10);
  assert.equal(guideMatchScore(scene1, darker, w, h).score, 10, 'brightness and contrast do not matter');
  assert.throws(() => guideMatchScore(scene1, noise.slice(1), w, h), /w×h/);
});

test('paid grader: graph shape, plan text, and verdict parsing', () => {
  const g = graderGraph('a.png', 'b.png', 1, 'Camera: First frame.');
  assert.equal(g[3].class_type, 'GeminiNodeV3'); assert.deepEqual(g[3].inputs['model.images.image_1'], ['1', 0]); assert.deepEqual(g[3].inputs['model.images.image_2'], ['2', 0]);
  assert.equal(g[3].inputs['model.temperature'], 0); assert.equal(g[4].class_type, 'PreviewAny');
  assert.ok(g[3].inputs['model.prompt'].startsWith(GRADER_PROMPT) && g[3].inputs['model.prompt'].endsWith('Camera: First frame.'));
  assert.deepEqual(parseGrade('```json\n{"camera": 9, "layout": 8, "headings": 2, "score": 4.5, "why": "Car faces left."}\n```'), { score: 4.5, camera: 9, layout: 8, headings: 2, why: 'Car faces left.' });
  assert.equal(parseGrade('no idea'), null); assert.equal(parseGrade('{"score": "high"}'), null);
  assert.equal(parseGrade('{"score": 14}').score, 10);
});

test('presets: guide strength, Nano Banana reference slots, followsGuide hints', () => {
  const ultra = imagePresets.find(p => p.id === 'flux-ultra').build({ prompt: 'x', aspect: '16:9', count: 1, seed: 1, guide: true });
  assert.equal(ultra[1].inputs.image_prompt_strength, 0.55, 'key frames lean on the guide');
  const nb = imagePresets.find(p => p.id === 'nano-banana-2-1');
  assert.equal(nb.maxRefs, 9);
  const g = nb.build({ prompt: 'x', aspect: '16:9', count: 1, seed: 1, guide: true, refs: 2 });
  assert.deepEqual([g[1].inputs['model.images.image_1'], g[1].inputs['model.images.image_2'], g[1].inputs['model.images.image_3']], [['100', 0], ['201', 0], ['202', 0]], 'guide is image 1, cast follow');
  const pub = publicPresets();
  assert.equal(pub.find(p => p.id === 'flux-3').followsGuide, 'strong');
  assert.equal(pub.find(p => p.id === 'nano-banana-pro').followsGuide, 'weak');
  assert.equal(followsGuide('unknown'), 'weak');
  assert.equal(STRONG_GUIDE_MODEL, 'flux-3'); assert.equal(retryModelFor('flux-2-pro'), 'flux-3'); assert.equal(retryModelFor('flux-3'), 'nano-banana-2-1');
});

test('batch retryWeakMatch: a still graded below 5 is redone once with the strong-guide model, within budget', async () => {
  const project = JSON.parse(await readFile(new URL('./fixtures/wingspan-project.json', import.meta.url), 'utf8'));
  for (const s of project.shots) s.references = s.references.filter(r => r.role !== 'frame'); // every shot needs a start still
  const run = async retryWeakMatch => {
    let t = Date.parse('2026-10-30T12:00:00Z');
    const fake = fakeBackend({ now: () => t, seconds: { still: 10 } });
    const first = new Set();
    // Grade the first still of each node 3/10 (as refgen does with PREVIS_MATCH_GRADER=gemini); retries are not graded.
    const jobs = { async snapshot() { const s = await fake.jobs.snapshot(); for (const j of s.jobs) if (j.status === 'completed') { const sub = fake.submits.find(x => x.jobId === j.id); if (sub && (first.has(j.id) || !fake.submits.some(x => x.nodeId === sub.nodeId && x !== sub && fake.submits.indexOf(x) < fake.submits.indexOf(sub)))) { first.add(j.id); j.results = j.results.map(r => ({ ...r, guideMatch: 3 })); } } return s; } };
    const batches = await openBatches(await mkdtemp(join(tmpdir(), 'previs-batch-')), { drivers: fake.drivers, jobs, loadProject: async () => structuredClone(project), now: () => t });
    const b = await batches.create({ projectId: project.id, steps: ['stills'], tier: 'draft', maxCostUsd: 5, shots: [project.shots[0].id], ...(retryWeakMatch ? { retryWeakMatch: true } : {}) });
    for (let i = 0; i < 100; i++) { await batches.tick(b.id); await batches.idle(); const x = batches.get(b.id); if (['completed', 'failed', 'paused'].includes(x.status)) return { batch: x, fake }; t += 5000; }
    throw Error('batch did not finish');
  };
  const on = await run(true), node = on.batch.nodes.find(n => n.type === 'still');
  assert.equal(on.batch.status, 'completed');
  assert.equal(on.fake.submits.filter(x => x.type === 'still').length, 2, 'one retry, never more');
  assert.equal(node.model, 'flux-3'); assert.equal(node.retriedFrom.model, 'flux-2-pro'); assert.equal(node.retriedFrom.guideMatch, 3);
  assert.ok(3 < WEAK_MATCH); assert.equal(WEAK_MATCH, 6, 'a 5/10 still is retried');
  assert.equal(on.batch.spentEstimateUsd, 0.028 + 0.066, 'the retry is charged to the batch budget');
  const off = await run(false);
  assert.equal(off.fake.submits.filter(x => x.type === 'still').length, 1, 'off by default');
});
