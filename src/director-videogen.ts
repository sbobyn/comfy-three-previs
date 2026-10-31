// Prepare one shot's video generation: the blockout video plus the reference images of every object
// the shot's camera sees (and its environment, style and key frame), wired into the model, then quoted.
// Nothing is sent to a backend here; quoting is free.
import { compilePrompt, keyStillState, referenceLegend, videoReferences } from '../shared/director.mjs';
import type { DirectorProject, Shot, VideoRef } from '../shared/director.mjs';
import { withReferenceImages, maxReferences } from '../shared/video-refs.mjs';
import { shotPrompt } from '../shared/prompt.mjs';
import { cameraSourceOf, fitPrompt, motionInput, withCameraLine } from '../shared/camera-source.mjs';
import type { CameraSource } from '../shared/camera-source.mjs';
import { api } from './director-common';
import { clipSecondsFor, durationValue, FIRST_FRAME_FALLBACK } from '../shared/tiers.mjs';

export type Def = { id: string; title: string; task: string; description?: string; pricing?: { ratePerSecond?: number }; parameters?: Record<string, { nodeId: string; input: string }>; graph?: any; inputs?: any; provenance?: { presetId?: string; referenceImages?: number }; constraints?: any };
export type GenState = { presets: Def[]; definitions: Def[]; jobs: any[]; paidExecutionEnabled?: boolean };
export type EngineRef = { renderId: string; referenceId: string; entityId: string | null; role: string; label: string; name: string; file: string };

export const VIDEO_TASKS = ['transform-video', 'control-video', 'first-frame'];
/** Compatible task definitions, including imported graphs; derived reference variants are hidden. */
export function videoChoices(st: GenState): Def[] {
  return allVideoChoices(st);
}
function allVideoChoices(st: GenState): Def[] {
  return [...st.presets, ...st.definitions.filter(d => !d.provenance?.referenceImages && !st.presets.some(p => p.id === d.id || d.provenance?.presetId === p.id))].filter(d => VIDEO_TASKS.includes(d.task));
}
/** Seconds a shot generates (and is billed) with this model: start-still models snap to the clip lengths they accept. */
export const clipSeconds = (d: Def | null | undefined, s: Shot) => (d?.task === 'first-frame' ? clipSecondsFor(d, s.duration) : s.render?.duration ?? s.duration);
/** Clip lengths a start-still model accepts, e.g. "4/6/8 s" or "2–10 s"; '' for other models. */
export function clipLengths(d: Def | null | undefined) {
  const ds: number[] | undefined = d?.task === 'first-frame' ? d.constraints?.durations : undefined;
  return ds?.length ? `${ds.length <= 3 ? ds.join('/') : `${ds[0]}–${ds[ds.length - 1]}`} s` : '';
}
/** Picker label: title · price per second · clip lengths. */
export function modelLabel(d: Def) {
  const rate = d.pricing?.ratePerSecond;
  return [d.title, rate ? `≈ $${rate.toFixed(2)}/s` : null, clipLengths(d) || null].filter(Boolean).join(' · ');
}
/** The start-only sibling a start → end model uses when the shot has no end still (same as the batch). */
export const startOnlyFallback = (d: Def | null | undefined) => (d ? (FIRST_FRAME_FALLBACK as Record<string, string>)[d.provenance?.presetId || d.id] || null : null);
const baseOf = (st: GenState, id: string) => st.presets.find(p => p.id === id) || st.definitions.find(d => d.id === id) || null;
export const referenceCapacity = (st: GenState, id: string) => { const b = baseOf(st, id); return b ? maxReferences(b) : 0; };

/** Which references a shot would use with this model, before anything is registered. A model that follows the blockout clip gets the start/end stills first, as the look. */
export function plannedReferences(project: DirectorProject, s: Shot, st: GenState, id: string) { return videoReferences(project, s, referenceCapacity(st, id), { stills: cameraSourceOf(baseOf(st, id)) === 'blockout' }); }

