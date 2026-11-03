// The blockout is the camera: video prompts never describe the move, only which input to follow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument } from '../server/previs/director.mjs';
import { loadStarters } from '../server/previs/starters.mjs';
import { FINISHED_STARTERS, BLOCKOUT_STARTERS } from './helpers/starters.mjs';
import { builtInPresets } from '../server/previs/presets.mjs';
import { autoPromptText, autoPromptSegments, shotPrompt, shotStyle } from '../shared/prompt.mjs';
import { compilePrompt, describeCamera, MOVES, referenceLegend, videoReferences, keyStills, blockoutStale, shotSignature } from '../shared/director.mjs';
import { planBatch } from '../server/previs/batch.mjs';
import { readFile } from 'node:fs/promises';
import { CAMERA_LINES, cameraLine, cameraSourceOf, fitPrompt, lookMedium, motionInput, withCameraLine } from '../shared/camera-source.mjs';

const SOURCES = ['blockout', 'keyframes', 'still'];
const count = (text, part) => text.split(part).length - 1;
// Words the old camera sentence added: the move on its target, the lens class, the height/angle and the length.
// The medium a prompt repaints the blockout in ('' = photoreal): the project style, or for the used prompt the shot's own
// format and look sections where it overrides them (Look Lab's anime, claymation, 3D-animated and watercolour variants).
const mediumOf = (p, shot, used) => lookMedium(used ? ['intro', 'style'].map(k => shot.promptSections?.video?.[k]?.text ?? (k === 'style' ? p.scene.environment.style : '')).join(' ') : p.scene.environment.style);
const autoCamera = (shot, entities) => [describeCamera(shot, entities), ...Object.values(MOVES).map(m => `${m} on `), 'eye level', 'low angle', 'high angle', 'Follow the supplied camera motion', 'Preserve the supplied camera motion'];

test('starter video prompts carry no camera move, one camera line for the input, and lens/filter hints', async () => {
  const starters = await loadStarters();
  assert.deepEqual(starters.map(s => s.slug).sort(), [...FINISHED_STARTERS, ...BLOCKOUT_STARTERS].sort());
  for (const st of starters) {
    const p = createProjectDocument({ template: st.slug }, undefined, starters);
    for (const shot of p.shots) {
      // The action line is the shot's own description (with @handles named); it is kept as written.
      const where = `${st.slug} / ${shot.title}`, action = autoPromptSegments(p, shot, 'video').find(s => s.key === 'action').text.replace(/[.!?]$/, '');
      const style = shotStyle(shot);
      for (const cameraSource of SOURCES) {
        for (const [name, text] of [['auto-prompt', autoPromptText(p, shot, 'video', { cameraSource })], ['compiled', compilePrompt(p, shot, null, { cameraSource })], ['used', shotPrompt(p, shot, 'video', { cameraSource })]]) {
          for (const bad of autoCamera(shot, p.scene.entities)) assert.ok(!text.replace(action, '').includes(bad), `${where} ${name} (${cameraSource}) still says “${bad}”`);
          // Movement and cut tags describe the move; they stay out unless the shot's own action says so.
          for (const term of [...style.movement, ...style.cuts]) assert.ok(!text.replace(action, '').includes(term), `${where} ${name} keeps the “${term}” tag`);
          const medium = mediumOf(p, shot, name === 'used');
          assert.equal(count(text, cameraLine(cameraSource, medium)), 1, `${where} ${name} needs exactly one ${cameraSource} line${medium ? ` in ${medium}` : ''}`);
          if (medium && cameraSource === 'blockout') assert.doesNotMatch(text, /photoreal/i, `${where} ${name}: a ${medium} look is never repainted photoreal`);
          for (const other of SOURCES.filter(x => x !== cameraSource)) assert.equal(count(text, CAMERA_LINES[other]), 0);
          assert.match(text, /Lens: \d+mm/, `${where} ${name} keeps the lens hint`);
        }
        const auto = autoPromptText(p, shot, 'video', { cameraSource });
        for (const term of style.filter) assert.ok(auto.includes(term), `${where} keeps the “${term}” filter hint`);
        assert.ok(auto.includes(action), `${where} keeps the action line`);
      }
      // A still prompt never had motion; it still has no camera line.
      assert.equal(SOURCES.some(x => autoPromptText(p, shot, 'image').includes(CAMERA_LINES[x])), false);
    }
  }
});

