// The blockout is the camera: video prompts never describe the move, only which input to follow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument } from '../server/previs/director.mjs';
import { loadStarters } from '../server/previs/starters.mjs';
import { builtInPresets } from '../server/previs/presets.mjs';
import { autoPromptText, autoPromptSegments, shotPrompt, shotStyle } from '../shared/prompt.mjs';
import { compilePrompt, describeCamera, MOVES } from '../shared/director.mjs';
import { CAMERA_LINES, cameraSourceOf, motionInput, withCameraLine } from '../shared/camera-source.mjs';

const SOURCES = ['blockout', 'keyframes', 'still'];
const count = (text, part) => text.split(part).length - 1;
// Words the old camera sentence added: the move on its target, the lens class, the height/angle and the length.
const autoCamera = (shot, entities) => [describeCamera(shot, entities), ...Object.values(MOVES).map(m => `${m} on `), 'eye level', 'low angle', 'high angle', 'Follow the supplied camera motion', 'Preserve the supplied camera motion'];

test('starter video prompts carry no camera move, one camera line for the input, and lens/filter hints', async () => {
  const starters = await loadStarters();
  assert.deepEqual(starters.map(s => s.slug).sort(), ['breaking-news', 'final-lap', 'posterized', 'wingspan']);
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
          assert.equal(count(text, CAMERA_LINES[cameraSource]), 1, `${where} ${name} needs exactly one ${cameraSource} line`);
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
