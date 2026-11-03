// Edit-model prompts repaint the blockout in the shot's look: photoreal by default, the look's medium when it names one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument } from '../server/previs/director.mjs';
import { loadStarters } from '../server/previs/starters.mjs';
import { CAMERA_LINES, cameraLine, cameraMotionWords, fitPrompt, lookMedium, lookText, withCameraLine } from '../shared/camera-source.mjs';
import { shotPrompt, autoPromptText } from '../shared/prompt.mjs';
import { compilePrompt } from '../shared/director.mjs';
import { videoPromptPlan, stillPromptPlan } from '../shared/prompt-plan.mjs';
import { stillPrompt } from '../shared/still-match.mjs';
import { videoKey } from '../shared/regen.mjs';

const starters = await loadStarters();
const lookLab = () => createProjectDocument({ template: 'look-lab' }, undefined, starters);
const count = (text, part) => text.split(part).length - 1;
const MEDIA = { 'i · Anime': 'anime', 'j · Claymation': 'stop-motion claymation', 'k · Stylised 3D animated feature': 'stylised 3D animation', 'l · Watercolour': 'a watercolour painting',
  'ag · Anime (stronger)': 'anime', 'ah · Claymation (stronger)': 'stop-motion claymation' };

test('lookMedium names a non-photoreal medium and leaves photoreal looks to the default', () => {
  assert.equal(lookMedium('Look: hand-drawn anime, clean ink lines, flat cel shading.'), 'anime');
  assert.equal(lookMedium('Look: handmade plasticine stop-motion, fingerprinted clay texture.'), 'stop-motion claymation');
  assert.equal(lookMedium('Stylised 3D animated feature shot.'), 'stylised 3D animation');
  assert.equal(lookMedium('Look: loose watercolour in motion, soft bleeding washes.'), 'a watercolour painting');
  for (const t of ['Look: photoreal night, warm lamplight.', 'Photoreal, warm afternoon sun.', '', null]) assert.equal(lookMedium(t), '', String(t));
  // A camera line is not a look: the repaint words in it never feed back into the medium.
  assert.equal(lookMedium(cameraLine('blockout', 'anime')), '');
  // Only the format and look sentences of free text count, not the action.
  assert.equal(lookMedium(lookText('Cinematic live-action shot. A kid watches anime on TV. Look: photoreal, warm.')), '');
  assert.equal(lookMedium(lookText('Anime shot. A kid walks home.')), 'anime');
});

test('the blockout camera line says the medium, never photoreal, and the default stays photoreal', () => {
  assert.equal(cameraLine('blockout'), CAMERA_LINES.blockout);
  assert.match(CAMERA_LINES.blockout, /Repaint it photoreal/);
  const anime = cameraLine('blockout', 'anime');
  assert.match(anime, /^Follow the camera motion and framing of the blockout video exactly; it is the camera\. Repaint it as anime in the look of the still\.$/);
  assert.doesNotMatch(anime, /photoreal/i);
  // Other camera sources have no repaint words, so the medium does not change them.
  assert.equal(cameraLine('keyframes', 'anime'), CAMERA_LINES.keyframes);
  // A hand-written prompt with a look gets that medium's line, swapped in for any other camera line, exactly once.
  const edited = withCameraLine(`Anime shot. A car passes. ${CAMERA_LINES.blockout}`, 'blockout');
  assert.equal(count(edited, anime), 1); assert.doesNotMatch(edited, /photoreal/i);
  assert.equal(withCameraLine(edited, 'blockout'), edited, 'idempotent');
  assert.equal(count(withCameraLine(edited, 'still'), CAMERA_LINES.still), 1); assert.doesNotMatch(withCameraLine(edited, 'still'), /Repaint/);
  // Photoreal text loses a stale medium line again.
  assert.equal(withCameraLine(`A car passes. ${anime}`, 'blockout'), `A car passes. ${CAMERA_LINES.blockout}`);
  // Fitting to a model's limit keeps the medium line whole; it is not a camera instruction.
  const fit = fitPrompt(`Anime shot. ${'A very long description. '.repeat(100)}${anime}\nReference images: 1 = start still.`, 400, 'blockout');
  assert.ok(fit.length <= 400); assert.equal(count(fit, anime), 1); assert.match(fit, /\nReference images: 1 = start still\.$/);
  assert.deepEqual(cameraMotionWords(`A car passes. ${anime}`), []);
});

