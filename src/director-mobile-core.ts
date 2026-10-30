// Pure helpers for the mobile layer (no DOM, no WebGL) so they run under node --test.
export type Tier = 'compact' | 'medium' | null;
export type Detent = 'peek' | 'half' | 'full';
export type Gesture = 'tap' | 'long-press' | 'drag' | 'pinch' | 'twist' | 'pending';
export type Pt = { x: number; y: number };

export const COMPACT_MAX = 699, MEDIUM_MAX = 1023, SHORT_MAX = 500;
export const SLOP = 8, LONG_PRESS_MS = 450, LIFT_MS = 300, FLICK = 0.5;
export const QUERIES = {
  compact: `(max-width: ${COMPACT_MAX}px)`,
  medium: `(min-width: ${COMPACT_MAX + 1}px) and (max-width: ${MEDIUM_MAX}px)`,
  touch: '(pointer: coarse)',
  short: `(max-height: ${SHORT_MAX}px)`,
};

/** Width tier from a matchMedia-like function; null = desktop (mobile layer off). */
export function tierOf(mm: (q: string) => { matches: boolean }): { tier: Tier; touch: boolean; short: boolean; classes: string[] } {
  const compact = mm(QUERIES.compact).matches, medium = !compact && mm(QUERIES.medium).matches;
  const touch = mm(QUERIES.touch).matches, short = mm(QUERIES.short).matches && (compact || medium);
  // Phone landscape (wide but short) behaves like compact: theatre.
  const tier: Tier = compact ? 'compact' : medium ? (short ? 'compact' : 'medium') : null;
  const classes = [tier && `m-${tier}`, touch && 'm-touch', tier && short && 'm-short'].filter(Boolean) as string[];
  return { tier, touch, short: !!tier && short, classes };
}

const ORDER: Detent[] = ['peek', 'half', 'full'];
/** Where a sheet settles after a drag: a flick (|vy| ≥ 0.5 px/ms) moves one detent; otherwise the nearest by distance dragged.
 *  dy > 0 is downwards. Returns null to dismiss (dragged/flicked down past peek). */
export function nextDetent(current: Detent, dy: number, vy: number, heights: Record<Detent, number> = { peek: 160, half: 440, full: 780 }): Detent | null {
  const i = ORDER.indexOf(current);
  if (Math.abs(vy) >= FLICK) { const j = i + (vy > 0 ? -1 : 1); return j < 0 ? null : ORDER[Math.min(ORDER.length - 1, j)]; }
  const h = heights[current] - dy;
  if (h < heights.peek * 0.6) return null;
  let best: Detent = 'peek', bestD = Infinity;
  for (const d of ORDER) { const dd = Math.abs(heights[d] - h); if (dd < bestD) { bestD = dd; best = d; } }
  return best;
}

/** Rubber band past the end: full resistance after the limit. */
export const rubber = (over: number, k = 0.35) => (over <= 0 ? over : over * k);

/** Classify a touch from its start/end points (one array entry per finger) and elapsed ms. */
export function classify(start: Pt[], end: Pt[], dt: number, ended = true): Gesture {
  if (start.length >= 2 && end.length >= 2) {
    const d0 = dist(start[0], start[1]), d1 = dist(end[0], end[1]);
    const a = angleDelta(start, end);
    if (Math.abs(a) >= 12) return 'twist';
    if (d0 > 0 && Math.abs(d1 / d0 - 1) >= 0.08) return 'pinch';
    return Math.max(dist(start[0], end[0]), dist(start[1], end[1])) > SLOP ? 'drag' : 'pending';
  }
  if (!start.length || !end.length) return 'pending';
  if (dist(start[0], end[0]) > SLOP) return 'drag';
  if (dt >= LONG_PRESS_MS) return 'long-press';
  return ended ? 'tap' : 'pending';
}
export const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
/** Signed rotation (degrees) of the line between two fingers. */
export function angleDelta(start: Pt[], end: Pt[]) {
  const a0 = Math.atan2(start[1].y - start[0].y, start[1].x - start[0].x), a1 = Math.atan2(end[1].y - end[0].y, end[1].x - end[0].x);
  let d = ((a1 - a0) * 180) / Math.PI;
  while (d > 180) d -= 360; while (d < -180) d += 360;
  return d;
}

/** Row index a dragged row lands on, from its start index and the vertical travel. */
export function reorderIndex(from: number, dy: number, rowH: number, count: number) {
  return Math.max(0, Math.min(count - 1, from + Math.round(dy / Math.max(1, rowH))));
}
/** The list after moving one item. */
export function moved<T>(list: T[], from: number, to: number): T[] { const out = [...list]; const [m] = out.splice(from, 1); out.splice(to, 0, m); return out; }

/** Synthetic pointer offsets that make the scene's G/R/S modal follow a gesture.
 *  The modal maps a pointer move to `gesture = dx - dy` px; rotate = gesture × 0.01 rad, resize = exp(gesture × 0.01).
 *  So 100 px per radian of twist and 100 px per unit of ln(pinch ratio). */
export const modalOffset = { rotate: (deg: number) => -(deg * Math.PI) / 180 * 100, scale: (ratio: number) => Math.log(Math.max(0.05, ratio)) * 100 };

/** Ray from a pinhole camera (three.js conventions: focal length on a 35 mm film gauge) through a canvas point, hit on the plane y = h. */
export function floorHit(cam: { p: number[]; look: number[]; mm: number }, ndcX: number, ndcY: number, aspect: number, h = 0): [number, number, number] | null {
  const f = norm(sub(cam.look, cam.p)); if (!f) return null;
  const r = norm(cross(f, [0, 1, 0])); if (!r) return null;
  const u = cross(r, f);
  const tanV = (0.5 * (35 / Math.max(aspect, 1))) / Math.max(1, cam.mm);
  const d = [0, 1, 2].map(i => f[i] + r[i] * ndcX * tanV * aspect + u[i] * ndcY * tanV);
  if (Math.abs(d[1]) < 1e-6) return null;
  const t = (h - cam.p[1]) / d[1]; if (t <= 0) return null;
  return [cam.p[0] + d[0] * t, h, cam.p[2] + d[2] * t];
}
const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-9 ? a.map(v => v / l) : null; };

/** Up to `max` labels to show on a phone: selected first, then characters, vehicles, props by screen size; environment only when selected. */
export function pickLabels(items: { id: string; kind: string; size: number; selected: boolean }[], max = 4) {
  const rank = (k: string) => ['character', 'vehicle', 'prop', 'environment'].indexOf(k);
  return items.filter(i => i.selected || i.kind !== 'environment').sort((a, b) => Number(b.selected) - Number(a.selected) || rank(a.kind) - rank(b.kind) || b.size - a.size).slice(0, max).map(i => i.id);
}