test('the camera line comes from the model’s declared inputs', () => {
  const preset = id => builtInPresets.find(x => x.id === id);
  assert.equal(cameraSourceOf(preset('seedance-25-edit-v1')), 'blockout');
  assert.equal(cameraSourceOf(preset('kling-o1-edit-v1')), 'blockout');
  assert.equal(cameraSourceOf(preset('wan-vace-13b-edge-v1')), 'blockout');
  assert.equal(motionInput(preset('wan-vace-13b-edge-v1')), 'controlVideo');
  assert.equal(cameraSourceOf(preset('ltx-25-flf-v1')), 'keyframes');
  assert.equal(cameraSourceOf(preset('ltx-25-i2v-v1')), 'still');
  assert.equal(cameraSourceOf(preset('ltx-25-i2v-fast-v1')), 'still');
  // Generic: any declared reference-video input binds the blockout clip.
  assert.equal(cameraSourceOf({ inputs: { referenceVideo1: { nodeId: '9', input: 'file' }, firstFrame: { nodeId: '1', input: 'image' } } }), 'blockout');
  // Bound inputs win: a start → end model bound with only a start still animates one still.
  assert.equal(cameraSourceOf(preset('ltx-25-flf-v1'), { firstFrame: { renderId: 'a' } }), 'still');
  assert.equal(cameraSourceOf(preset('kling-o1-edit-v1'), { referenceImage1: { renderId: 'a' } }), 'still');
  assert.equal(cameraSourceOf(null), 'still');
});

test('edited prompts keep the user’s words but get the right camera line', async () => {
  const starters = await loadStarters();
  const p = createProjectDocument({ template: 'final-lap' }, undefined, starters), shot = p.shots[1];
  // An edit saved before this change, with the old camera sentence.
  shot.prompts = { video: { text: `My own draft shot. Camera: ${describeCamera(shot, p.scene.entities)}. Follow the supplied camera motion exactly. Lens: 35mm natural.`, edited: true } };
  const used = shotPrompt(p, shot, 'video', { cameraSource: 'blockout' });
  assert.ok(used.startsWith('My own draft shot.'));
  assert.ok(!used.includes('Truck right'));
  assert.equal(count(used, CAMERA_LINES.blockout), 1);
  assert.ok(used.includes('Lens: 35mm natural.'));
  // Switching to a still-only model swaps the line, never stacks a second one.
  const still = shotPrompt(p, shot, 'video', { cameraSource: 'still' });
  assert.equal(count(still, CAMERA_LINES.still), 1);
  assert.equal(count(still, CAMERA_LINES.blockout), 0);
  // No camera line at all: appended once.
  assert.equal(withCameraLine('A car passes.', 'keyframes'), `A car passes. ${CAMERA_LINES.keyframes}`);
  assert.equal(withCameraLine(withCameraLine('A car passes.', 'keyframes'), 'keyframes'), `A car passes. ${CAMERA_LINES.keyframes}`);
  // The prompt editor's camera chip says where the camera comes from.
  const seg = autoPromptSegments(p, shot, 'video', { cameraSource: 'blockout' }).find(s => s.key === 'camera');
  assert.equal(seg.text, CAMERA_LINES.blockout);
  assert.match(seg.source, /Blockout/);
});

