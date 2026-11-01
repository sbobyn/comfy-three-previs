// Take direction check: sampling, the grader prompt and its parsing, the pass/warn/fail verdict, the server check with
// its budget booking, and how takes show it. Fixtures only: the grader is faked, nothing paid runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { directionTimes, blockoutPlan, directionPrompt, parseDirection, compareDirection, judgeDirection, DIRECTION_WORDS } from '../shared/take-direction.mjs';
import { openTakeGrader, directionGraph, bookedCost, DIRECTION_GRADE_USD } from '../server/previs/take-grade.mjs';
import { openBudget } from '../server/previs/budget.mjs';
import { loadStarters, instantiateStarter } from '../server/previs/starters.mjs';
import { videoTakes } from '../shared/takes.mjs';
import { shotSignature } from '../shared/director.mjs';
import { GRADER_PRICES } from '../shared/tiers.mjs';

const wingspan = instantiateStarter((await loadStarters()).find(s => s.slug === 'wingspan'));
const valley = wingspan.shots.find(s => s.title === 'The valley');
// Grader replies shaped like the regen takes: the eagle seen from behind flying away (accepted Seedance edits), and the
// eagle turned to face the lens (rejected Kling O1 edit and LTX takes).
const reply = (take, blockout = { facing: 'away', travel: 'away' }) => JSON.stringify({ frames: [0.75, 2, 3.25, 4.5].map(t => ({ t, blockout, take: typeof take === 'function' ? take(t) : take })), why: 'test' });
const AWAY = { facing: 'away', travel: 'away' }, TOWARD = { facing: 'toward', travel: 'toward' };

test('sampling: four moments from 15% to 90% of the shorter clip, on 24 fps frames', () => {
  assert.deepEqual(directionTimes(5, 5.041667), [0.75, 2, 3.25, 4.5], 'late enough to catch a turn in the last second');
  const ts = directionTimes(5, 4.708333);
  assert.equal(ts.length, 4);
  assert.ok(ts.every(t => t > 0 && t < 4.708333));
  for (const t of ts) assert.ok(Math.abs(t * 24 - Math.round(t * 24)) < 0.25, `${t} is on a frame`);
  assert.deepEqual(directionTimes(null, undefined), []);
});

