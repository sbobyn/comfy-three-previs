// Touch layer over the viewport canvas. Plain taps, orbit and pinch-zoom stay with the scene and OrbitControls;
// a finger that lands on the selected object is taken over here: drag = move on the floor, twist = rotate, pinch = resize.
import { snap } from '../shared/editor-controls.mjs';
import type { Vec3 } from '../shared/director.mjs';
import type { MobileCtx } from './director-mobile';
import { SLOP, LONG_PRESS_MS, dist, angleDelta, modalOffset, floorHit } from './director-mobile-core';
import type { Pt } from './director-mobile-core';
import { toast } from './director-common';

type Mode = 'pending' | 'pass' | 'move' | 'modal' | 'two' | 'done';
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function installGestures(c: MobileCtx) {
  const canvas = c.viewport.querySelector<HTMLCanvasElement>('canvas.main')!;
  const pts = new Map<number, Pt & { x0: number; y0: number }>();
  const synth = new WeakSet<Event>();
  const owned = new Set<number>(); // pointers whose pointerdown we swallowed: the scene never sees them
  let mode: Mode | null = null, on: string | null = null, lp = 0, t0 = 0, hinted = false;
  let lastTap: { t: number; x: number; y: number } | null = null;
  let mv: { ids: string[]; starts: Map<string, Vec3>; y: number; hit0: Vec3 } | null = null;
  let base: Pt = { x: 0, y: 0 }, modalKind: 'translate' | 'rotate' | 'scale' | null = null, two: Pt[] = [];

  /** The selected object (or selected group holding it) under a screen point. */
  const selectedAt = (x: number, y: number) => { for (let e = c.entity(c.scene.pick(x, y)); e; e = e.parent ? c.entity(e.parent) : null) if (c.selection.has(e.id)) return e.id; return null; };
  const swallow = (ev: Event) => { ev.stopImmediatePropagation(); ev.preventDefault(); };
  const feed = (dx: number, dy: number) => { const e = new PointerEvent('pointermove', { clientX: base.x + dx, clientY: base.y + dy }); synth.add(e); window.dispatchEvent(e); };
  const cam = () => { const r = canvas.getBoundingClientRect(); return { r, v: c.scene.worldView() }; };
  const floorAt = (x: number, y: number, h: number) => { const { r, v } = cam(); return floorHit(v, ((x - r.left) / r.width) * 2 - 1, -(((y - r.top) / r.height) * 2 - 1), r.width / Math.max(1, r.height), h) as Vec3 | null; };

  function beginModal(kind: 'translate' | 'rotate' | 'scale') {
    if (!c.scene.beginModal(kind)) { mode = 'done'; return false; }
    const r = canvas.getBoundingClientRect();
    base = c.scene.pointerInViewport() ? c.scene.lastPointer() : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    modalKind = kind; mode = 'modal'; navigator.vibrate?.(8);
    return true;
  }
  function startMove(p: Pt) {
    const ids = c.selection.ids, list = ids.map(id => c.entity(id)!).filter(Boolean);
    // Animated or parented objects go through the scene's modal move (keys and parent space handled there).
    if (list.some(e => e.path?.length || e.parent || e.shape === 'group')) { beginModal('translate'); return; }
    const y = c.entity(on)?.position[1] ?? 0, hit0 = floorAt(p.x, p.y, y);
    if (!hit0) { mode = 'done'; return; }
    mv = { ids, starts: new Map(list.map(e => [e.id, [...e.position] as Vec3])), y, hit0 };
    mode = 'move'; navigator.vibrate?.(8);
  }
  function updateMove(p: Pt) {
    if (!mv) return;
    const hit = floorAt(p.x, p.y, mv.y); if (!hit) return;
    let dx = hit[0] - mv.hit0[0], dz = hit[2] - mv.hit0[2];
    if (localStorage.getItem('previs.snap') === '1') { const s = c.scene.gridStep(); dx = snap(dx, s); dz = snap(dz, s); }
    for (const [id, s] of mv.starts) { const e = c.entity(id); if (e) e.position = [s[0] + dx, s[1], s[2] + dz]; }
    c.scene.sync(c.project(), c.shot());
  }
  function endMove(commit: boolean) {
    const m = mv; mv = null; if (!m) return;
    const now = [...m.starts.keys()].map(id => [id, c.entity(id)?.position.map(r3) as Vec3] as const);
    const moved = now.some(([id, p]) => p && p.some((v, i) => Math.abs(v - m.starts.get(id)![i]) > 1e-4));
    if (!commit || !moved) { for (const [id, s] of m.starts) { const e = c.entity(id); if (e) e.position = s; } c.scene.sync(c.project(), c.shot()); return; }
    const one = c.entity(now[0][0]);
    void c.runEntry({ label: now.length > 1 ? `Move ${now.length} objects` : `Move ${one?.name || 'object'}`,
      redo: now.map(([id, p]) => ({ op: 'update_entity', id, patch: { position: p } })),
      undo: now.map(([id]) => ({ op: 'update_entity', id, patch: { position: m.starts.get(id)!.map(r3) } })) });
  }
  const cancelAll = () => { clearTimeout(lp); if (mode === 'move') endMove(false); if (mode === 'modal' && c.scene.modalActive()) c.scene.finishModal(false); mode = 'done'; };

  function down(ev: PointerEvent) {
    if (ev.pointerType === 'mouse' || ev.target !== canvas || c.step() === 'cut') return;
    pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, x0: ev.clientX, y0: ev.clientY });
    if (pts.size === 1) {
      mode = 'pending'; t0 = performance.now(); on = null; owned.clear();
      if (c.scene.view() !== 'set') { mode = 'pass'; return; }
      on = selectedAt(ev.clientX, ev.clientY);
      if (on) { owned.add(ev.pointerId); swallow(ev); }
      const x = ev.clientX, y = ev.clientY;
      lp = window.setTimeout(() => {
        if (mode !== 'pending' || pts.size !== 1) return;
        mode = 'done'; navigator.vibrate?.(8);
        const hit = c.scene.pick(x, y);
        let id = hit; for (let e = c.entity(hit); e?.parent; e = c.entity(e.parent)) id = e.parent;
        if (id) c.objectActions(id); else c.openAddSheet(x, y);
      }, LONG_PRESS_MS);
    } else if (pts.size === 2) {
      clearTimeout(lp);
      if (!owned.size) { mode = 'pass'; return; } // orbit / pinch-zoom
      owned.add(ev.pointerId); swallow(ev);
      if (mode === 'move') endMove(false);
      if (mode === 'modal' && c.scene.modalActive()) c.scene.finishModal(false);
      two = [...pts.values()].map(p => ({ x: p.x, y: p.y })); mode = 'two';
    } else if (owned.size) { owned.add(ev.pointerId); swallow(ev); }
  }
  function move(ev: PointerEvent) {
    if (synth.has(ev)) return;
    const p = pts.get(ev.pointerId); if (!p) return;
    p.x = ev.clientX; p.y = ev.clientY;
    if (owned.has(ev.pointerId)) swallow(ev);
    if (mode === 'pending' && dist({ x: p.x0, y: p.y0 }, p) > SLOP) {
      clearTimeout(lp);
      if (!on) { mode = 'pass'; if (c.scene.view() !== 'set' && c.step() === 'build' && !hinted) { hinted = true; toast('Use Camera to aim, or Director view to arrange'); } return; }
      const m = c.scene.transformMode();
      if (m === 'translate') startMove(p); else beginModal(m);
    }
    if (pts.size === 1) {
      if (mode === 'move') updateMove(p);
      else if (mode === 'modal') feed(modalKind === 'scale' ? 0 : p.x - p.x0, modalKind === 'scale' ? p.y - p.y0 : modalKind === 'translate' ? p.y - p.y0 : 0);
    } else if (pts.size === 2 && (mode === 'two' || mode === 'modal')) {
      const now = [...pts.values()].map(q => ({ x: q.x, y: q.y }));
      const ang = angleDelta(two, now), ratio = dist(now[0], now[1]) / Math.max(1, dist(two[0], two[1]));
      if (mode === 'two') { if (Math.abs(ang) >= 12) beginModal('rotate'); else if (Math.abs(ratio - 1) >= 0.08) beginModal('scale'); }
      if (mode === 'modal') feed(modalKind === 'rotate' ? modalOffset.rotate(ang) : modalOffset.scale(ratio), 0);
    }
  }
  function up(ev: PointerEvent) {
    const p = pts.get(ev.pointerId); if (!p) return;
    const mine = owned.has(ev.pointerId);
    if (mine) swallow(ev);
    pts.delete(ev.pointerId); owned.delete(ev.pointerId);
    clearTimeout(lp);
    if (ev.type === 'pointercancel') { cancelAll(); return; }
    if (pts.size) { if (mode === 'modal' && modalKind !== 'translate') { c.scene.finishModal(true); mode = 'done'; } return; } // lifting one of two fingers ends a twist / pinch
    if (mode === 'move') endMove(true);
    else if (mode === 'modal' && c.scene.modalActive()) c.scene.finishModal(true);
    else if (mode === 'pending' && performance.now() - t0 < LONG_PRESS_MS) {
      const now = performance.now();
      if (lastTap && now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) { const id = c.scene.pick(p.x, p.y); if (id) c.scene.frame([id], 1.2); lastTap = null; }
      else lastTap = { t: now, x: p.x, y: p.y };
    }
    mode = null; on = null; modalKind = null;
  }
  addEventListener('pointerdown', down, true);
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
  addEventListener('pointercancel', up, true);
  canvas.addEventListener('contextmenu', ev => ev.preventDefault());
}
