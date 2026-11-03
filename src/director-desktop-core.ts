// Pure helpers for the desktop workspace and home page (no DOM, no WebGL) so they run under node --test:
// the top bar's step action, per-shot status, storyboard takes, the Cut-coherent shot scrubber,
// changes that arrive from Claude, the first-run tour and the home page's starter seam.
import type { DirectorProject, Shot, Entity, Reference } from '../shared/director.mjs';

export type Step = 'build' | 'shoot' | 'cut';
export const STEP_LABEL: Record<Step, string> = { build: 'Build', shoot: 'Shoot', cut: 'Cut' };

// ---------- Top bar: one primary action per step ----------
export type StepFacts = {
  /** Cast members in the current shot without an image. */
  castNeed: number;
  /** The selected shot's video model animates key frames (respects the preset's keyFrames flag); `end` when it also takes an end frame. */
  keyFrames: false | 'start' | 'start+end';
  hasStart: boolean; hasEnd: boolean;
  /** The Cut view's export state. */
  exportOk: boolean; exportReason: string; exportBusy: boolean;
};
export type StepAction = { kind: 'looks' | 'still' | 'video' | 'export'; label: string; title: string; disabled: boolean; at?: 'start' | 'end' };
/** Build: Cast images · Shoot: Generate still (a key-frame model still missing its stills) or Generate video · Cut: Export film. */
export function stepAction(step: Step, f: StepFacts): StepAction {
  if (step === 'build') return { kind: 'looks', label: 'Cast images', disabled: false, title: f.castNeed ? `${f.castNeed} cast member${f.castNeed === 1 ? '' : 's'} in this shot need${f.castNeed === 1 ? 's' : ''} an image` : 'Every cast member’s image and the project style in one board' };
  if (step === 'cut') return { kind: 'export', label: f.exportBusy ? 'Exporting…' : 'Export film', disabled: !f.exportOk || f.exportBusy, title: f.exportOk ? 'Export the cut as one film (1280×720, 24 fps)' : f.exportReason || 'Nothing in the cut yet' };
  if (f.keyFrames && !f.hasStart) return { kind: 'still', at: 'start', label: 'Generate still', disabled: false, title: 'This video model animates from a start still: make one first (a few cents)' };
  if (f.keyFrames === 'start+end' && !f.hasEnd) return { kind: 'still', at: 'end', label: 'Generate still', disabled: false, title: 'This video model animates start → end: make the end still next' };
  return { kind: 'video', label: 'Generate video', disabled: false, title: 'Make the blockout if needed, then quote and generate this shot’s video' };
}

/** The top bar's status strip: `parts` joined by " · ", and `short` for narrow windows. */
export function stepStatus(step: Step, p: DirectorProject, s: Shot, o: { stale: boolean; videos: number; castNeed: number; castTotal: number; bundled?: boolean }): { parts: string[]; short: string } {
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
  if (step === 'build') {
    const objs = p.scene.entities.filter(e => e.shape !== 'group').length;
    const cast = o.castTotal ? (o.castNeed ? `${o.castNeed} of ${o.castTotal} cast need images` : 'cast images ready') : 'no cast in this shot';
    return { parts: [n(objs, 'object'), cast], short: o.castNeed ? `${o.castNeed} need images` : cast };
  }
  if (step === 'shoot') {
    const stills = s.references.filter(r => r.role === 'frame').length, blockout = s.render ? (o.stale ? 'blockout changed' : 'blockout ready') : o.bundled ? 'starter blockout' : 'no blockout';
    return { parts: [`Shot ${String(p.shots.indexOf(s) + 1).padStart(2, '0')}`, s.title, blockout, n(stills, 'still'), o.videos ? n(o.videos, 'video') : 'no video'], short: blockout };
  }
  const vids = new Set((p.assets || []).filter(a => a.kind === 'workflow-result').map(a => a.shotId)).size;
  return { parts: [n(p.shots.length, 'shot'), `${vids} of ${p.shots.length} with video`], short: `${vids}/${p.shots.length} video` };
}

// ---------- Rail: per-shot status pips and the filmstrip still ----------
export type PipTone = 'ok' | 'changed' | 'none' | 'run';
export type ShotPips = { blockout: PipTone; still: PipTone; video: PipTone; label: string };
/**
 * Blockout (current / changed / none), still (any / generating / none), video (any / generating / none).
 * `bundled`: the shot has no blockout of its own but a starter shipped one, so the label says so, not "No blockout yet".
 */