/**
 * The prompt a shot uses: compiled with numbered references, or the user's text plus a reference legend.
 * Either way it carries the camera line for `cameraSource` and never describes the move.
 */
export function shotVideoPrompt(project: DirectorProject, s: Shot, refs: VideoRef[], userPrompt?: string | null, cameraSource: CameraSource = 'blockout') {
  const auto = compilePrompt(project, s, null, { cameraSource });
  if (userPrompt && userPrompt.trim() && userPrompt.trim() !== auto.trim()) return [withCameraLine(userPrompt, cameraSource), referenceLegend(refs)].filter(Boolean).join('\n');
  return compilePrompt(project, s, refs, { cameraSource });
}

async function definitionFor(st: GenState, id: string, refCount: number): Promise<Def> {
  const base = baseOf(st, id); if (!base) throw Error('Choose a video model');
  const presetId = base.provenance?.presetId || base.id;
  const wanted = withReferenceImages({ ...base, provenance: { ...(base.provenance || {}), presetId } }, refCount) as Def;
  const n = wanted.provenance?.referenceImages || 0;
  const same = (d: Def) => (d.provenance?.presetId === presetId || d.id === presetId) && (d.provenance?.referenceImages || 0) === n && JSON.stringify(d.graph) === JSON.stringify(wanted.graph);
  const saved = st.definitions.find(same);
  if (saved) return saved;
  const main = (await api('project')).project;
  const r = await api('generation/preset', { revision: main.revision, definition: wanted });
  st.definitions.push(r.definition);
  return r.definition;
}

/** Bind and quote one shot. Re-run this right before every submit: each submit needs a fresh binding. */
export async function prepareShotVideo(o: { project: DirectorProject; shot: Shot; st: GenState; definitionId: string; useReferences?: boolean; userPrompt?: string | null; backend?: 'cloud' | 'local'; acceptTimingChange?: boolean; startOnly?: boolean }) {
  const { project, shot: s, st } = o;
  const r = s.render; if (!r) throw Error('Make the blockout first');
  const base = baseOf(st, o.definitionId);
  if (base?.task === 'first-frame') return prepareFirstFrame(o, base);
  const cap = o.useReferences === false ? 0 : referenceCapacity(st, o.definitionId);
  // The blockout clip is the camera; the start (and end) still lead the reference images as the look, then the cast.
  const registered: EngineRef[] = cap ? (await api('director/video-refs', { projectId: project.id, shotId: s.id, previsShotId: r.previsShotId, max: cap, stills: cameraSourceOf(base) === 'blockout' })).references : [];
  const all = [...(project.scene.references || []), ...project.shots.flatMap(x => x.references)];
  const refs: VideoRef[] = registered.map(x => ({ ref: all.find(y => y.id === x.referenceId)!, entityId: x.entityId, role: x.role, label: x.label })).filter(x => x.ref);
  const def = await definitionFor(st, o.definitionId, registered.length);
  const role = motionInput(def) || 'sourceVideo';
  const parameters: Record<string, unknown> = {};
  for (const [k, m] of Object.entries(def.parameters || {})) parameters[k] = def.graph?.[m.nodeId]?.inputs?.[m.input];
  const assetBindings: Record<string, unknown> = { [role]: { assetId: r.assetId } };
  registered.forEach((x, i) => { assetBindings[`referenceImage${i + 1}`] = { renderId: x.renderId }; });
  const cameraSource = cameraSourceOf(def);
  let prompt = shotVideoPrompt(project, s, refs, o.userPrompt ?? shotPrompt(project, s, 'video', { cameraSource }), cameraSource);
  prompt = fitPrompt(prompt, def.constraints?.promptMaxLength, cameraSource); // keeps the camera line and the reference legend
  const main = (await api('project')).project;
  const bind = await api('generation/bind', { revision: main.revision, definitionId: def.id, shotId: r.previsShotId, assetBindings, prompt, parameters, acceptTimingChange: o.acceptTimingChange ?? true });
  const backend = o.backend || (def.id.startsWith('wan-') || def.provenance?.presetId?.startsWith('wan-') ? 'local' : 'cloud');
  const request = { requestId: crypto.randomUUID(), revision: bind.project.revision, workflowBindingId: bind.workflowBindingId, backend: { kind: backend } };
  const job = (await api('generation/quote', request)).job;
  const src = job.sources?.sourceVideo || job.sources?.controlVideo, seconds: number = src?.duration ?? r.duration;
  const est = def.pricing?.ratePerSecond && seconds ? def.pricing.ratePerSecond * seconds : null;
  return { def, job, request, est, refs: registered, prompt, cameraSource, seconds };
}

