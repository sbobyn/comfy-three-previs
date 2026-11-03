// Look presets (shared/look-presets.mjs, docs/look-presets.md): structured scene/setting/lighting choices compose into the prompt
// under your own section text, fit the length budget, are part of the regeneration keys, and fan a base shot out into
// single-axis variants whose stills are edits of the base still. Nothing is generated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectDocument, applyOps } from '../server/previs/director.mjs';
import { loadStarters, instantiateStarter } from '../server/previs/starters.mjs';
import { builtInPresets } from '../server/previs/presets.mjs';
import { openBatches, planBatch } from '../server/previs/batch.mjs';
import { fakeBackend } from '../server/previs/batch-drivers.mjs';
import { LOOK_AXES, NO_BRANDS_NEGATIVE, normalizeLook, effectiveLook, variantLooks, variantLabel, lookDiff, variantEditPrompt, variantModels, presetOf } from '../shared/look-presets.mjs';
import { variantStillRequest, addVariantShots, styleReference } from '../shared/look-variants.mjs';
import { shotPrompt, sectionedSegments } from '../shared/prompt.mjs';
import { videoPromptPlan } from '../shared/prompt-plan.mjs';
import { videoReferences, shotSignature } from '../shared/director.mjs';
import { stillKey, videoKey, explainStale } from '../shared/regen.mjs';
import { cameraSourceOf, cameraLine } from '../shared/camera-source.mjs';
import { autoPromptCap } from '../shared/model-params.mjs';
import { maxReferences } from '../shared/video-refs.mjs';

const starters = await loadStarters();
const lookLab = () => createProjectDocument({ template: 'look-lab' }, undefined, starters);
const plan = (p, s, model = builtInPresets.find(d => d.id === 'seedance-25-edit-v1')) => {
  const cameraSource = cameraSourceOf(model), refs = model.task === 'first-frame' ? [] : videoReferences(p, s, maxReferences(model), { stills: cameraSource === 'blockout' });
  return videoPromptPlan(p, s, { cameraSource, refs, cap: autoPromptCap(model), maxLength: model.constraints?.promptMaxLength });
};
const BLOCKOUT = ['look-lab', 'mountain-trail', 'city-blocks', 'camera-moves', 'two-hander'];
let n = 0; const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

test('looks are structured: unknown ids dropped, the shot inherits the project default, "none" clears an axis', () => {
  const p = lookLab(), s = p.shots[0], walker = p.scene.entities.find(e => e.name === 'Walker');
  assert.deepEqual(normalizeLook({ time: 'night', weather: 'acid-rain', style: 'anime', subjects: { [walker.id]: '  a knight  ', 'bad id!': 'x' } }), { time: 'night', style: 'anime', subjects: { [walker.id]: 'a knight' } });
  p.look = { time: 'dawn', season: 'winter' };
  s.look = { time: 'night', season: 'none', wardrobe: 'raincoat' };
  assert.deepEqual(effectiveLook(p, s), { time: 'night', wardrobe: 'raincoat' });
  assert.deepEqual(effectiveLook(p, p.shots[1]), { time: 'dawn', season: 'winter' });
});