export function shotPips(s: Shot, o: { stale: boolean; videos: number; stillRunning: boolean; videoRunning: boolean; bundled?: boolean }): ShotPips {
  const stills = s.references.filter(r => r.role === 'frame').length;
  const blockout: PipTone = s.render ? (o.stale ? 'changed' : 'ok') : 'none';
  const still: PipTone = o.stillRunning ? 'run' : stills ? 'ok' : 'none';
  const video: PipTone = o.videoRunning ? 'run' : o.videos ? 'ok' : 'none';
  const label = [
    blockout === 'ok' ? 'Blockout ready' : blockout === 'changed' ? 'Scene changed since the blockout' : o.bundled ? 'Starter blockout' : 'No blockout yet',
    `${stills ? `${stills} still${stills === 1 ? '' : 's'}` : 'no stills'}${still === 'run' ? ' (one generating)' : ''}`,
    `${o.videos ? `${o.videos} video${o.videos === 1 ? '' : 's'}` : 'no video'}${video === 'run' ? ' (one generating)' : ''}`,
  ].join(' · ');
  return { blockout, still, video, label };
}

/** When in the shot a still belongs (seconds), from its note: start, end or @t; null when unpinned. */
export function stillTime(s: Pick<Shot, 'duration'>, r: Pick<Reference, 'note'>): number | null {
  const n = r.note || '';
  if (n === 'key frame start') return 0;
  if (n === 'key frame end') return s.duration;
  const m = /^key frame @([\d.]+)s$/.exec(n); return m ? Math.min(s.duration, Number(m[1])) : null;
}
/** Stills grouped by moment, earliest first. The last take at a moment is the one in use. */
export function moments(s: Shot) {
  const map = new Map<string, { t: number | null; takes: Reference[] }>();
  for (const r of s.references.filter(x => x.role === 'frame')) { const t = stillTime(s, r), k = t === null ? 'x' : t.toFixed(2); (map.get(k) || map.set(k, { t, takes: [] }).get(k)!).takes.push(r); }
  return [...map.values()].sort((a, b) => (a.t ?? 1e9) - (b.t ?? 1e9));
}
/** The still in use closest to the middle of the shot (the rail's filmstrip frame), or null. */
export function midStill(s: Shot): Reference | null {
  const list = moments(s).filter(m => m.t !== null);
  if (!list.length) return null;
  const mid = s.duration / 2;
  return list.reduce((a, b) => (Math.abs(b.t! - mid) < Math.abs(a.t! - mid) ? b : a)).takes.at(-1)!;
}

// ---------- Storyboard: choose a take, use a still as a key frame ----------
/** Make an earlier take the one in use at its moment (undo restores the previous one). */
export function useTakeEntry(s: Shot, referenceId: string) {
  const r = s.references.find(x => x.id === referenceId && x.role === 'frame'); if (!r) return null;
  const t = stillTime(s, r), m = moments(s).find(x => x.takes.includes(r))!;
  const current = m.takes.at(-1)!;
  if (current.id === r.id) return null;
  return { label: `Use take at ${t === null ? 'unpinned' : t === 0 ? 'start' : Math.abs(t - s.duration) < 0.01 ? 'end' : `${t}s`}`, redo: [{ op: 'use_take', shotId: s.id, referenceId: r.id }], undo: [{ op: 'use_take', shotId: s.id, referenceId: current.id }] };
}
/** Key frame slots a still can fill for this model: none, start, or start and end. */
export function keyFrameSlots(def: { id?: string; task?: string; inputs?: { lastFrame?: unknown } } | null, prices: Record<string, { keyFrames?: boolean }> = {}): ('start' | 'end')[] {
  if (!def) return [];
  const keyed = def.task === 'first-frame' || !!(def.id && prices[def.id]?.keyFrames);
  return keyed ? ['start', ...(def.inputs?.lastFrame ? ['end' as const] : [])] : [];
}
/** Note and name for a copy of a still that becomes the shot's start or end key frame. */
export function keyFrameCopy(s: Shot, r: Reference, which: 'start' | 'end') {
  const t = stillTime(s, r);
  return { role: 'frame' as const, note: `key frame ${which}`, name: `${r.name.slice(0, 60)} · ${which} (from ${t === null ? 'unpinned' : `${t}s`})` };
}

// ---------- Shoot: the shot scrubber placed in the film, in Cut order ----------
export type FilmSegment = { shotId: string; start: number; duration: number; inCut: boolean };
/** Every shot as a segment of the film, in the Cut's order (shots left out of the cut follow, dimmed). */
export function filmSegments(p: DirectorProject): { segments: FilmSegment[]; total: number } {
  const clips = p.edit?.clips || [];
  const order = clips.length ? [...clips.map(c => c.shotId).filter(id => p.shots.some(s => s.id === id)), ...p.shots.map(s => s.id).filter(id => !clips.some(c => c.shotId === id))] : p.shots.map(s => s.id);
  let at = 0;
  const segments = order.map(id => { const s = p.shots.find(x => x.id === id)!; const seg = { shotId: id, start: at, duration: s.duration, inCut: !clips.length || clips.some(c => c.shotId === id) }; at += s.duration; return seg; });
  return { segments, total: at };
}