/** Image-to-video (LTX, Seedance, Kling, Veo, Hailuo, Wan): animate the shot's key frame, else its first blockout frame. */
async function prepareFirstFrame(o: Parameters<typeof prepareShotVideo>[0], base: Def) {
  const { project, shot: s, st } = o, r = s.render!;
  let wantsLast = !!base.inputs?.lastFrame;
  // No current End still: only an explicit choice (startOnly) animates the start still alone with the start-only sibling.
  const fallback = wantsLast && keyStillState(project, s).endState !== 'ready' ? st.presets.find(p => p.id === startOnlyFallback(base)) : null;
  if (fallback && o.startOnly) { base = fallback; wantsLast = false; }
  // The server refuses a still made for an earlier blocking (409); its message says which one to make again.
  const frame: EngineRef[] = (await api('director/video-refs', { projectId: project.id, shotId: s.id, previsShotId: r.previsShotId, max: 2, firstFrame: true, lastFrame: wantsLast })).references;
  let renderId = frame.find(x => x.label === 'start key frame')?.renderId;
  const lastId = frame.find(x => x.label === 'end key frame')?.renderId;
  if (wantsLast && (!renderId || !lastId)) throw Error(fallback && renderId ? `This shot has no End still. Add one in the Storyboard, or choose to animate the start still alone with ${fallback.title.split(' ·')[0]} (the camera then comes from one still, approximate).` : 'Generate this shot’s start and end key frames first');
  const main = (await api('project')).project;
  if (!renderId) renderId = main.renders?.find((x: any) => x.shotId === r.previsShotId && x.pass === 'beauty')?.id;
  if (!renderId) throw Error('No start image: generate a key frame for this shot, or make the blockout again');
  const def = await definitionFor(st, base.id, 0);
  const parameters: Record<string, unknown> = {};
  for (const [k, m] of Object.entries(def.parameters || {})) parameters[k] = def.graph?.[m.nodeId]?.inputs?.[m.input];
  // Nearest clip length this model accepts, in the parameter's own type.
  const secs = clipSecondsFor(def, s.duration);
  if ('duration' in parameters) parameters.duration = durationValue(parameters.duration, secs);
  // Start → end stills stand in for the camera (they only approximate the move); one still leaves it to the model.
  const cameraSource: CameraSource = wantsLast ? 'keyframes' : 'still';
  const chosen = (o.userPrompt ?? shotPrompt(project, s, 'video', { cameraSource })).trim();
  let prompt = withCameraLine(chosen || compilePrompt(project, s, null, { cameraSource }), cameraSource);
  prompt = fitPrompt(prompt, def.constraints?.promptMaxLength, cameraSource); // keeps the camera line and the reference legend
  const bind = await api('generation/bind', { revision: (await api('project')).project.revision, definitionId: def.id, shotId: r.previsShotId, assetBindings: { firstFrame: { renderId }, ...(wantsLast ? { lastFrame: { renderId: lastId } } : {}) }, prompt, parameters, acceptTimingChange: o.acceptTimingChange ?? true });
  const request = { requestId: crypto.randomUUID(), revision: bind.project.revision, workflowBindingId: bind.workflowBindingId, backend: { kind: o.backend || 'cloud' } };
  const job = (await api('generation/quote', request)).job;
  const est = def.pricing?.ratePerSecond ? def.pricing.ratePerSecond * secs : null;
  return { def, job, request, est, refs: frame, prompt, cameraSource, seconds: secs };
}
