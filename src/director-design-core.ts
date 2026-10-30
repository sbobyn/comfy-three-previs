// Pure helpers for the Cut overlay and compare strip, the cast list's look families and the Generate dialog
// (no DOM, no WebGL) so they run under node --test.

// ---------- Overlay: boxes, chips and prompt excerpts ----------
export type Box = { id: string; x0: number; y0: number; x1: number; y1: number };
/** `hero`: 2 when the prompt describes the object, 1 when it only has a cast image, 0 for bare set dressing. */
export type CastLite = { id: string; kind: string; lead: boolean; coverage: number; hero?: number };

/**
 * The objects worth boxing: the subject, then hero cast by frame coverage; never the environment; at most `max`.
 * Objects the prompt doesn't describe are boxed only when fewer than two described ones are in frame.
 */
export function overlayCast(cast: CastLite[], max = 4): CastLite[] {
  const sorted = cast.filter(c => c.kind !== 'environment').sort((a, b) => (Number(b.lead) - Number(a.lead)) || ((b.hero || 0) - (a.hero || 0)) || (b.coverage - a.coverage));
  const strong = sorted.filter(c => c.lead || c.hero === 2);
  return (strong.length >= 2 ? strong : sorted).slice(0, max);
}

/** A 6–10-word excerpt: the first clause when it is 6–10 words, else the first 10 words with an ellipsis. */
export function promptExcerpt(text: string, max = 10, min = 6): string {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length <= max) return words.join(' ').replace(/[.;,:]+$/, '');
  for (let n = max; n >= min; n--) if (/[,;:.]$/.test(words[n - 1]!)) return words.slice(0, n).join(' ').replace(/[.;,:]+$/, '');
  return words.slice(0, max).join(' ').replace(/[.;,:]+$/, '') + '…';
}

export type ChipSlot = { id: string; side: 'l' | 'r'; y: number };
/**
 * Chips sit in the left or right margin, on the side of their box's centre, in the order of the boxes'
 * heights, spaced at least `h` apart and kept inside [top, 1 − bottom − h] (fractions of the frame height).
 */
export function layoutChips(boxes: Box[], h = 0.16, top = 0.04, bottom = 0): ChipSlot[] {
  const out: ChipSlot[] = [];
  for (const side of ['l', 'r'] as const) {
    const mine = boxes.filter(b => ((b.x0 + b.x1) / 2 < 0.5) === (side === 'l')).map(b => ({ id: b.id, want: (b.y0 + b.y1) / 2 - h / 2 })).sort((a, b) => a.want - b.want);
    let y = top;
    const placed = mine.map(m => { y = Math.max(m.want, y); const at = y; y += h; return { id: m.id, side, y: at }; });
    // Push back up from the bottom when the column overflows.
    let floor = 1 - bottom - h;
    for (let i = placed.length - 1; i >= 0; i--) { placed[i]!.y = Math.max(top, Math.min(placed[i]!.y, floor)); floor = placed[i]!.y - h; }
    out.push(...placed);
  }
  return out;
}

/** Where a leader line lands on a box: its centre, nudged toward the chip's side so it stays inside the box. */
export function leaderFrom(b: Box, side: 'l' | 'r'): [number, number] {
  const w = b.x1 - b.x0;
  return [side === 'l' ? b.x0 + w * 0.4 : b.x1 - w * 0.4, (b.y0 + b.y1) / 2];
}

// ---------- Compare: blockout → still → each video version ----------
export type BandSource = { id: string; kind: 'video' | 'image'; label: string; role: 'blockout' | 'still' | 'video' };
type VersionLite = { id: string; createdAt: string; source?: { workflow?: string } };
/** The model name from a version's workflow title ("LTX 2.5 Fast · animate…" → "LTX 2.5 Fast"). */
export const modelOf = (v: VersionLite) => (v.source?.workflow || 'Generated').split(' ·')[0]!.trim() || 'Generated';
/**
 * Bands, left to right: the blockout, the start still when there is one, then generated versions — newest per
 * model first, then older takes, up to `maxVideos` — labelled by model, with a take number when a model repeats.
 */