test('Look Lab: styled variants repaint in their medium, photoreal variants keep the photoreal line, all keep no-brands', () => {
  const p = lookLab();
  for (const shot of p.shots) {
    const medium = MEDIA[shot.title];
    for (const [name, text] of [['used', shotPrompt(p, shot, 'video', { cameraSource: 'blockout' })], ['plan', videoPromptPlan(p, shot, { cameraSource: 'blockout', maxLength: 2500 }).text]]) {
      if (medium) { assert.equal(count(text, cameraLine('blockout', medium)), 1, `${shot.title} ${name}`); assert.doesNotMatch(text, /photoreal/i, `${shot.title} ${name}`); }
      else assert.equal(count(text, CAMERA_LINES.blockout), 1, `${shot.title} ${name}`);
      assert.match(text, /no logos or lettering/, `${shot.title} ${name} keeps the no-brands tag`);
    }
    // The prompt inspector's camera row shows the line that is sent.
    const plan = videoPromptPlan(p, shot, { cameraSource: 'blockout', maxLength: 2500 });
    assert.ok(plan.text.includes(plan.sections.find(r => r.key === 'camera').text), shot.title);
    assert.equal(plan.sections.find(r => r.key === 'camera').status, 'included', shot.title);
    // Stills: the Gemini edit guide and the closing rule follow the look too.
    for (const presetId of ['nano-banana-2-1', 'gpt-image-25']) {
      const still = stillPromptPlan({ project: p, shot, presetId }).text;
      if (medium) { assert.doesNotMatch(still, /photoreal|photographic/i, `${shot.title} ${presetId}`); assert.ok(still.includes(`One single frame of ${medium};`), `${shot.title} ${presetId}`); }
      else assert.match(still, /One single photographic frame;/, `${shot.title} ${presetId}`);
      if (presetId === 'nano-banana-2-1') assert.match(still, medium ? new RegExp(`^Edit image 1: repaint this grey 3D blockout as ${medium}, one single frame\\.`) : /^Edit image 1: repaint this grey 3D blockout as one photoreal film frame\./, shot.title);
    }
  }
});

test('a project-wide look sets the medium for auto, compiled and still prompts; photoreal projects are unchanged', () => {
  const p = lookLab(), shot = p.shots[0], style = p.scene.environment.style;
  const before = { auto: autoPromptText(p, shot, 'video'), compiled: compilePrompt(p, shot), key: videoKey(p, shot, { cameraSource: 'blockout', model: 'seedance-25-edit-v1' }).key };
  assert.equal(count(before.auto, CAMERA_LINES.blockout), 1); assert.equal(count(before.compiled, CAMERA_LINES.blockout), 1);
  p.scene.environment.style = 'Watercolour storybook, soft washes. Keep every surface free of logos.';
  const line = cameraLine('blockout', 'a watercolour painting');
  for (const text of [autoPromptText(p, shot, 'video'), compilePrompt(p, shot), shotPrompt(p, shot, 'video')]) { assert.equal(count(text, line), 1); assert.doesNotMatch(text, /photoreal/i); }
  assert.match(stillPrompt({ project: p, shot, text: shotPrompt(p, shot, 'image'), presetId: 'nano-banana-2-1' }), /^Edit image 1: repaint this grey 3D blockout as a watercolour painting, one single frame\./);
  // The per-node key hashes the final prompt, so a new look is a new video key; a photoreal shot keeps its key.
  assert.notEqual(videoKey(p, shot, { cameraSource: 'blockout', model: 'seedance-25-edit-v1' }).key, before.key);
  p.scene.environment.style = style;
  assert.equal(videoKey(p, shot, { cameraSource: 'blockout', model: 'seedance-25-edit-v1' }).key, before.key);
});