test('plan: the blockout’s facing and travel come from the 3D scene while it matches the clip', () => {
  const ts = directionTimes(5, 5), plan = blockoutPlan(wingspan, valley, ts);
  assert.equal(plan.subject.name, 'Bald eagle'); assert.equal(plan.subject.shape, 'bird'); assert.equal(plan.measured, true);
  assert.deepEqual(plan.frames.map(f => [f.facing, f.travel]), ts.map(() => ['away', 'away']));
  const stale = blockoutPlan(wingspan, valley, ts, { current: false });
  assert.equal(stale.measured, false); assert.ok(stale.frames.every(f => f.facing === null && f.travel === null), 'scene changed: use the grader’s reading of the clip');
  // Measured: the prompt is about the take's frames alone and never says which way the blockout faces.
  const prompt = directionPrompt(plan);
  assert.match(prompt, /The image shows 4 frames of a generated video at 0\.75 s, 2\.00 s, 3\.25 s, 4\.50 s/);
  assert.match(prompt, /The subject is Bald eagle \(a bird\)/);
  assert.doesNotMatch(prompt, /blockout|faces away|facing away/);
  assert.match(prompt, /"seen"/);
  for (const w of DIRECTION_WORDS) assert.ok(prompt.includes(w));
  // Not measured: both clips, and the grader reads the blockout too.
  assert.match(directionPrompt(stale), /Image 1 shows 4 frames of a grey 3D blockout.*Image 2 shows the same 4 moments/s);
  assert.match(directionPrompt(stale), /"blockout":\{"seen"/);
});

test('grader graph: Gemini on the take’s frames (and the blockout’s when unmeasured), the same node and settings as the still grader', () => {
  const one = directionGraph(null, 'b.jpg', 'P');
  assert.equal(one[1], undefined); assert.deepEqual(one[3].inputs['model.images.image_1'], ['2', 0]); assert.equal(one[3].inputs['model.images.image_2'], undefined);
  const g = directionGraph('a.jpg', 'b.jpg', 'P');
  assert.equal(g[3].class_type, 'GeminiNodeV3');
  assert.deepEqual([g[1].inputs.image, g[2].inputs.image, g[3].inputs['model.images.image_1'], g[3].inputs['model.images.image_2']], ['a.jpg', 'b.jpg', ['1', 0], ['2', 0]]);
  assert.equal(g[3].inputs['model.temperature'], 0); assert.equal(g[4].class_type, 'PreviewAny');
});

test('parse: tolerant of fences and wording; unusable replies are null', () => {
  const p = parseDirection('```json\n{"frames":[{"t":"1.2","blockout":{"facing":"Away","travel":"away"},"take":{"facing":"towards","travel":"Toward left"}}],"why":"turns"}\n```');
  assert.deepEqual(p.frames[0], { t: 1.2, blockout: { facing: 'away', travel: 'away' }, take: { facing: 'toward', travel: 'toward-left' } });
  assert.equal(parseDirection('{"frames":[{"take":{"facing":"sideways"}}]}').frames[0].take.facing, 'unclear');
  assert.equal(parseDirection('no json'), null); assert.equal(parseDirection('{"frames":[]}'), null); assert.equal(parseDirection('{bad'), null);
  assert.equal(parseDirection(reply(AWAY), 2).frames.length, 2, 'never more frames than were sampled');
  // Take-only replies carry the fields on the frame; "seen" overrides a facing word it contradicts.
  const only = parseDirection('{"frames":[{"t":0.75,"seen":"front","facing":"away","travel":"away"},{"t":2,"seen":"back","facing":"away-left","travel":"away"},{"t":3.25,"seen":"left side","facing":"left","travel":"left"},{"t":4.5,"seen":"absent","facing":"unclear","travel":"unclear"}]}');
  assert.deepEqual(only.frames.map(f => f.take.facing), ['toward', 'away-left', 'left', 'absent']);
  assert.equal(only.frames[0].take.seen, 'front');
});

test('compare: within 50° matches, a quarter turn is off, the other way is opposite', () => {
  assert.equal(compareDirection('away', 'away-left'), 'match');
  assert.equal(compareDirection('away', 'left'), 'off');
  assert.equal(compareDirection('away', 'toward'), 'opposite');
  assert.equal(compareDirection('away', 'toward-right'), 'opposite');
  assert.equal(compareDirection('right', 'left'), 'opposite');
  assert.equal(compareDirection(null, 'away'), 'unknown'); assert.equal(compareDirection('away', 'unclear'), 'unknown');
});

test('verdict: the known-bad takes fail with a reason, the accepted ones pass', () => {
  const plan = blockoutPlan(wingspan, valley, directionTimes(5, 5));
  const bad = judgeDirection(plan, parseDirection(reply(TOWARD)));
  assert.equal(bad.verdict, 'fail');
  assert.equal(bad.why, 'At 0.8 s the Bald eagle faces the camera; the blockout has it facing away.');
  assert.ok(bad.frames.every(f => f.blockout.from === 'scene'));
  // LTX on The dive: right at first, turning into the lens later.
  // Kling O1 on The dive: away until the last second, then turned into the lens.
  const turns = judgeDirection(plan, parseDirection(reply(t => (t < 4 ? AWAY : { facing: 'toward-left', travel: 'toward' }))));
  assert.equal(turns.verdict, 'fail'); assert.match(turns.why, /^At 4\.5 s the Bald eagle faces the camera, turned screen-left/);
  const good = judgeDirection(plan, parseDirection(reply(t => (t > 3 ? { facing: 'away-right', travel: 'away' } : AWAY))));
  assert.equal(good.verdict, 'pass');
  assert.equal(good.why, 'The Bald eagle faces away and travels away as in the blockout at 4 of 4 moments.');
  // A quarter turn (seen side-on) is a warning, not a fail.
  const side = judgeDirection(plan, parseDirection(reply({ facing: 'right', travel: 'away' })));
  assert.equal(side.verdict, 'warn'); assert.match(side.why, /faces screen-right; the blockout has it facing away/);
  // Travel alone can fail it: facing right but flying at the camera.
  assert.match(judgeDirection(plan, parseDirection(reply({ facing: 'away-left', travel: 'toward' }))).why, /comes toward the camera; the blockout has it going away/);
  // Not readable in most moments: warn, never pass.
  const lost = judgeDirection(plan, parseDirection(reply(t => (t < 2 ? AWAY : { facing: 'absent', travel: 'absent' }))));
  assert.equal(lost.verdict, 'warn'); assert.match(lost.why, /could not be read in 3 of 4 moments \(not in frame\)/);
  assert.equal(judgeDirection(plan, null), null);
});

test('verdict: without a 3D measurement the grader’s own reading of the blockout frames is the reference', () => {
  const plan = blockoutPlan(wingspan, valley, directionTimes(5, 5), { current: false });
  const r = judgeDirection(plan, parseDirection(reply(TOWARD, { facing: 'away', travel: 'away' })));
  assert.equal(r.verdict, 'fail'); assert.ok(r.frames.every(f => f.blockout.from === 'grader'));
  assert.equal(judgeDirection(plan, parseDirection(reply(TOWARD, { facing: 'unclear', travel: 'unclear' }))).verdict, 'warn', 'nothing to compare against');
});

// ---------- Server check, with a fake director, frames and grader, and a real budget ledger ----------
function fakeDirector(project) {
  const saved = [];
  return { saved, get: async () => structuredClone(project), assetFile: async (_p, f) => `/media/${f}`, recordTakeCheck: async (pid, assetId, kind, check) => { saved.push({ pid, assetId, kind, check }); return check; } };
}
function withTake(p = structuredClone(wingspan)) {
  const s = p.shots.find(x => x.title === 'The valley');
  const blockout = { id: 'blk1', kind: 'camera-render', shotId: s.id, file: 'assets/blk1.mp4', mime: 'video/mp4', duration: 5, fps: 24, source: { signature: shotSignature(p, s) }, createdAt: '2026-11-01T00:00:00Z' };
  const take = { id: 'take0001-aaaa', kind: 'workflow-result', shotId: s.id, file: 'assets/take.mp4', mime: 'video/mp4', duration: 5.041667, fps: 24, source: { sourceAssetId: 'blk1', workflow: 'Kling O1 · edit the complete video' }, createdAt: '2026-11-01T00:01:00Z' };
  p.assets = [blockout, take];
  return { p, s, take };
}
async function grader(project, { text = reply(TOWARD), notSent = false, grader: on = 'gemini' } = {}) {
  const budget = await openBudget(await mkdtemp(join(tmpdir(), 'previs-dir-budget-')), { env: {} }), director = fakeDirector(project), sheets = [], runs = [];
  const g = openTakeGrader(await mkdtemp(join(tmpdir(), 'previs-dir-')), director, {
    budget, allowPaid: true, grader: on, uploadCache: { upload: async () => ({ value: 'x' }) }, backend: () => ({}),
    sheet: async (inputs, opts) => { sheets.push({ inputs, opts }); return Buffer.from('jpg'); },
    run: async a => { runs.push(a); return notSent ? { promptId: null, text: null, notSent: true, error: 'refused' } : { promptId: 'p1', text }; },
  });
  return { g, budget, director, sheets, runs };
}

test('server check: samples both clips at the same moments, books one grader charge and saves the verdict on the take', async () => {
  const { p, take } = withTake(), { g, budget, director, sheets, runs } = await grader(p);
  const r = await g.grade({ projectId: p.id, assetId: take.id, maxCostUsd: 0.05 });
  assert.equal(r.check.verdict, 'fail'); assert.match(r.check.why, /faces the camera; the blockout has it facing away/);
  assert.equal(r.check.measured, true); assert.equal(r.check.blockoutAssetId, 'blk1'); assert.match(r.check.method, /^direction-v1:gemini-grader:/);
  assert.deepEqual(sheets.map(x => x.inputs.map(i => i.file)), [Array(4).fill('/media/take.mp4')], 'measured blockout: only the take is sent');
  assert.deepEqual(sheets[0].inputs.map(i => i.t), [0.75, 2, 3.25, 4.5]);
  assert.equal(runs[0].blockoutBytes, null);
  assert.equal(runs.length, 1, 'one grader call per check'); assert.match(runs[0].prompt, /Bald eagle/);
  assert.equal(director.saved.length, 1); assert.equal(director.saved[0].assetId, take.id); assert.equal(director.saved[0].kind, 'direction');
  // What is shown is what the ledger booked: one grader charge.
  const booked = budget.get(r.check.reservationId);
  assert.equal(booked.state, 'settled'); assert.equal(booked.source, 'grader');
  assert.deepEqual(r.cost, { usd: GRADER_PRICES.gemini, status: 'estimate' });
  assert.equal(r.cost.usd, budget.list().find(x => x.id === r.check.reservationId).costUsd);
  assert.equal(DIRECTION_GRADE_USD, GRADER_PRICES.gemini);
});

test('server check: refuses before sending when the grader is off or maxCostUsd is too low; unsent checks owe nothing', async () => {
  const { p, take } = withTake();
  const off = await grader(p, { grader: 'off' });
  await assert.rejects(off.g.grade({ projectId: p.id, assetId: take.id }), e => e.status === 409 && /PREVIS_MATCH_GRADER=gemini/.test(e.message));
  assert.equal(off.budget.list().length, 0); assert.equal(off.runs.length, 0);
  const low = await grader(p);
  await assert.rejects(low.g.grade({ projectId: p.id, assetId: take.id, maxCostUsd: 0.005 }), e => e.status === 402);
  assert.equal(low.budget.list().length, 0);
  const unsent = await grader(p, { notSent: true });
  await assert.rejects(unsent.g.grade({ projectId: p.id, assetId: take.id }), /could not be sent/);
  assert.equal(unsent.budget.list()[0].state, 'released'); assert.equal(unsent.director.saved.length, 0);
  // Sent, no usable reply: the charge may still arrive, so the reservation is held.
  const empty = await grader(p, { text: null });
  await assert.rejects(empty.g.grade({ projectId: p.id, assetId: take.id }), /did not return a usable reading/);
  assert.equal(empty.budget.list()[0].state, 'held');
  // A blockout still or an unknown id is not a take.
  await assert.rejects(low.g.grade({ projectId: p.id, assetId: 'blk1' }), e => e.status === 404);
});

test('server check: when the scene changed since the blockout clip, the grader’s reading of the clip is the reference', async () => {
  const { p, take } = withTake(); p.assets[0].source.signature = 'older';
  const { g, sheets } = await grader(p, { text: reply(AWAY) });
  const r = await g.grade({ projectId: p.id, assetId: take.id });
  assert.equal(r.check.measured, false); assert.equal(r.check.verdict, 'pass');
  assert.deepEqual(sheets.map(x => x.inputs[0].file), ['/media/blk1.mp4', '/media/take.mp4'], 'both clips, at the same moments');
  assert.deepEqual(sheets[0].inputs.map(i => i.t), sheets[1].inputs.map(i => i.t));
});

test('takes: a checked video take shows its verdict and the ledger’s amount; unchecked ones say how to check', () => {
  const { p, s, take } = withTake();
  assert.equal(videoTakes(p, s)[0].grades.direction.status, 'not-checked');
  assert.match(videoTakes(p, s)[0].grades.direction.note, /previs_director_grade_take \(\$0\.01/);
  take.checks = { direction: { verdict: 'fail', why: 'At 1.3 s the Bald eagle faces the camera; the blockout has it facing away.', frames: [], grader: '', subject: 'Bald eagle', measured: true, blockoutAssetId: 'blk1', method: 'direction-v1:gemini-grader:Gemini 3.5 Flash', reservationId: 'direction-take0001-1', gradedAt: '2026-11-01T00:02:00Z' } };
  const ledger = { 'direction-take0001-1': { state: 'settled', costUsd: 0.01, costStatus: 'estimated' } };
  const d = videoTakes(p, s, { ledger })[0].grades.direction;
  assert.deepEqual([d.status, d.verdict, d.method, d.cost.usd, d.cost.status], ['checked', 'fail', 'direction-v1', 0.01, 'estimate']);
  // After usage:settle matches it to the bill, the take shows the billed amount.
  assert.deepEqual(videoTakes(p, s, { ledger: { 'direction-take0001-1': { state: 'settled', costUsd: 0.006, costStatus: 'billed' } } })[0].grades.direction.cost, { usd: 0.006, status: 'billed' });
  assert.deepEqual(bookedCost({ state: 'released', expectedMicros: 10000 }), { usd: 0, status: 'released' });
  assert.deepEqual(bookedCost({ state: 'held', expectedMicros: 10000 }), { usd: 0.01, status: 'estimate' });
});
