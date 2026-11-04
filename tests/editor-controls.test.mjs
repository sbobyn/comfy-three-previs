import test from 'node:test';
import assert from 'node:assert/strict';
import { Selection, computeModal, computeModalNumeric, modalKey, modalHud, rigidApply, gridStep, snapActive, snap, snapDelta, framingDistance, targetConsumesKey, UndoStack, recreateOps, isDrag } from '../shared/editor-controls.mjs';

test('selection: click, re-click clears, shift adds, ctrl toggles, marquee adds', () => {
  const s = new Selection(); let events = 0; s.subscribe(() => events++);
  s.click('a'); assert.deepEqual(s.ids, ['a']); assert.equal(s.primary, 'a');
  s.click('a'); assert.deepEqual(s.ids, [], 'clicking the only selected object again deselects');
  s.click('a'); s.add('b'); assert.deepEqual(s.ids, ['a', 'b']); assert.equal(s.primary, 'b');
  s.toggle('b'); assert.deepEqual(s.ids, ['a']); assert.equal(s.primary, 'a');
  s.addMany(['c', 'd']); assert.deepEqual(s.ids, ['a', 'c', 'd']); assert.equal(s.primary, 'd');
  s.retain(new Set(['a', 'c'])); assert.deepEqual(s.ids, ['a', 'c']); assert.equal(s.primary, 'c');
  const before = events; s.set(['a', 'c'], 'c'); assert.equal(events, before, 'no event when nothing changed');
  assert.equal(isDrag({ x: 0, y: 0 }, { x: 3, y: 3 }), true); assert.equal(isDrag({ x: 0, y: 0 }, { x: 2, y: 2 }), false);
});

const start = { position: [1, 0, 2], rotation: 30, scale: [1, 1, 1] };
test('modal maths: screen move, axis move, rotate in degrees, scale, typed values', () => {
  const base = { start, startPointer: { x: 0, y: 0 }, unitsPerPixel: 0.01, cameraRight: [1, 0, 0], cameraUp: [0, 1, 0] };
  assert.deepEqual(computeModal({ ...base, mode: 'translate', axis: null, pointer: { x: 100, y: -50 } }).position, [2, 0.5, 2]);
  assert.deepEqual(computeModal({ ...base, mode: 'translate', axis: 'z', pointer: { x: 100, y: 0 } }).position, [1, 0, 3]);
  assert.ok(Math.abs(computeModal({ ...base, mode: 'rotate', axis: null, pointer: { x: 157.08, y: 0 } }).rotation - 120) < 0.01);
  assert.ok(Math.abs(computeModal({ ...base, mode: 'scale', axis: null, pointer: { x: 69.3147, y: 0 } }).scale[0] - 2) < 0.001);
  assert.deepEqual(computeModalNumeric('translate', null, start, 2).position, [3, 0, 2], 'typed move defaults to X');
  assert.equal(computeModalNumeric('rotate', null, start, 90).rotation, 120);
  assert.deepEqual(computeModalNumeric('scale', 'y', start, 3).scale, [1, 3, 1]);
});

test('modal keys: axis toggle, signed numbers, backspace, confirm and cancel', () => {
  const st = { mode: 'translate', axis: null, numeric: '' };
  modalKey(st, 'x'); assert.equal(st.axis, 'x'); modalKey(st, 'x'); assert.equal(st.axis, null);
  for (const k of ['-', '1', '.', '5', '.', '0']) modalKey(st, k);
  assert.equal(st.numeric, '-1.50', 'second dot ignored');
  modalKey(st, 'Backspace'); assert.equal(st.numeric, '-1.5');
  assert.equal(modalKey(st, '-').handled, true); assert.equal(st.numeric, '-1.5', 'minus only leads');
  assert.equal(modalKey(st, 'Enter').commit, true); assert.equal(modalKey(st, 'Escape').cancel, true);
  assert.equal(modalKey({ mode: 'rotate', axis: null, numeric: '' }, 'x').handled, true, 'rotate swallows X/Z (vertical axis only)');
  assert.equal(modalKey(st, 'q').handled, false);
  assert.match(modalHud({ mode: 'translate', axis: 'x', numeric: '1.5' }), /Move · 1.5 m · X axis · Click\/Enter confirm · Esc cancel/);
});

test('rigid multi-object transforms keep relative layout', () => {
  const p0 = { position: [0, 0, 0], rotation: 0, scale: [1, 1, 1] };
  const other = { position: [2, 0, 0], rotation: 10, scale: [1, 1, 1] };
  const [moved] = rigidApply(p0, { ...p0, position: [1, 0, 1] }, [other]);
  assert.deepEqual(moved.position, [3, 0, 1]);
  const [turned] = rigidApply(p0, { ...p0, rotation: 90 }, [other]);
  assert.ok(Math.abs(turned.position[0]) < 1e-9 && Math.abs(turned.position[2] + 2) < 1e-9, 'orbits the primary like three.js yaw');
  assert.equal(turned.rotation, 100);
  const [grown] = rigidApply(p0, { ...p0, scale: [2, 2, 2] }, [other]);
  assert.deepEqual(grown.position, [4, 0, 0]); assert.deepEqual(grown.scale, [2, 2, 2]);
});

test('grid, snapping and framing', () => {
  assert.equal(gridStep(0.005), 0.1); assert.equal(gridStep(0.01), 1, 'rounds up past the half-decade'); assert.equal(gridStep(0.05), 1); assert.equal(gridStep(0.2), 10);
  assert.equal(snapActive(false, true), true); assert.equal(snapActive(true, true), false);
  assert.equal(snap(1.26, 0.5), 1.5); assert.equal(snap(-0.1, 1), 0);
  assert.deepEqual(snapDelta([0.26, 1.74, -0.4], 0.5), [0.5, 1.5, -0.5]);
  const d = framingDistance(1, 45, 16 / 9);
  assert.ok(d > 2.9 && d < 3.1);
});

test('shortcut scope keeps keys for fields, menus and focused buttons', () => {
  const el = sel => ({ closest: q => (q.split(',').map(x => x.trim()).includes(sel) ? {} : null) });
  assert.equal(targetConsumesKey(el('input'), 'g'), true);
  assert.equal(targetConsumesKey(el('[role="menu"]'), 'x'), true);
  assert.equal(targetConsumesKey(el('button'), 'Enter'), true);
  assert.equal(targetConsumesKey(el('button'), 'g'), false);
  assert.equal(targetConsumesKey(null, 'g'), false);
});

test('undo stack and delete recreation ops', () => {
  const u = new UndoStack(2);
  u.push({ label: 'a', redo: [1], undo: [2] }); u.push({ label: 'b', redo: [], undo: [] }); u.push({ label: 'c', redo: [], undo: [] });
  assert.equal(u.takeUndo().label, 'c'); assert.equal(u.takeUndo().label, 'b'); assert.equal(u.takeUndo(), null, 'limit drops oldest');
  assert.equal(u.takeRedo().label, 'b'); u.push({ label: 'd', redo: [], undo: [] }); assert.equal(u.canRedo, false, 'new edit clears redo');
  const e = { id: 'e1', name: 'Runner' };
  const ops = recreateOps(e, { shots: [{ id: 's1', camera: { target: 'e1' }, references: [{ id: 'r1', entityId: 'e1' }] }] });
  assert.deepEqual(ops.map(o => o.op), ['add_entity', 'update_shot', 'update_reference']);
});
