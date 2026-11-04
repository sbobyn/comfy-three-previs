// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Blockout editing behaviour for the director viewport: selection, modal
// (G/R/S) transforms, grid snapping, shortcut scope, framing and undo.
// Behaviour follows the Otter editor's conventions; this is an independent
// implementation, not a copy of Otter source.

// ---------- Selection: one primary id plus a set ----------
export class Selection {
  #primary = null;
  #ids = new Set();
  #listeners = new Set();
  get primary() { return this.#primary; }
  get ids() { return [...this.#ids]; }
  has(id) { return this.#ids.has(id); }
  get size() { return this.#ids.size; }
  /** Plain click: select only this. Clicking the sole selected object again clears. */
  click(id) {
    if (id && id === this.#primary && this.#ids.size === 1) return this.clear();
    this.#set(id ? [id] : [], id);
  }
  /** Shift+click adds (and makes primary). */
  add(id) { if (!id) return; const next = new Set(this.#ids); next.add(id); this.#set([...next], id); }
  /** Ctrl/Cmd+click toggles. */
  toggle(id) {
    if (!id) return;
    const next = new Set(this.#ids);
    if (next.has(id)) { next.delete(id); this.#set([...next], this.#primary === id ? [...next].at(-1) ?? null : this.#primary); }
    else { next.add(id); this.#set([...next], id); }
  }
  /** Marquee: add every id; the last becomes primary. */
  addMany(ids) { if (!ids.length) return; const next = new Set(this.#ids); for (const id of ids) next.add(id); this.#set([...next], ids.at(-1)); }
  set(ids, primary = ids.at(-1) ?? null) { this.#set(ids, primary); }
  clear() { this.#set([], null); }
  /** Drop ids that no longer exist. */
  retain(valid) { const keep = this.ids.filter(id => valid.has(id)); if (keep.length !== this.#ids.size) this.#set(keep, keep.includes(this.#primary) ? this.#primary : keep.at(-1) ?? null); }
  subscribe(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
  #set(ids, primary) {
    const same = primary === this.#primary && ids.length === this.#ids.size && ids.every(id => this.#ids.has(id));
    this.#ids = new Set(ids); this.#primary = primary && this.#ids.has(primary) ? primary : ids.at(-1) ?? null;
    if (!same) for (const fn of this.#listeners) fn(this);
  }
}

// ---------- Pointer gestures ----------
export const CLICK_SLOP = 4;       // px before a left press becomes a drag
export const RIGHT_CLICK_SLOP = 5; // px before a right press becomes a pan
export const isDrag = (a, b, slop = CLICK_SLOP) => Math.hypot(b.x - a.x, b.y - a.y) > slop;
export function marqueeRect(a, b) { return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) }; }
export const inRect = (p, r) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

// ---------- Modal transforms (G / R / S) ----------
// A transform is { position:[x,y,z], rotation: yawDegrees, scale:[x,y,z] }.
const AXIS = { x: 0, y: 1, z: 2 };
export function modalAxes(mode) { return mode === 'rotate' ? ['y'] : ['x', 'y', 'z']; }
export function computeModal({ mode, axis, start, startPointer, pointer, unitsPerPixel, cameraRight, cameraUp }) {
  const out = { position: [...start.position], rotation: start.rotation, scale: [...start.scale] };
  const dx = pointer.x - startPointer.x, dy = pointer.y - startPointer.y, gesture = dx - dy;
  if (mode === 'translate') {
    if (axis) out.position[AXIS[axis]] += gesture * unitsPerPixel;
    else for (let i = 0; i < 3; i++) out.position[i] += (cameraRight[i] * dx - cameraUp[i] * dy) * unitsPerPixel;
  } else if (mode === 'rotate') {
    out.rotation = start.rotation + (gesture * 0.01 * 180) / Math.PI;
  } else {
    const k = Math.max(0.01, Math.exp(gesture * 0.01));
    if (axis) out.scale[AXIS[axis]] *= k; else out.scale = out.scale.map(v => v * k);
  }
  return out;
}
/** Typed amount: metres for move, degrees for rotate, a multiplier for scale. */
export function computeModalNumeric(mode, axis, start, value) {
  const out = { position: [...start.position], rotation: start.rotation, scale: [...start.scale] };
  if (mode === 'translate') out.position[AXIS[axis ?? 'x']] += value;
  else if (mode === 'rotate') out.rotation = start.rotation + value;
  else if (axis) out.scale[AXIS[axis]] *= value;
  else out.scale = out.scale.map(v => v * value);
  return out;
}
/** Feed a key to a running modal. Returns { handled, commit?, cancel? } and mutates state. */
export function modalKey(state, key) {
  if (key === 'Enter') return { handled: true, commit: true };
  if (key === 'Escape') return { handled: true, cancel: true };
  if (key === 'Backspace') { state.numeric = state.numeric.slice(0, -1); return { handled: true }; }
  if (/^[0-9.]$/.test(key) || key === '-') {
    // A minus sign only leads; elsewhere it is swallowed so it cannot reach other shortcuts.
    if (!(key === '.' && state.numeric.includes('.')) && !(key === '-' && state.numeric)) state.numeric += key;
    return { handled: true };
  }
  const axis = key.toLowerCase();
  if (modalAxes(state.mode).includes(axis) && key.length === 1) { state.axis = state.axis === axis ? null : axis; return { handled: true }; }
  if (['x', 'z'].includes(axis) && state.mode === 'rotate') return { handled: true };
  return { handled: false };
}
export function modalHud(state) {
  const verb = state.mode === 'translate' ? 'Move' : state.mode === 'rotate' ? 'Rotate' : 'Resize';
  const amount = state.numeric ? `${state.numeric}${state.mode === 'rotate' ? '°' : state.mode === 'scale' ? '×' : ' m'}` : null;
  return [verb, amount, state.axis ? `${state.axis.toUpperCase()} axis` : state.mode === 'rotate' ? 'Vertical axis' : null, state.snap && state.mode === 'translate' ? `snap ${state.step} m` : null, 'Click/Enter confirm · Esc cancel'].filter(Boolean).join(' · ');
}

// Rigid multi-object edit: apply the primary's change to every selected object.
export function rigidApply(primaryStart, primaryNow, others) {
  const dYaw = primaryNow.rotation - primaryStart.rotation;
  const k = primaryNow.scale.map((v, i) => (primaryStart.scale[i] ? v / primaryStart.scale[i] : 1));
  const r = (dYaw * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return others.map(o => {
    const off = o.position.map((v, i) => (v - primaryStart.position[i]) * k[i]);
    const rx = off[0] * c + off[2] * s, rz = -off[0] * s + off[2] * c;
    return { position: [primaryNow.position[0] + rx, primaryNow.position[1] + off[1], primaryNow.position[2] + rz], rotation: o.rotation + dYaw, scale: o.scale.map((v, i) => v * k[i]) };
  });
}

// ---------- Grid ----------
/** ~32 px between minor lines, in powers of ten. */
export function gridStep(unitsPerPixel, targetPx = 32) {
  const ideal = unitsPerPixel * targetPx, lower = 10 ** Math.floor(Math.log10(ideal));
  return Math.log10(ideal / lower) < 0.5 ? lower : lower * 10;
}
export const unitsPerPixel = (distance, fovDeg, viewportHeight) => (2 * distance * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, viewportHeight);
/** Holding Ctrl inverts the saved snap preference. */
export const snapActive = (persisted, ctrl) => persisted !== ctrl;
export function snap(value, step) { const v = Math.round(value / step) * step; return Object.is(v, -0) ? 0 : +v.toFixed(6); }
/** Snap the shared delta, so spacing between selected objects is kept. */
export function snapDelta(delta, step, axes = [true, true, true]) { return delta.map((d, i) => (axes[i] ? snap(d, step) : d)); }

// ---------- Framing ----------
export function framingDistance(radius, fovDeg, aspect) {
  const v = ((fovDeg * Math.PI) / 180) / 2, h = Math.atan(Math.tan(v) * Math.max(aspect, 0.01));
  return Math.max(0.1, radius / Math.sin(Math.min(v, h))) * 1.15;
}

// ---------- Shortcut scope ----------
const KEY_CONSUMERS = 'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="spinbutton"], [role="tablist"], [role="menu"], [role="menubar"], [role="radiogroup"], [role="listbox"], [role="tree"], [role="grid"], [role="slider"], [role="separator"], [role="application"], dialog[open]';
const NATIVE_KEYS = new Set(['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
/** A focused control that uses a key keeps it. */
export function targetConsumesKey(target, key) {
  if (!target || typeof target.closest !== 'function') return false;
  if (target.closest(KEY_CONSUMERS)) return true;
  return NATIVE_KEYS.has(key) && Boolean(target.closest('button, a[href], summary'));
}

// ---------- Undo ----------
/** Each entry holds the ops to redo and the ops that undo it. */
export class UndoStack {
  #done = []; #undone = [];
  constructor(limit = 100) { this.limit = limit; }
  push(entry) { this.#done.push(entry); if (this.#done.length > this.limit) this.#done.shift(); this.#undone = []; }
  takeUndo() { const e = this.#done.pop(); if (e) this.#undone.push(e); return e ?? null; }
  takeRedo() { const e = this.#undone.pop(); if (e) this.#done.push(e); return e ?? null; }
  /** Put an entry back if replay failed. */
  restore(entry, wasUndo) { if (wasUndo) { this.#undone.pop(); this.#done.push(entry); } else { this.#done.pop(); this.#undone.push(entry); } }
  get canUndo() { return this.#done.length > 0; }
  get canRedo() { return this.#undone.length > 0; }
  peekUndo() { return this.#done.at(-1) ?? null; }
  peekRedo() { return this.#undone.at(-1) ?? null; }
}
/** Ops that recreate an entity exactly (used to undo a delete). */
export function recreateOps(entity, project) {
  const ops = [{ op: 'add_entity', entity: structuredClone(entity) }];
  for (const s of project.shots) {
    if (s.camera.target === entity.id) ops.push({ op: 'update_shot', id: s.id, patch: { camera: { target: entity.id } } });
    for (const r of s.references) if (r.entityId === entity.id) ops.push({ op: 'update_reference', shotId: s.id, referenceId: r.id, patch: { entityId: entity.id } });
  }
  return ops;
}
