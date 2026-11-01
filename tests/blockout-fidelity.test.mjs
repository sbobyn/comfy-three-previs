// Blockout-faithful model guidance (shared/blockout-fidelity.mjs): per-route fidelity labels, how much a shot's subject
// moves and turns, and the advice that recommends an edit-from-blockout route for direction-critical shots. Free; fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEntity, makeShot } from '../shared/director.mjs';
import { blockoutFidelity, subjectDirection, shotMotion, fidelityAdvice, defaultForShot, directionWord, VIDEO_FIDELITY } from '../shared/blockout-fidelity.mjs';
import { videoCapabilities } from '../shared/model-params.mjs';
import { builtInPresets } from '../server/previs/presets.mjs';
import { loadStarters, instantiateStarter } from '../server/previs/starters.mjs';
import { createProjectDocument, applyOps } from '../server/previs/director.mjs';
import { planProposal } from '../server/previs/agent-proposal.mjs';
import { planBatch } from '../server/previs/batch.mjs';

const preset = id => builtInPresets.find(d => d.id === id);
const wingspan = instantiateStarter((await loadStarters()).find(s => s.slug === 'wingspan'));

// A bird flying along z past a static camera on +z, looking at the origin.
function flight({ from, to, duration = 4, camera = { move: 'static', angle: 0, distance: 10, height: 2, mm: 35 }, shape = 'bird', motionCritical } = {}) {
  const bird = makeEntity({ name: 'Hawk', shape, position: from, path: [{ t: 0, p: from }, { t: duration, p: to }] }, 'b1');
  const shot = makeShot({ title: 'Flight', duration, camera: { target: null, ...camera } }, 's1', 1, [bird]);
  if (motionCritical) shot.motionCritical = true;
  return { project: { scene: { entities: [bird], environment: { preset: 'stage' }, references: [] }, shots: [shot] }, shot };
}

test('fidelity: Seedance edit follows, Kling O1 edit is mixed, start-frame routes guess; every label is a heuristic', () => {
  assert.equal(blockoutFidelity(preset('seedance-25-edit-v1')).direction, 'follows');
  assert.equal(blockoutFidelity(preset('seedance-25-edit-v1')).route, 'edit');
  assert.equal(blockoutFidelity(preset('kling-o1-edit-v1')).direction, 'mixed', 'regen 4: turned the eagle to face the camera twice');
  // The 4-reference Kling variant the regen used is a derived definition of the same preset.
  assert.equal(blockoutFidelity({ id: 'kling-o1-edit-v1-refs4', provenance: { presetId: 'kling-o1-edit-v1' }, inputs: { sourceVideo: {} } }).direction, 'mixed');
  assert.deepEqual([blockoutFidelity(preset('ltx-25-flf-v1')).route, blockoutFidelity(preset('ltx-25-flf-v1')).direction], ['start-end', 'approximate']);
  assert.deepEqual([blockoutFidelity(preset('ltx-25-i2v-fast-v1')).route, blockoutFidelity(preset('ltx-25-i2v-fast-v1')).direction], ['start', 'approximate']);
  assert.deepEqual([blockoutFidelity(preset('wan-vace-13b-edge-v1')).route, blockoutFidelity(preset('wan-vace-13b-edge-v1')).tested], ['control', false]);
  // An imported graph that takes the blockout clip but was never judged: not promised to follow.
  const imported = blockoutFidelity({ id: 'my-v2v', inputs: { sourceVideo: { nodeId: '1', input: 'file' } } });
  assert.deepEqual([imported.route, imported.direction, imported.tested], ['edit', 'mixed', false]);
  for (const d of builtInPresets) {
    const f = blockoutFidelity(d);
    assert.equal(f.heuristic, true); assert.ok(f.label && f.routeLabel && f.note, d.id);
    assert.deepEqual(videoCapabilities(d).blockoutFidelity, f, 'model settings (MCP) carry the same label');
  }
  for (const id of Object.keys(VIDEO_FIDELITY)) assert.ok(preset(id), `${id} is a real preset`);
});

test('subject direction: facing and travel are relative to the camera, also when it follows the subject', () => {
  const away = flight({ from: [0, 3, 0], to: [0, 3, -20] }), toward = flight({ from: [0, 3, -20], to: [0, 3, 0] }), right = flight({ from: [-8, 3, 0], to: [8, 3, 0] });
  const a = subjectDirection(away.project, away.shot, 2);
  assert.deepEqual([a.facing, a.travelWord], ['away', 'away'], 'a bird faces its direction of travel');
  assert.deepEqual([subjectDirection(toward.project, toward.shot, 2).facing, subjectDirection(toward.project, toward.shot, 2).travelWord], ['toward', 'toward']);
  assert.deepEqual([subjectDirection(right.project, right.shot, 2).facing, subjectDirection(right.project, right.shot, 2).travelWord], ['right', 'right']);
  // Wingspan: the camera chases the eagle, so it holds frame centre while flying away (on screen it barely moves).
  const valley = wingspan.shots.find(s => s.title === 'The valley'), d = subjectDirection(wingspan, valley, 2.5);
  assert.equal(d.subject.name, 'Bald eagle');
  assert.deepEqual([d.facing, d.travelWord], ['away', 'away']);
  assert.ok(Math.abs(d.x - 0.5) < 0.05, 'centred on screen');
  assert.equal(directionWord(170), 'away'); assert.equal(directionWord(-100), 'left'); assert.equal(directionWord(30), 'toward-right'); assert.equal(directionWord(null), null);
});