test('presets compose into the prompt sections, under your own text, and keep the explicit negative', () => {
  const p = lookLab(), s = p.shots[0], walker = p.scene.entities.find(e => e.name === 'Walker');
  s.look = { time: 'night' };
  const video = shotPrompt(p, s, 'video', { cameraSource: 'blockout' }), image = shotPrompt(p, s, 'image');
  for (const text of [video, image]) { assert.match(text, /Set: the same scene at night, lamplight on the ground, lit windows\./); assert.ok(text.includes(NO_BRANDS_NEGATIVE)); assert.doesNotMatch(text, /sunny summer afternoon/); }
  assert.ok(video.includes(cameraLine('blockout', '')), 'photoreal stays photoreal');
  const row = sectionedSegments(p, s, 'video').find(r => r.key === 'world');
  assert.equal(row.preset, true, 'the inspector can tell a preset section from your own');
  // Art style: its format line, and the camera line repaints in its medium.
  s.look = { style: 'anime' };
  const anime = shotPrompt(p, s, 'video', { cameraSource: 'blockout' });
  assert.match(anime, /^2D cel anime shot\./); assert.ok(anime.includes(cameraLine('blockout', 'anime'))); assert.doesNotMatch(anime, /photoreal/i);
  // Wardrobe changes the clothes only: the lead keeps who they are, the look stays the project's.
  s.look = { wardrobe: 'cyberpunk' };
  const wear = shotPrompt(p, s, 'video', { cameraSource: 'blockout' });
  assert.match(wear, /Adult in their thirties.*the same person, now wearing cyberpunk clothes/i); assert.match(wear, /Look: Photoreal, warm afternoon sun/);
  // A subject swap replaces what the object is.
  s.look = { subjects: { [walker.id]: 'a tall knight in silver armour' } };
  assert.match(shotPrompt(p, s, 'video', { cameraSource: 'blockout' }), /A tall knight in silver armour\./);
  // Your own section text wins over a preset (b · Night overrides world and style).
  const b = p.shots.find(x => x.title === 'b · Night'); b.look = { time: 'dawn' };
  assert.match(shotPrompt(p, b, 'video', { cameraSource: 'blockout' }), /Set: the same street at night/);
});

test('presets fit the prompt budget: every single preset on the blockout starters; elsewhere it fits or says why', () => {
  // A blockout starter keeps its required text short, so every preset (and Look Lab's six-axis combination) fits each model's
  // cap. A finished starter whose action, lead and camera rule already fill the budget keeps the look and reports lookWarning.
  for (const slug of ['look-lab', 'mountain-trail', 'city-blocks', 'camera-moves', 'two-hander', 'wingspan', 'final-lap', 'breaking-news', 'posterized']) {
    const p = createProjectDocument({ template: slug }, undefined, starters), lead = p.shots[0].camera.target, strict = BLOCKOUT.includes(slug);
    const looks = [...LOOK_AXES.flatMap(a => a.presets.map(x => ({ [a.id]: x.id }))), { subjects: { [lead]: 'a stylised dragon with emerald scales' } },
      ...(slug === 'look-lab' ? [{ time: 'night', weather: 'rain', season: 'winter', mood: 'low-key', wardrobe: 'raincoat', style: 'claymation' }] : [])];
    for (const s of p.shots.slice(0, 3)) for (const look of looks) {
      s.look = look;
      for (const model of builtInPresets.filter(d => d.inputs?.prompt)) {
        const x = plan(p, s, model), where = `${slug}/${s.title}/${JSON.stringify(look)}/${model.id}`;
        if (strict) assert.ok(x.length <= autoPromptCap(model), `${where}: ${x.length}`);
        else assert.ok(x.length <= autoPromptCap(model) || x.lookWarning, `${where}: ${x.length} with no lookWarning`);
        if (x.maxLength) assert.ok(x.length <= x.maxLength, where);
        for (const key of ['action', 'camera', `obj:${s.camera.target}`]) assert.ok(x.sections.some(r => r.key === key && ['included', 'shortened'].includes(r.status)), `${where}: missing ${key}`);
        if (x.sections.some(r => r.preset)) assert.match(x.text, /no logos/i, where); // a look that applies carries the negative
      }
      s.look = undefined;
    }
  }
});