export function compareBands(blockout: { id: string } | null, still: { id: string } | null, versions: VersionLite[], maxVideos = 4): BandSource[] {
  const newest = [...versions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const firsts = newest.filter((v, i) => newest.findIndex(x => modelOf(x) === modelOf(v)) === i);
  const pick = [...firsts, ...newest.filter(v => !firsts.includes(v))].slice(0, maxVideos);
  const count = (m: string) => pick.filter(v => modelOf(v) === m).length;
  // Take numbers count up from the oldest version of that model.
  const take = (v: VersionLite) => newest.filter(x => modelOf(x) === modelOf(v)).reverse().indexOf(v) + 1;
  return [
    ...(blockout ? [{ id: blockout.id, kind: 'video' as const, label: 'Blockout', role: 'blockout' as const }] : []),
    ...(still ? [{ id: still.id, kind: 'image' as const, label: 'Start still', role: 'still' as const }] : []),
    ...pick.map(v => ({ id: v.id, kind: 'video' as const, label: count(modelOf(v)) > 1 ? `${modelOf(v)} · take ${take(v)}` : modelOf(v), role: 'video' as const })),
  ];
}
/** Seam positions (%) for n equal bands: n − 1 seams. */
export const bandStops = (n: number) => Array.from({ length: Math.max(0, n - 1) }, (_, i) => ((i + 1) * 100) / n);
/**
 * The one-time sweep: every seam starts at the right edge (all blockout) and slides to its resting place,
 * one after another; u runs 0 → 1. Eased, staggered, and exactly at rest when u = 1.
 */
export function sweepStops(n: number, u: number): number[] {
  const rest = bandStops(n), k = rest.length;
  return rest.map((x, i) => {
    const a = k > 1 ? (i / k) * 0.5 : 0, w = 1 - (k > 1 ? ((k - 1) / k) * 0.5 : 0);
    const p = Math.max(0, Math.min(1, (u - a) / w)), e = 1 - (1 - p) ** 3;
    return 100 + (x - 100) * e;
  });
}
/** Drag one seam, kept between its neighbours with a 2 % gap. */
export function moveStop(stops: number[], i: number, x: number): number[] {
  const lo = (i > 0 ? stops[i - 1]! : 0) + 2, hi = (i < stops.length - 1 ? stops[i + 1]! : 100) - 2;
  return stops.map((v, k) => (k === i ? Math.max(lo, Math.min(hi, x)) : v));
}

// ---------- Home hero: one sweep, then the seam is the user's ----------
/** Seam position (% of blockout showing) for the hero's one-time sweep: all blockout → all generated → rest at 50. */
export function heroSweepAt(u: number): number {
  const e = (p: number) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2);
  const t = Math.max(0, Math.min(1, u));
  return t < 0.6 ? 100 - 100 * e(t / 0.6) : 50 * e((t - 0.6) / 0.4);
}

// ---------- Generate dialog ----------
/** The header's estimate: rate × shot length, free when it runs locally, else priced at the quote. */
export function dialogEstimate(def: { pricing?: { ratePerSecond?: number } } | null, seconds: number, backend: string): string {
  if (backend === 'local') return 'Free · local';
  const rate = def?.pricing?.ratePerSecond;
  return rate ? `≈ $${(rate * seconds).toFixed(2)}` : 'Priced at quote';
}

// ---------- Cast list: look families ----------
export type FamilyRow = { id: string; name: string; source: string };
export type Family = { key: string; ids: string[]; label: string };
/** The shared start of a family's names, trimmed at a word ("Turns 3–4 · surface 1", "… 12" → "Turns 3–4 · surface"). */
export function familyLabel(names: string[], fallback: string): string {
  if (names.length < 2) return names[0] || fallback;
  let p = names[0]!;
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  p = p.replace(/[\s·\-–—:,]*\d*$/, '').trim();
  return p.length >= 3 ? p : fallback;
}
/** Rows grouped by the look they share (`source`: the object whose image they use), in first-seen order. */
export function castFamilies(rows: FamilyRow[], sourceName: (id: string) => string): Family[] {
  const map = new Map<string, FamilyRow[]>();
  for (const r of rows) { const list = map.get(r.source); if (list) list.push(r); else map.set(r.source, [r]); }
  return [...map.entries()].map(([key, list]) => ({ key, ids: list.map(r => r.id), label: familyLabel(list.map(r => r.name), sourceName(key)) }));
}