test('shot motion: a subject facing away or travelling far is direction-critical; a still subject is not', () => {
  for (const s of wingspan.shots) {
    const m = shotMotion(wingspan, s);
    assert.equal(m.level, 'high', s.title);
    assert.ok(m.reasons.some(r => /faces away from the camera/.test(r)), `${s.title}: ${m.reasons}`);
  }
  const still = createProjectDocument({ template: 'street' });
  for (const s of still.shots) assert.equal(shotMotion(still, s).level, 'normal', 'nothing in the street template moves or faces away');
  const toward = flight({ from: [0, 3, -3], to: [0, 3, -2] }); // short hop toward the camera
  assert.equal(shotMotion(toward.project, toward.shot).level, 'normal');
});

test('advice: a direction-critical shot on a start-frame or Kling route recommends Seedance edit; never blocks', () => {
  const valley = wingspan.shots.find(s => s.title === 'The valley');
  const ltx = fidelityAdvice(wingspan, valley, preset('ltx-25-i2v-fast-v1'), builtInPresets);
  assert.equal(ltx.critical, true); assert.equal(ltx.auto, true); assert.equal(ltx.ok, false);
  assert.equal(ltx.recommend.id, 'seedance-25-edit-v1');
  assert.match(ltx.message, /Direction-critical shot \(Bald eagle faces away/);
  assert.match(ltx.message, /Recommended: Seedance 2\.5 · edit the complete video/);
  assert.match(ltx.message, /Heuristic .*not blocked/);
  const kling = fidelityAdvice(wingspan, valley, preset('kling-o1-edit-v1'), builtInPresets);
  assert.equal(kling.ok, false, 'Kling O1 edit lost the eagle’s direction in regen 4');
  assert.equal(kling.recommend.id, 'seedance-25-edit-v1');
  const seed = fidelityAdvice(wingspan, valley, preset('seedance-25-edit-v1'), builtInPresets);
  assert.deepEqual([seed.critical, seed.ok, seed.recommend], [true, true, null]);
  assert.match(seed.message, /still check the take’s direction/);
  // Not critical: no advice, whatever the model.
  const street = createProjectDocument({ template: 'street' }), plain = fidelityAdvice(street, street.shots[0], preset('ltx-25-i2v-fast-v1'), builtInPresets);
  assert.deepEqual([plain.critical, plain.ok, plain.recommend, plain.message], [false, true, null, '']);
  // Flagged by the user: critical even when the blockout barely moves.
  const flagged = structuredClone(street); Object.assign(flagged.shots[0], { motionCritical: true, duration: 5 });
  const f = fidelityAdvice(flagged, flagged.shots[0], preset('ltx-25-i2v-fast-v1'), builtInPresets);
  assert.deepEqual([f.critical, f.flagged, f.recommend?.id], [true, true, 'seedance-25-edit-v1']);
  assert.match(f.message, /flagged motion\/direction-critical/);
});

test('advice: a clip too short for Seedance edit (4–30 s) says so instead of recommending it', () => {
  const short = flight({ from: [0, 3, 0], to: [0, 3, -30], duration: 3 });
  const cloud = builtInPresets.filter(d => !d.id.startsWith('wan-'));
  const a = fidelityAdvice(short.project, short.shot, preset('kling-o1-edit-v1'), cloud);
  assert.equal(a.critical, true); assert.equal(a.recommend, null);
  assert.match(a.message, /accepts a 3 s clip \(Seedance 2\.5 needs 4–30 s\)/);
  // With a local VACE install, its edge control follows the clip by construction.
  assert.equal(fidelityAdvice(short.project, short.shot, preset('kling-o1-edit-v1'), builtInPresets).recommend.id, 'wan-vace-13b-edge-v1');
});

test('default model: a critical shot with nothing saved starts on the recommended route; others keep the usual default', () => {
  const valley = wingspan.shots.find(s => s.title === 'The valley');
  assert.equal(defaultForShot(wingspan, valley, builtInPresets)?.id, 'seedance-25-edit-v1');
  const street = createProjectDocument({ template: 'street' });
  assert.equal(defaultForShot(street, street.shots[0], builtInPresets), null);
});

test('motionCritical: update_shot sets and clears it, and an agent proposal undoes it', () => {
  const p = createProjectDocument({ template: 'street' }), id = p.shots[0].id;
  applyOps(p, [{ op: 'update_shot', id, patch: { motionCritical: true } }]);
  assert.equal(p.shots[0].motionCritical, true);
  applyOps(p, [{ op: 'update_shot', id, patch: { motionCritical: 'yes' } }]);
  assert.equal('motionCritical' in p.shots[0], false, 'only true sets it');
  const plan = planProposal(p, [{ op: 'update_shot', id, patch: { motionCritical: true } }]);
  assert.match(plan.summary.map(x => x.text).join(' '), /mark motion\/direction-critical/);
  const q = structuredClone(p); applyOps(q, plan.ops); assert.equal(q.shots[0].motionCritical, true);
  applyOps(q, plan.undo); assert.equal('motionCritical' in q.shots[0], false);
});

test('batch: a draft plan for direction-critical shots carries advice on each video node; the final tier does not need it', () => {
  const draft = planBatch(wingspan, { steps: ['videos'], tier: 'draft', maxCostUsd: 20 }).nodes.filter(n => n.type === 'video');
  assert.equal(draft.length, 3);
  for (const n of draft) { assert.equal(n.directionAdvice?.recommend, 'seedance-25-edit-v1', n.label); assert.match(n.directionAdvice.message, /not blocked/); assert.notEqual(n.status, 'failed'); }
  const final = planBatch(wingspan, { steps: ['videos'], tier: 'final', maxCostUsd: 20 }).nodes.filter(n => n.type === 'video');
  assert.ok(final.every(n => !n.directionAdvice));
});