test('regeneration keys: no preset leaves a key unchanged; a preset dirties only that shot’s still and video, with a readable reason', () => {
  const p = lookLab(), [a, b] = p.shots, model = 'gpt-image-25', def = builtInPresets.find(d => d.id === 'seedance-25-edit-v1');
  const before = { still: stillKey(p, a, 'start', { model }), video: videoKey(p, a, { def }), other: stillKey(p, b, 'start', { model }) };
  a.look = {}; assert.equal(stillKey(p, a, 'start', { model }).key, before.still.key, 'an empty look is no look');
  a.look = { time: 'night' };
  const still = stillKey(p, a, 'start', { model }), video = videoKey(p, a, { def });
  assert.equal(still.parts['preset:time'], 'night'); assert.notEqual(still.key, before.still.key); assert.notEqual(video.key, before.video.key);
  assert.equal(stillKey(p, b, 'start', { model }).key, before.other.key, 'another shot is untouched');
  // A still made with the night preset, then the preset moves to dawn: stale, and the reason names the preset.
  a.references[0].generated = { ...a.references[0].generated, regen: still };
  assert.equal(explainStale(p, { type: 'still', shotId: a.id, at: 'start' }, { model }).state, 'fresh');
  a.look = { time: 'dawn' };
  const x = explainStale(p, { type: 'still', shotId: a.id, at: 'start' }, { model });
  assert.equal(x.state, 'stale'); assert.ok(x.reasons.some(r => r.code === 'look-preset' && r.text === 'Time of day preset changed (Night → Dawn)'), JSON.stringify(x.reasons));
  assert.equal(x.blocking, false, 'a look change is never a blocking change: the blockout stays');
  // A project default dirties the shots that inherit it, not a shot that sets its own value for that axis.
  const c = p.shots[2], d = p.shots[3]; d.look = { time: 'noon' };
  const cBefore = stillKey(p, c, 'start', { model }).key, dBefore = stillKey(p, d, 'start', { model }).key;
  p.look = { time: 'blue-hour' };
  assert.notEqual(stillKey(p, c, 'start', { model }).key, cBefore); assert.equal(stillKey(p, d, 'start', { model }).key, dBefore);
});

test('variants are single-axis by default, combinations only when asked; labels say what differs from the base', () => {
  const base = { time: 'golden-hour' };
  const single = variantLooks(base, { time: ['night', 'golden-hour'], season: ['winter'], style: ['claymation'] });
  assert.deepEqual(single, [{ time: 'night' }, { time: 'golden-hour', season: 'winter' }, { time: 'golden-hour', style: 'claymation' }], 'one change each; the base’s own value is skipped');
  for (const v of single) assert.equal(lookDiff(base, v).length, 1);
  const p = lookLab();
  assert.deepEqual(single.map(v => variantLabel(p, base, v)), ['Night (vs base)', 'Winter (vs base)', 'Claymation (vs base)']);
  const combos = variantLooks({}, { time: ['night', 'dawn'], season: ['winter'] }, { combine: true });
  assert.deepEqual(combos, [{ time: 'night', season: 'winter' }, { time: 'dawn', season: 'winter' }]);
  assert.equal(variantLabel(p, {}, combos[0]), 'Night + Winter (vs base)');
  assert.throws(() => variantLooks({}, { time: ['midnight'] }), /Unknown time of day preset midnight/);
  assert.throws(() => variantLooks({}, { time: LOOK_AXES[0].presets.map(x => x.id), weather: LOOK_AXES[1].presets.map(x => x.id), season: LOOK_AXES[2].presets.map(x => x.id) }, { combine: true }), /at most 12/);
});

