import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createProjectDocument, applyOps } from '../server/previs/director.mjs';
import { afterHoursSpec } from '../examples/after-hours/scene.mjs';
import { afterHoursH3 } from '../examples/after-hours/h3-workflow.mjs';
import { entityAt, shotCameraAt } from '../shared/director.mjs';
import { maxReferences, withReferenceImages } from '../shared/video-refs.mjs';
import { validateWorkflowDefinition } from '../server/previs/workflows.mjs';

test('the demo is one saved four-second scene with an explicit camera path and gentle car lift', () => {
  const p = createProjectDocument({ template: 'empty' }), spec = afterHoursSpec();
  applyOps(p, [{ op: 'set_scene', patch: spec.scene }, ...spec.entities.map(entity => ({ op: 'add_entity', entity })), { op: 'update_shot', id: p.shots[0].id, patch: spec.shot }]);
  assert.equal(p.shots.length, 1); assert.equal(p.shots[0].duration, 4);
  assert.equal(p.shots[0].camera.keys.length, 4);
  assert.deepEqual(p.shots[0].camera.keys.map(k => k.t), [0, .25, .75, 1], 'camera keys use normalized shot time');
  assert.notDeepEqual(shotCameraAt(p.shots[0], p.scene.entities, 0).p, shotCameraAt(p.shots[0], p.scene.entities, 4).p);
  assert.equal(p.scene.entities.filter(e => e.kind === 'character').length, 2);
  const car = p.scene.entities.find(e => e.id === spec.leads.car);
  assert.deepEqual(entityAt(car, 0).position, [0, .65, 0]);
  assert.deepEqual(entityAt(car, 4).position, [0, 1.4, 0]);
  assert.match(p.shots[0].description, /Video 1/);
  assert.ok(p.scene.entities.length < 200);
});

test('H3 uses the complete video and preserves authored reference and model wiring', () => {
  const d = validateWorkflowDefinition(afterHoursH3), before = JSON.stringify(d);
  assert.equal(d.task, 'transform-video');
  assert.equal(d.graph['2'].inputs['model.reference_videos.video_1'][0], d.inputs.sourceVideo.nodeId);
  assert.equal(d.inputs.firstFrame, undefined);
  assert.equal(maxReferences(d), 3);
  assert.equal(withReferenceImages(d, 3), d, 'do not rewrite an imported graph');
  assert.equal(JSON.stringify(d), before);
  assert.equal(d.pricing.status, 'unknown');
  assert.match(d.constraints.timingChange, /768P/);
});

test('the director picker exposes imported video workflows without a model-name allowlist', async () => {
  const source = await readFile(new URL('../src/director-videogen.ts', import.meta.url), 'utf8');
  const exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, require: () => ({}) });
  const imported = { ...afterHoursH3, id: 'private-model-graph' }, still = { id: 'image-only', task: 'image' };
  const choices = exports.videoChoices({ presets: [], definitions: [imported, still] });
  assert.deepEqual(Array.from(choices, x => x.id), ['private-model-graph']);
});

test('camera capture samples the actual 24-fps clock without speeding the motion to fit an extra endpoint', async () => {
  const source = await readFile(new URL('../src/director-capture.ts', import.meta.url), 'utf8');
  const line = source.split('\n').find(l => l.includes('const n =') && l.includes('at = (i: number)'));
  assert.ok(line);
  const context = { s: { duration: 4 } };
  runInNewContext(ts.transpileModule(line + '\nglobalThis.samples = { n, first: at(0), middle: at(48), last: at(n-1) };', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.samples)), { n: 96, first: 0, middle: 2, last: 95 / 24 });
});
