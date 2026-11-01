// Pure helpers for the Take lab (src/director-takes.ts): which takes start selected, the shared clock's frame
// arithmetic and the words on each take's label. No DOM, so they run under node --test.
import type { Take, TakeCost, Grade, DirectionGrade } from '../shared/takes.mjs';
import { WEAK_MATCH } from '../shared/still-match.mjs';

export const MAX_LANES = 4;
export const FPS = 24;

/** Takes selected when the lab opens: the winner first, then the newest others, up to `max`. */
export function defaultPicks(takes: Pick<Take, 'id' | 'winner' | 'createdAt'>[], max = MAX_LANES): string[] {
  const newest = [...takes].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const first = newest.find(t => t.winner);
  return [...(first ? [first] : []), ...newest.filter(t => t !== first)].slice(0, max).map(t => t.id);
}
/** Toggle one take in the selection, never past `max` lanes (the extra tick is refused, not rotated in). */
export function togglePick(picked: string[], id: string, max = MAX_LANES): string[] {
  if (picked.includes(id)) return picked.filter(x => x !== id);
  return picked.length >= max ? picked : [...picked, id];
}

/** The frame shown at time t (frame k covers [k/fps, (k+1)/fps)). */
export const frameAt = (t: number, fps = FPS) => Math.max(0, Math.floor(t * fps + 1e-6));
/** Where to seek to show frame k: a quarter frame in, so rounding never lands on the previous frame. */
export const timeOfFrame = (k: number, fps = FPS) => (Math.max(0, k) + 0.25) / fps;
/** The shared clock's time one frame earlier or later, kept inside [0, the longest lane]. */
export function stepFrame(t: number, delta: number, longest: number, fps = FPS) {
  const last = Math.max(0, Math.ceil(longest * fps - 1e-6) - 1);
  return timeOfFrame(Math.min(last, Math.max(0, frameAt(t, fps) + delta)), fps);
}
/**
 * Where one lane should be at shared time t. A shorter lane holds its last frame (the tail is frozen, never stretched),
 * and says so with `ended`.
 */
export function laneTime(t: number, duration: number | null | undefined, fps = FPS) {
  if (!duration || !Number.isFinite(duration)) return { t, ended: false };
  const last = Math.max(0, duration - 0.5 / fps);
  return t >= last ? { t: last, ended: t > last + 0.5 / fps } : { t, ended: false };
}
/** Lane grid columns: up to three across, four as a 2×2, five (four takes and the blockout) as three across. */
export const gridColumns = (n: number) => (n <= 3 ? Math.max(1, n) : n === 4 ? 2 : 3);
/** "Frame 60 · 2.500 s" */
export const timecode = (t: number, fps = FPS) => `Frame ${frameAt(t, fps)} · ${t.toFixed(3)} s`;

// ---------- Labels ----------
export function costText(c: TakeCost) {
  if (c.status === 'free') return 'Free (local)';
  if (c.usd == null) return 'Cost unknown';
  return c.status === 'billed' ? `$${c.usd.toFixed(3)} billed` : `≈ $${c.usd.toFixed(3)} estimate`;
}
/** Settings as short "key value" parts, seed first. `only` limits them to keys that differ (takeDifferences names). */
export function settingParts(t: Pick<Take, 'seed' | 'settings'>, only?: Set<string>) {
  const parts: { key: string; text: string }[] = [];
  if (t.seed != null) parts.push({ key: 'seed', text: `seed ${t.seed}` });
  for (const [k, v] of Object.entries(t.settings || {})) parts.push({ key: `settings.${k}`, text: `${k} ${v === null ? '—' : String(v)}` });
  return only ? parts.filter(p => only.has(p.key)) : parts;
}
/** One grade as a short value and a longer explanation (the explanation goes in the row's description, not a hover). */
export function gradeText(g: Grade): { value: string; tone: 'ok' | 'warn' | 'none'; detail: string } {
  if (g.status === 'graded') return { value: `${Math.round(g.score)}/10`, tone: g.score < WEAK_MATCH ? 'warn' : 'ok', detail: [g.camera != null ? `camera ${g.camera}` : '', g.headings != null ? `headings ${g.headings}` : '', g.why, g.method ? `graded by ${g.method}` : ''].filter(Boolean).join(' · ') };
  if (g.status === 'match') return { value: 'Same length', tone: 'ok', detail: g.note };
  if (g.status === 'differs') return { value: `${g.frames > 0 ? '+' : ''}${g.frames} frames`, tone: 'warn', detail: g.note };
  if (g.status === 'not-assessed') return { value: 'Not assessed', tone: 'none', detail: g.note };
  if (g.status === 'not-applicable') return { value: '—', tone: 'none', detail: g.note };
  return { value: g.status === 'unknown' ? 'Unknown' : 'Not graded', tone: 'none', detail: g.note };
}
/** The direction check on a video take: Pass / Warn / Fail with its reason and what it booked. */
export function directionText(d: DirectionGrade | undefined): { value: string; tone: 'ok' | 'warn' | 'bad' | 'none'; detail: string } {
  if (!d || d.status !== 'checked') return { value: 'Not checked', tone: 'none', detail: d?.note || '' };
  const value = d.verdict === 'pass' ? 'Pass' : d.verdict === 'warn' ? 'Warn' : 'Fail';
  return { value, tone: d.verdict === 'pass' ? 'ok' : d.verdict === 'warn' ? 'warn' : 'bad', detail: [d.why, d.measured ? 'blockout measured from the 3D scene' : 'blockout as the grader read it', `check ${costText(d.cost)}`].filter(Boolean).join(' · ') };
}
/** "3 m 52 s" */
export function duration(seconds: number | null) {
  if (seconds == null) return '';
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
}
