// Built-in aim sources for the Operate panel's aim pass: mouse/keys and gamepad right stick.
// The phone source registers itself from director-phone.ts against the same contract.
import { registerAimSource } from './director-aim';
import type { AimSource, Quat } from './director-aim';
import { quatFromYawPitch, yawPitchOf, padInput, defaultStickSettings } from '../shared/camera-operate.mjs';

/** Built-ins can start from the shot camera's orientation and take rate nudges (keys). */
export interface SeededAimSource extends AimSource { seed(q: Quat): void; nudge?(yawRate: number, pitchRate: number, dt: number): void }
export const isSeeded = (s: AimSource): s is SeededAimSource => typeof (s as SeededAimSource).seed === 'function';

const LIMIT = (85 * Math.PI) / 180;
const DEG = Math.PI / 180;

/** Yaw/pitch head that integrates rates; the shared core of the pointer and gamepad sources. */
function head() {
  let yaw = 0, pitch = 0, origin: Quat = [0, 0, 0, 1];
  return {
    seed(q: Quat) { ({ yaw, pitch } = yawPitchOf(q)); origin = q; },
    turn(dYaw: number, dPitch: number) { yaw += dYaw; pitch = Math.max(-LIMIT, Math.min(LIMIT, pitch + dPitch)); },
    rezero() { ({ yaw, pitch } = yawPitchOf(origin)); },
    q: (): Quat => quatFromYawPitch(yaw, pitch),
  };
}

/** Drag in the viewport to aim (0.2°/px), arrow keys / Q E via nudge. */
export function pointerAimSource(surface: () => HTMLElement | null = () => document.querySelector('canvas.main')): SeededAimSource {
  const hd = head();
  let drag: { id: number; x: number; y: number } | null = null;
  const down = (ev: PointerEvent) => {
    const el = surface();
    if (!el || ev.target !== el || ev.button !== 0) return;
    ev.stopPropagation(); ev.preventDefault();
    drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
  };
  const move = (ev: PointerEvent) => {
    if (!drag || ev.pointerId !== drag.id) return;
    hd.turn(-(ev.clientX - drag.x) * 0.2 * DEG, -(ev.clientY - drag.y) * 0.2 * DEG);
    drag.x = ev.clientX; drag.y = ev.clientY;
  };
  const up = (ev: PointerEvent) => { if (drag && ev.pointerId === drag.id) drag = null; };
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  return {
    id: 'pointer', label: 'Mouse + keys',
    connected: () => true,
    status: () => (drag ? 'Aiming…' : 'Drag in the viewport to aim · arrows / Q E turn'),
    orientation: () => hd.q(),
    seed: hd.seed, rezero: hd.rezero,
    nudge(yawRate, pitchRate, dt) { hd.turn(-yawRate * 70 * DEG * dt, pitchRate * 50 * DEG * dt); },
    dispose() {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    },
  };
}

export function padsNow(): Gamepad[] {
  try { return Array.from(navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => !!p?.connected); } catch { return []; }
}
/** Prefer a pad the browser has mapped to the standard layout. */
export const pickPad = () => { const pads = padsNow(); return pads.find(p => p.mapping === 'standard') ?? pads[0] ?? null; };

/**
 * Right stick pans and tilts at a rate (Game layout semantics, LB slow). Buttons are
 * handled by the Operate panel for every source, so this source has no onButton.
 */
export function gamepadAimSource(rate = { yaw: 70, pitch: 50 }): SeededAimSource {
  const hd = head();
  let last = performance.now();
  return {
    id: 'gamepad', label: 'Gamepad',
    connected: () => !!pickPad(),
    status: () => { const p = pickPad(); return p ? `${p.id} · right stick aims` : 'No controller — press any button on it'; },
    orientation() {
      const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
      const pad = pickPad();
      if (pad) { const i = padInput(pad, 'game', defaultStickSettings()); hd.turn(-i.yaw * rate.yaw * DEG * dt, i.pitch * rate.pitch * DEG * dt); }
      return hd.q();
    },
    seed(q) { hd.seed(q); last = performance.now(); },
    rezero: hd.rezero,
    dispose() {},
  };
}

registerAimSource('pointer', () => pointerAimSource());
registerAimSource('gamepad', () => gamepadAimSource());
