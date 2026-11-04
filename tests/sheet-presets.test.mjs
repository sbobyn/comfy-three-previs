import test from 'node:test';
import assert from 'node:assert/strict';
import { setsFor, planSlots, viewPrompt, editViewPrompt, normalizeSheets, slotPick, slotAspect, MAX_SHEET_SLOTS } from '../shared/sheet-presets.mjs';
import { makeEntity } from '../shared/director.mjs';

test('sets are adapted per object kind', () => {
  assert.deepEqual(setsFor('character').map(s => s.id), ['turn3', 'turn4', 'turn8', 'heads3', 'poses3', 'expressions', 'custom']);
  assert.deepEqual(setsFor('vehicle').map(s => s.id), ['obj-turn4', 'obj-turn8', 'details', 'custom']);
  assert.deepEqual(setsFor('environment').map(s => s.id), ['establishing', 'custom']);
  assert.equal(planSlots('obj-turn4', 'vehicle', { top: true }).length, 5);
  assert.equal(planSlots('expressions', 'character', { pack: 'acting9', intensities: ['subtle', 'strong'], angle: 'both' }).length, 36);
  assert.equal(planSlots('expressions', 'character', { pack: 'mouth', intensities: ['subtle', 'strong'] }).length, 8);
  for (const kind of ['character', 'vehicle', 'prop', 'environment']) for (const s of setsFor(kind)) assert.ok(planSlots(s.id, kind).length <= MAX_SHEET_SLOTS);
  assert.equal(slotAspect({ framing: 'whole', angle: 'left' }, 'vehicle'), '16:9');
});

test('view prompts keep design lettering, forbid added text and qualify left/right', () => {
  const [, side] = planSlots('turn3', 'character');
  const p = viewPrompt({ kind: 'character', spec: side.spec, description: 'yellow Comfy T-shirt' });
  assert.match(p, /first reference image/);
  assert.match(p, /viewer’s left/);
  assert.match(p, /Keep any lettering or logos that are part of the design/);
  assert.doesNotMatch(p, /No text/);
  const car = viewPrompt({ kind: 'vehicle', spec: planSlots('obj-turn4', 'vehicle')[1].spec });
  assert.match(car, /front of the vehicle pointing toward the left edge/);
  assert.doesNotMatch(car, /character/);
  assert.match(editViewPrompt({ kind: 'prop', instruction: 'make it red', hasIdentity: true }), /second reference image is the original object design/);
});

test('sheets persist on the entity; accepted/selected must name a real attempt', () => {
  const sheets = [{ id: 'abc', setId: 'turn3', label: 'Turnaround · 3', slots: [{ id: 'front', label: 'Front', spec: { framing: 'full', angle: 'front' }, attempts: [{ id: 'a1', referenceId: null }, { id: 'a2', referenceId: '11111111-1111-1111-1111-111111111111' }], selected: 'a1', accepted: 'missing' }] }];
  const e = makeEntity({ name: 'Hero', shape: 'person', sheets }, 'e1');
  assert.equal(e.sheets[0].slots[0].accepted, null);
  assert.equal(slotPick(e.sheets[0].slots[0]).id, 'a2');
  const updated = makeEntity({ ...e, notes: 'changed' }, 'e1');
  assert.deepEqual(updated.sheets, e.sheets);
  assert.equal('sheets' in makeEntity({ name: 'Plain' }, 'e2'), false);
  assert.equal(normalizeSheets([]), null);
});