test('a blockout-driven model gets the start and end stills first, then the cast; other callers are unchanged', async () => {
  const p = JSON.parse(await readFile(new URL('./fixtures/wingspan-project.json', import.meta.url), 'utf8'));
  const shot = p.shots[0], ref = (id, note) => ({ id, name: id, file: `${id}.png`, mime: 'image/png', role: 'frame', entityId: null, note, createdAt: '' });
  shot.references.push(ref('mid', 'key frame @2s'), ref('end', 'key frame end'));
  const ks = keyStills(shot);
  assert.equal(ks.end.id, 'end'); assert.equal(ks.start.note, 'key frame start');
  const led = videoReferences(p, shot, 4, { stills: true });
  assert.deepEqual(led.slice(0, 2).map(x => x.label), ['start still', 'end still']);
  assert.ok(led.length <= 4 && led.slice(2).every(x => x.role !== 'frame'), 'the cast follows the stills');
  // The stills already show the set: subjects fill the slots first, the environment only takes one that is left.
  const roles = led.slice(2).map(x => x.role), firstEnv = roles.indexOf('environment');
  assert.ok(firstEnv < 0 || roles.slice(firstEnv).every(r => r === 'environment' || r === 'style'), 'no subject after the set');
  assert.equal(referenceLegend(led.slice(0, 2)), 'Reference images: 1 = start still; 2 = end still.');
  const plain = videoReferences(p, shot, 4);
  assert.ok(plain.every(x => x.label !== 'start still'), 'stills prompts and other callers keep the old order');
});

test('a stale blockout is planned again; the video waits on the stills it will use as its look', async () => {
  const p = JSON.parse(await readFile(new URL('./fixtures/wingspan-project.json', import.meta.url), 'utf8'));
  const [valley, dive] = p.shots;
  assert.equal(blockoutStale(p, valley), false); assert.equal(valley.render.signature, shotSignature(p, valley));
  dive.duration += 1; // the camera timing changed after the blockout was made
  assert.equal(blockoutStale(p, dive), true);
  const { nodes } = planBatch(p, { steps: ['stills', 'videos'], maxCostUsd: 10, shots: [valley.id, dive.id], models: { videos: 'kling-o1-edit-v1' } });
  const by = id => nodes.find(n => n.id === id);
  assert.equal(by(`blockout:${valley.id}`).status, 'skipped');
  assert.equal(by(`blockout:${dive.id}`).status, 'waiting', 'made again');
  assert.ok(by(`video:${dive.id}`).deps.includes(`still:${dive.id}start`));
  assert.ok(by(`video:${dive.id}`).optional.includes(`still:${dive.id}start`), 'a failed still does not block the video');
});

test('tiers: draft animates a still (approximate camera), final follows the blockout; the plan says which per shot', async () => {
  const { TIERS } = await import('../shared/tiers.mjs');
  const preset = id => builtInPresets.find(x => x.id === id);
  assert.equal(cameraSourceOf(preset(TIERS.draft.videos)), 'still');
  assert.equal(cameraSourceOf(preset(TIERS.final.videos)), 'blockout');
  const p = JSON.parse(await readFile(new URL('./fixtures/wingspan-project.json', import.meta.url), 'utf8'));
  const video = (tier, extra = {}) => planBatch(p, { steps: ['stills', 'videos'], tier, maxCostUsd: 10, ...extra }).nodes.filter(n => n.type === 'video');
  for (const n of video('draft')) assert.deepEqual([n.cameraSource, n.camera], ['still', 'Camera: from still (approximate)']);
  for (const n of video('final')) {
    assert.deepEqual([n.cameraSource, n.camera], ['blockout', 'Camera: from blockout']);
    assert.ok(n.deps.some(d => d.endsWith('end')), 'final also makes the end still as the look');
  }
  for (const n of video('final', { models: { videos: 'ltx-25-flf-v1' } })) assert.equal(n.cameraSource, 'keyframes');
  // Without the stills step and without an end still, a start → end model falls back to its start-only sibling.
  const noEnd = planBatch(p, { steps: ['videos'], maxCostUsd: 10, shots: [p.shots[0].id], models: { videos: 'ltx-25-flf-v1' } }).nodes.find(n => n.type === 'video');
  assert.equal(noEnd.cameraSource, 'still');
});

test('a prompt over the model’s limit is shortened in its description, never in its camera line or legend', () => {
  const legend = 'Reference images: 1 = start still; 2 = Comfy car.';
  const long = `${'A very long cast description. '.repeat(120)}${CAMERA_LINES.blockout} Lens: 35mm.\n${legend}`;
  const fit = fitPrompt(long, 2500, 'blockout');
  assert.ok(fit.length <= 2500);
  assert.equal(count(fit, CAMERA_LINES.blockout), 1);
  assert.ok(fit.endsWith(legend));
  assert.equal(fitPrompt('short', 2500, 'blockout'), 'short');
});