test('add_variants copies the base’s camera, blocking and text; a variant still is an edit of the base still that changes one thing', () => {
  const p = lookLab(), base = p.shots[0], walker = p.scene.entities.find(e => e.name === 'Walker');
  const [r] = applyOps(p, [{ op: 'add_variants', shotId: base.id, axes: { time: ['night'], wardrobe: ['cyberpunk'], style: ['anime', 'claymation'] } }]);
  assert.equal(r.ids.length, 4);
  const vs = r.ids.map(i => p.shots.find(s => s.id === i));
  assert.deepEqual(p.shots.slice(1, 5).map(s => s.id), r.ids, 'variants follow their base');
  for (const v of vs) { assert.equal(v.variantOf, base.id); assert.equal(shotSignature(p, v), shotSignature(p, base), `${v.title}: same blocking`); assert.equal(lookDiff(effectiveLook(p, base), effectiveLook(p, v)).length, 1); }
  assert.deepEqual(vs.map(v => v.title), ['a · Summer day (base) · Night (vs base)', 'a · Summer day (base) · Cyberpunk (vs base)', 'a · Summer day (base) · Anime (vs base)', 'a · Summer day (base) · Claymation (vs base)']);
  assert.deepEqual(applyOps(p, [{ op: 'add_variants', shotId: base.id, axes: { time: ['night'] } }])[0], { op: 'add_variants', ids: [], existing: [r.ids[0]], base: base.id }, 'an identical variant is reused');
  // The night variant: image 1 is the base still; the prompt changes only the time of day and keeps people, clothes and car.
  const night = variantStillRequest(p, vs[0], { at: 'start', t: 0, cap: 9 });
  assert.equal(night.guideReferenceId, base.references[0].id); assert.equal(night.model, 'nano-banana-2-1');
  assert.match(night.prompt, /^Edit image 1, the base still of this shot\. Change only this: the time of day: make it night/);
  assert.match(night.prompt, /every person's face, hair, build, pose and clothes; every vehicle, building and prop, with the same design, colour and position/);
  assert.ok(night.prompt.includes('No logos, badges, car emblems or readable text; no captions'));
  // Wardrobe: the clothes may change, nothing else about the person.
  assert.match(variantStillRequest(p, vs[1], { cap: 9 }).prompt, /Walker's clothes: dress them in cyberpunk clothes.*every person's face, hair, build and pose;/s);
  // Anime: Nano Banana 2.1 with no style reference. Claymation: a clay still as a style reference (Look Lab's j · Claymation).
  const anime = variantStillRequest(p, vs[2], { cap: 9 }), clay = variantStillRequest(p, vs[3], { cap: 9 });
  assert.equal(anime.model, 'nano-banana-2-1'); assert.equal(anime.styleRef, null); assert.deepEqual(anime.referenceIds, []);
  // The newest clay still in the project (Look Lab v2's stronger claymation).
  const newest = re => p.shots.filter(s => re.test(s.title) && !s.variantOf).flatMap(s => s.references.filter(x => x.role === 'frame')).sort((x, y) => x.createdAt.localeCompare(y.createdAt)).at(-1).id;
  assert.equal(clay.styleRef, newest(/Claymation/)); assert.deepEqual(clay.referenceIds, [clay.styleRef]); assert.match(clay.prompt, /Image 2 is a style reference: match its material and surface only/);
  assert.equal(styleReference(p, vs[2], 'anime')?.id, newest(/Anime/), 'a style reference exists for anime too; it is just not sent');
  // A subject swap drops that object's cast image, which would undo the swap.
  const look = { id: id(), name: 'Walker look', file: 'w.png', mime: 'image/png', role: 'look', entityId: walker.id, createdAt: '2026-11-03T00:00:00Z' };
  (p.scene.references ||= []).push(look); walker.look = look.id;
  assert.deepEqual(variantStillRequest(p, vs[0], { cap: 9 }).referenceIds, [look.id], 'a night variant keeps the walker’s image');
  const [sw] = applyOps(p, [{ op: 'add_variants', shotId: base.id, axes: { subject: [{ entityId: walker.id, text: 'a tall knight in silver armour' }] } }]);
  const knight = variantStillRequest(p, p.shots.find(s => s.id === sw.ids[0]), { cap: 9 });
  assert.deepEqual(knight.referenceIds, []); assert.match(knight.prompt, /Walker: replace it with a tall knight in silver armour, at the same size, position, pose and heading/);
  // No base still: nothing to edit.
  base.references = [];
  assert.throws(() => variantStillRequest(p, vs[0], { cap: 9 }), /Make the base shot's start still first/);
});

test('a variant still records its base still: a new base still dirties the variant, a variant’s look never dirties the base', () => {
  const p = lookLab(), base = p.shots[0], model = 'nano-banana-2-1';
  const [r] = applyOps(p, [{ op: 'add_variants', shotId: base.id, axes: { time: ['night'] } }]), v = p.shots.find(s => s.id === r.ids[0]);
  const k = stillKey(p, v, 'start', { model });
  assert.equal(k.parts.base, base.references[0].id);
  v.references.push({ id: id(), role: 'frame', note: 'key frame start', file: 'v.png', generated: { presetId: model, signature: shotSignature(p, v), regen: k } });
  const baseKey = stillKey(p, base, 'start', { model: 'gpt-image-25' }).key;
  base.references.push({ ...base.references[0], id: id() });
  const x = explainStale(p, { type: 'still', shotId: v.id, at: 'start' }, { model });
  assert.equal(x.state, 'stale'); assert.deepEqual(x.reasons.map(r => r.text), ['base still changed']);
  v.look = { time: 'dawn' };
  assert.equal(stillKey(p, base, 'start', { model: 'gpt-image-25' }).key, baseKey);
});

test('models: a walking character gets Seedance 2.5 edit (Kling O1 rushes the walker); no character gets Kling O1 edit', () => {
  const p = lookLab(), s = p.shots[0];
  assert.equal(variantModels(p, s, {}).video, 'seedance-25-edit-v1'); assert.match(variantModels(p, s, {}).why, /Kling O1 edit is cheaper but rushes/);
  const w = createProjectDocument({ template: 'wingspan' }, undefined, starters);
  assert.equal(variantModels(w, w.shots[0], {}).video, w.scene.entities.find(e => e.id === w.shots[0].camera.target).kind === 'character' ? 'seedance-25-edit-v1' : 'kling-o1-edit-v1');
  assert.deepEqual(presetOf('style', 'anime').model, { still: 'nano-banana-2-1', styleRef: false });
  assert.deepEqual(presetOf('style', 'claymation').model, { still: 'nano-banana-2-1', styleRef: true });
});

test('batch variants: one quote for base × {night, winter, claymation}, edits of the base still, the same blocking, a preview that cannot run', async () => {
  const p = lookLab(), base = p.shots[0];
  const fake = fakeBackend({});
  const batches = await openBatches(await mkdtemp(join(tmpdir(), 'previs-look-')), { drivers: fake.drivers, jobs: fake.jobs, loadProject: async () => structuredClone(p), addVariants: async () => { throw Error('not in a dry run'); } });
  const b = await batches.create({ projectId: p.id, dryRun: true, maxCostUsd: 20, variants: { shot: base.id, axes: { time: ['night'], season: ['winter'], style: ['claymation'] } } });
  assert.deepEqual(b.variants.list.map(v => v.label), ['Night (vs base)', 'Winter (vs base)', 'Claymation (vs base)']);
  assert.equal(b.variants.preview, true); assert.match(b.variants.why, /Seedance 2.5 edit keeps the blockout's timing/);
  const stills = b.nodes.filter(x => x.type === 'still'), videos = b.nodes.filter(x => x.type === 'video');
  assert.equal(stills.length, 3); assert.ok(stills.every(x => x.model === 'nano-banana-2-1' && x.target.t === 'start' && x.variant?.baseId === base.id));
  assert.ok(stills.every(x => x.breakdown.refs >= 1 && x.breakdown.refs <= 9), 'the base still counts as image 1; the cast is the upper bound');
  assert.ok(videos.every(x => x.model === 'seedance-25-edit-v1'));
  assert.ok(b.nodes.filter(x => x.type === 'blockout').every(x => /Same blocking as the base/.test(x.note)));
  assert.equal(b.estimateUsd, Math.round(b.nodes.filter(x => !['skipped', 'failed'].includes(x.status)).reduce((s, x) => s + x.estimateUsd, 0) * 10000) / 10000, 'one quote for the whole fan-out');
  assert.equal(p.shots.length, starters.find(s => s.slug === 'look-lab').shots.length, 'a dry run adds nothing');
  await assert.rejects(batches.resume(b.id), /preview of variants/);
  // Kling O1 on a walking character: advice, never a refusal.
  const k = await batches.create({ projectId: p.id, dryRun: true, maxCostUsd: 20, variants: { shot: base.id, axes: { time: ['night'] } }, models: { videos: 'kling-o1-edit-v1' } });
  assert.match(k.nodes.find(x => x.type === 'video').timingAdvice.message, /Kling O1 edit rushed a walking character/);
  // Combinations only when asked.
  const c = await batches.create({ projectId: p.id, dryRun: true, maxCostUsd: 20, variants: { shot: base.id, axes: { time: ['night', 'dawn'], season: ['winter'] }, combine: true } });
  assert.deepEqual(c.variants.list.map(v => v.label), ['Night + Winter (vs base)', 'Dawn + Winter (vs base)']);
  batches.close();
});

test('batch plan: a variant still without a base still is a plan error; with the base in the batch it waits for it', () => {
  const p = lookLab(), base = p.shots[0];
  addVariantShots(p, base.id, { axes: { time: ['night'] } }, id);
  const v = p.shots[1];
  base.references = [];
  const alone = planBatch(p, { steps: ['stills'], shots: [v.id], stillsAt: ['start'], models: { stills: 'nano-banana-2-1' }, maxCostUsd: 5, dryRun: true });
  assert.match(alone.nodes.find(x => x.type === 'still').error, /Needs the base shot’s start still/);
  const both = planBatch(p, { steps: ['stills'], shots: [base.id, v.id], stillsAt: ['start'], models: { stills: 'nano-banana-2-1' }, maxCostUsd: 5, dryRun: true });
  assert.deepEqual(both.nodes.find(x => x.target.shotId === v.id).deps, [`still:${base.id}start`]);
});

test('variantEditPrompt names every attribute that differs, so a combination says so', () => {
  const p = lookLab(), base = p.shots[0];
  addVariantShots(p, base.id, { axes: { time: ['night'], season: ['winter'] }, combine: true }, id);
  assert.match(variantEditPrompt(p, p.shots[1], base), /Change only these: the time of day: make it night.*; the season: make it winter/);
});

test('set_project and update_shot store looks; starters keep a shot’s look and variantOf in the copy', () => {
  const p = lookLab(), base = p.shots[0], walker = p.scene.entities.find(e => e.name === 'Walker');
  applyOps(p, [{ op: 'set_project', patch: { look: { mood: 'soft', weather: 'smog' } } }, { op: 'update_shot', id: base.id, patch: { look: { time: 'night', subjects: { [walker.id]: 'a knight' } } } }]);
  assert.deepEqual(p.look, { mood: 'soft' }); assert.deepEqual(base.look, { time: 'night', subjects: { [walker.id]: 'a knight' } });
  applyOps(p, [{ op: 'update_shot', id: base.id, patch: { look: null } }]); assert.equal(base.look, undefined);
  assert.throws(() => applyOps(p, [{ op: 'update_shot', id: base.id, patch: { variantOf: base.id } }]), /another shot/);
  // A starter copy renews shot and object ids: a variant still points at its (renewed) base, a swap at its (renewed) object.
  const snap = structuredClone(starters.find(s => s.slug === 'look-lab')), sw = snap.scene.entities.find(e => e.name === 'Walker');
  Object.assign(snap.shots[1], { variantOf: snap.shots[0].id, look: { time: 'night', subjects: { [sw.id]: 'a knight' } } });
  const copy = instantiateStarter(snap), cw = copy.scene.entities.find(e => e.name === 'Walker');
  assert.equal(copy.shots[1].variantOf, copy.shots[0].id); assert.notEqual(copy.shots[0].id, snap.shots[0].id);
  assert.deepEqual(copy.shots[1].look, { time: 'night', subjects: { [cw.id]: 'a knight' } });
});