// ---------- Changes that arrive from Claude (MCP), with an undo ----------
const ENTITY_KEYS = ['name', 'kind', 'shape', 'position', 'rotation', 'pitch', 'roll', 'scale', 'color', 'notes', 'styleNotes', 'lookFrom', 'parent', 'path'] as const;
const MOVE_KEYS = new Set(['position', 'rotation', 'pitch', 'roll', 'scale', 'path']);
const SHOT_KEYS = ['title', 'description', 'duration', 'start', 'camera', 'cast'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export type External = { text: string; ids: string[]; undo: unknown[] | null; count: number };
/**
 * What changed between two project revisions that the user did not make: objects and shots added,
 * removed or edited, shot order, scene style and title. Stills, blockouts and videos (results of the
 * user's own jobs) are not counted. `undo` restores the earlier state, or is null when it can't.
 */
export function externalChanges(before: DirectorProject, after: DirectorProject): External | null {
  const bE = new Map(before.scene.entities.map(e => [e.id, e])), aE = new Map(after.scene.entities.map(e => [e.id, e]));
  const bS = new Map(before.shots.map(s => [s.id, s])), aS = new Map(after.shots.map(s => [s.id, s]));
  const text: string[] = [], ids: string[] = [], undo: unknown[] = [];
  let ok = true;
  const name = (s: Shot) => `“${s.title}”`;
  // Shots added / removed.
  for (const s of after.shots) if (!bS.has(s.id)) { text.push(`added ${s.title}`); undo.push({ op: 'remove_shot', id: s.id }); }
  for (const [i, s] of before.shots.entries()) if (!aS.has(s.id)) {
    text.push(`removed ${name(s)}`);
    if (s.references.length || s.render) ok = false;
    else undo.push({ op: 'add_shot', index: i, shot: { id: s.id, title: s.title, description: s.description, duration: s.duration, start: s.start || 0, camera: structuredClone(s.camera), cast: structuredClone(s.cast) } });
  }
  // Objects added / removed / edited.
  const added = after.scene.entities.filter(e => !bE.has(e.id));
  for (const e of added) { text.push(`added ${e.name}`); ids.push(e.id); }
  undo.push(...[...added].reverse().map(e => ({ op: 'remove_entity', id: e.id })));
  for (const e of before.scene.entities) if (!aE.has(e.id)) {
    text.push(`removed ${e.name}`);
    undo.push({ op: 'add_entity', entity: structuredClone(e) });
    for (const s of before.shots) if (s.camera.target === e.id) undo.push({ op: 'update_shot', id: s.id, patch: { camera: { target: e.id } } });
  }
  const moved: Entity[] = [], edited: Entity[] = [];
  for (const e of after.scene.entities) {
    const old = bE.get(e.id); if (!old) continue;
    const keys = ENTITY_KEYS.filter(k => !same(old[k], e[k])); if (!keys.length) continue;
    (keys.every(k => MOVE_KEYS.has(k)) ? moved : edited).push(e); ids.push(e.id);
    undo.push({ op: 'update_entity', id: e.id, patch: Object.fromEntries(keys.map(k => [k, structuredClone(old[k] ?? (k === 'path' || k === 'parent' || k === 'lookFrom' ? null : k === 'pitch' || k === 'roll' ? 0 : ''))])) });
  }
  if (moved.length) text.push(moved.length === 1 ? `moved ${moved[0].name}` : `moved ${moved.length} objects`);
  if (edited.length) text.push(edited.length === 1 ? `updated ${edited[0].name}` : `updated ${edited.length} objects`);
  // Shots edited (stills, blockouts and videos are the user's own jobs, so they are not counted).
  for (const s of after.shots) {
    const old = bS.get(s.id); if (!old) continue;
    const keys = SHOT_KEYS.filter(k => !same(old[k], s[k]));
    const prompts = !same(old.prompts, s.prompts) || !same(old.style, s.style) || !same(old.promptSections, s.promptSections) || !same(old.settings, s.settings) || !same(old.look, s.look);
    if (!keys.length && !prompts) continue;
    text.push(`updated ${name(s)}`);
    if (prompts) ok = false;
    if (keys.length) undo.push({ op: 'update_shot', id: s.id, patch: Object.fromEntries(keys.map(k => [k, structuredClone(k === 'start' ? old.start || 0 : k === 'cast' ? old.cast || { include: [], exclude: [] } : old[k])])) });
  }
  // Shot order (only when the same shots remain).
  const kept = before.shots.filter(s => aS.has(s.id)).map(s => s.id), now = after.shots.filter(s => bS.has(s.id)).map(s => s.id);
  if (!same(kept, now)) { text.push('reordered shots'); if (kept.length === before.shots.length) undo.push({ op: 'reorder_shots', ids: before.shots.map(s => s.id) }); else ok = false; }
  if (!same(before.scene.environment, after.scene.environment)) { text.push('changed the scene style'); undo.push({ op: 'set_scene', patch: { environment: structuredClone(before.scene.environment) } }); }
  if (before.title !== after.title) { text.push(`renamed the project “${after.title}”`); undo.push({ op: 'set_project', patch: { title: before.title } }); }
  if (!text.length) return null;
  const head = text.length <= 2 ? text.join(' · ') : `${text[0]} and ${text.length - 1} more changes`;
  return { text: `Claude ${head}`, ids, undo: ok && undo.length ? undo : null, count: text.length };
}

// ---------- First-run tour ----------
export const TOUR = [
  { id: 'block', title: 'Block', body: 'Drag objects in the viewport to place them. Right-click or Shift+A adds one.' },
  { id: 'cast', title: 'Cast', body: 'Give each cast member an image: Cast images puts the whole cast on one board.' },
  { id: 'shoot', title: 'Shoot', body: 'Shoot looks through the shot camera. Frame it, or fly it with keys, a gamepad or your phone.' },
  { id: 'generate', title: 'Generate', body: 'Generate makes a still or the shot’s video. You see the cost first; nothing is charged without your approval.' },
] as const;
export const TOUR_KEY = 'previs.tour.v1';
/** Show the tour once per browser, on a New scene project that is new (few edits) and not empty. Starters are finished films: no tour. */
export function shouldTour(p: Pick<DirectorProject, 'revision' | 'scene' | 'createdAt' | 'template'>, seen: string | null, now = Date.now()) {
  if (seen === '1' || p.template !== 'empty') return false;
  const fresh = p.revision <= 3 || now - Date.parse(p.createdAt) < 30 * 60_000;
  return fresh && p.scene.entities.length > 0;
}

// ---------- Home: the starter card's blockout → video seam ----------
export type GuideEntryLite = { id: string; file: string; kind: 'video' | 'image'; label?: string };
export type StarterMedia = { kind: 'video' | 'image' | 'still'; before?: string; after?: string; posters?: [string, string]; label?: string; cast: { file: string; label: string }[] };
/** The starter's hero shot media from public/guide/manifest.json: blockout ↔ generated video, else a still pair, else nothing (draw the blockout still). */
export function starterMedia(slug: string, entries: GuideEntryLite[]): StarterMedia {
  const own = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(s\\d+-(blockout|generated|still)(-poster|-blockout)?|cast-\\d+|sheet)$`);
  const mine = entries.filter(e => own.test(e.id));
  const cast = mine.filter(e => /-cast-\d+$/.test(e.id)).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).map(e => ({ file: e.file, label: e.label || '' }));
  const pick = (re: RegExp) => mine.find(e => re.test(e.id));
  const bv = pick(/-s\d+-blockout$/), gv = pick(/-s\d+-generated$/);
  if (bv && gv && bv.kind === 'video' && gv.kind === 'video') {
    const bp = pick(/-s\d+-blockout-poster$/), gp = pick(/-s\d+-generated-poster$/);
    return { kind: 'video', before: bv.file, after: gv.file, posters: bp && gp ? [bp.file, gp.file] : undefined, label: gv.label, cast };
  }
  const bs = pick(/-s\d+-still-blockout$/), gs = pick(/-s\d+-still$/);
  if (bs && gs) return { kind: 'image', before: bs.file, after: gs.file, label: gs.label, cast };
  return { kind: 'still', cast };
}
/** Keyboard on a seam (0–100): arrows step 5 (Shift 20), Home/End jump; null when the key is not the seam's. */
export function seamKey(x: number, key: string, shift = false): number | null {
  const step = shift ? 20 : 5;
  const v = key === 'ArrowLeft' || key === 'ArrowDown' ? x - step : key === 'ArrowRight' || key === 'ArrowUp' ? x + step : key === 'Home' ? 0 : key === 'End' ? 100 : null;
  return v === null ? null : Math.max(0, Math.min(100, v));
}
