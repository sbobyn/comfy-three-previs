// Import a 3D model by drop or file picker, and the inspector's Imported model section (docs/import.md):
// where it came from and its rights, the clip it plays, its pose and how image and video models see it.
import { h } from './director-common';
import { POSE_NAMES, RIG_POSES } from '../shared/rig.mjs';
import { entityAt, upsertKey } from '../shared/director.mjs';
import type { Entity, Shot, Vec3 } from '../shared/director.mjs';
import type { Perform } from '../shared/imported-asset.mjs';

export const MODEL_ACCEPT = '.glb,.gltf,.fbx,.obj,.mtl,.stl,.ply,.usdz,.zip,.bin,.png,.jpg,.jpeg,.webp';
const MAIN = /\.(glb|gltf|fbx|obj|stl|ply|usdz)$/i;
/** A drop or pick holding a model (or a zip, which the server opens): routed to the importer, not the image uploads. */
export const isModelDrop = (files: File[]) => files.some(f => MAIN.test(f.name) || /\.zip$/i.test(f.name));

export type ImportResult = { project: any; entityId: string; name: string; handle: string; triangles: number; clips: { name: string; duration: number }[]; humanoid: boolean; units: string; notes: string[]; warnings: string[]; size: Vec3 };

/** Upload one model (a file, a zip, or a model with its .bin/.mtl/textures) to the importer. Files are read before any await. */
export async function importModels(files: File[], { projectId, position, licence }: { projectId: string; position?: Vec3 | null; licence?: string }): Promise<ImportResult> {
  const list = files.filter(f => !f.name.startsWith('.'));
  const total = list.reduce((n, f) => n + f.size, 0);
  if (!list.length) throw Error('Nothing to import');
  if (total > 200 * 1024 ** 2) throw Error('Imports are at most 200 MB');
  const q = new URLSearchParams({ projectId });
  if (position) { q.set('x', String(position[0])); q.set('y', String(position[1])); q.set('z', String(position[2])); }
  if (licence) q.set('licence', licence);
  let body: Blob, type: string;
  if (list.length === 1) { q.set('name', list[0].name); body = list[0]; type = /\.zip$/i.test(list[0].name) ? 'application/zip' : 'application/octet-stream'; }
  else {
    // Several files (model.gltf + model.bin + textures): [u32 header length][JSON [{ name, size }]][bytes …].
    const head = new TextEncoder().encode(JSON.stringify(list.map(f => ({ name: f.name, size: f.size }))));
    const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, head.length, true);
    body = new Blob([len, head, ...list]); type = 'application/x-previs-files';
  }
  const response = await fetch(`/api/director/import-asset?${q}`, { method: 'POST', headers: { 'Content-Type': type }, body });
  const data = await response.json().catch(() => ({ error: `Import failed (${response.status})` }));
  if (!response.ok) throw Error(data.error || `Import failed (${response.status})`);
  return data as ImportResult;
}

/** One-line result for a toast. */
export const importSummary = (r: ImportResult) => `Imported ${r.name}: ${r.size.map(v => Math.round(v * 100) / 100).join(' × ')} m${r.humanoid ? ', posable' : ''}${r.clips.length ? `, ${r.clips.length} clip${r.clips.length === 1 ? '' : 's'}` : ''}${r.warnings.length ? ` — ${r.warnings[0]}` : ''}`;

type Ctx = { patchUndo: (patch: Partial<Entity>, before: Partial<Entity>, label: string) => void; sceneTime: number; shot: Shot };

/** The inspector's Imported model section, or null for blockout objects. */
export function importedSection(e: Entity, { patchUndo, sceneTime, shot }: Ctx): HTMLElement | null {
  const src = e.source;
  if (!src) return null;
  const facts = [src.file, src.units, src.triangles !== undefined ? `${src.triangles.toLocaleString('en-US')} triangles` : null].filter(Boolean).join(' · ');
  const field = (key: 'licence' | 'attribution', label: string, placeholder: string) => {
    const input = h('input', { class: 'field', value: src[key] || '', maxlength: key === 'licence' ? 200 : 300, 'aria-label': label, placeholder });
    input.onchange = () => patchUndo({ source: { ...src, [key]: input.value } }, { source: src }, `Set ${label.toLowerCase()}`);
    return h('label', { class: 'imp-field' }, h('span', {}, label), input);
  };
  const rows: (HTMLElement | null)[] = [
    h('p', { class: 'note', style: 'margin:0' }, facts),
    field('licence', 'Licence', 'CC-BY 4.0, CC0, purchased, own work…'),
    field('attribution', 'Credit', 'Author and source to credit'),
  ];
  const perform: Perform = e.perform || { clip: null, offset: 0, speed: 1 };
  if (src.clips?.length) {
    const clip = h('select', { class: 'field', 'aria-label': 'Clip' }, h('option', { value: '' }, 'No clip (pose)'), ...src.clips.map(c => h('option', { value: c.name, selected: c.name === perform.clip }, `${c.name} · ${c.duration.toFixed(1)}s`)));
    const set = (next: Partial<Perform>, label: string) => patchUndo({ perform: { ...perform, ...next } as Perform }, { perform: e.perform ? structuredClone(e.perform) : null } as Partial<Entity>, label);
    clip.onchange = () => set({ clip: clip.value || null }, 'Set clip');
    const num = (label: string, key: 'offset' | 'speed', step: number) => {
      const input = h('input', { class: 'field', type: 'number', step, value: perform[key], 'aria-label': label, style: 'width:64px' });
      input.onchange = () => { const v = Number(input.value); if (Number.isFinite(v)) set({ [key]: v }, `Set clip ${key}`); };
      return h('label', { class: 'imp-num' }, label, input);
    };
    // Key the clip from this shot's start: earlier shots keep what they had.
    const keyHere = h('button', { class: 'btn sm', type: 'button', title: `Play the chosen clip from ${shot.title}'s start (scene ${shot.start || 0}s)` }, `◆ Key for ${shot.title}`);
    keyHere.onclick = () => {
      const t = shot.start || 0, keys = (perform.keys || []).filter(k => Math.abs(k.t - t) > 0.005);
      keys.push({ t, clip: clip.value || null, offset: perform.offset, speed: perform.speed });
      set({ keys: keys.sort((a, b) => a.t - b.t) }, 'Key clip');
    };
    const keyed = perform.keys?.length ? h('span', { class: 'muted', style: 'font-size:11.5px' }, `${perform.keys.length} clip key${perform.keys.length === 1 ? '' : 's'} · ${perform.keys.map(k => `${k.t}s ${k.clip ?? 'pose'}`).join(', ')}`) : null;
    const clearKeys = perform.keys?.length ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => set({ keys: undefined }, 'Clear clip keys') }, 'Clear keys') : null;
    rows.push(h('div', { class: 'imp-row' }, h('span', { class: 'xyz-l' }, 'Clip'), clip), h('div', { class: 'imp-row' }, num('Offset s', 'offset', 0.1), num('Speed ×', 'speed', 0.1), keyHere), keyed || clearKeys ? h('div', { class: 'imp-row' }, keyed, clearKeys) : null);
  }
  if (src.rig) {
    // A library pose: keyed at the playhead on animated objects, otherwise the object's pose.
    const pose = (name: string) => {
      const angles = structuredClone(RIG_POSES[name]);
      if (e.path?.length) { const a = entityAt(e, sceneTime); patchUndo({ path: upsertKey(e.path, sceneTime, a.position, undefined, undefined, { pose: angles }) }, { path: structuredClone(e.path) }, `Key ${name} pose`); }
      else patchUndo({ pose: angles }, { pose: e.pose ? structuredClone(e.pose) : null } as Partial<Entity>, `${name[0].toUpperCase()}${name.slice(1)} pose`);
    };
    rows.push(h('div', { class: 'imp-row imp-poses', role: 'group', 'aria-label': 'Pose' }, h('span', { class: 'xyz-l' }, 'Pose'), ...POSE_NAMES.map(n => h('button', { class: 'btn sm ghost', type: 'button', onclick: () => pose(n) }, n))));
    if (perform.clip) rows.push(h('p', { class: 'note', style: 'margin:0' }, 'A playing clip drives the body; a pose adds on top of it.'));
  }
  const standIn = h('select', { class: 'field', 'aria-label': 'Send to image and video models as' }, h('option', { value: 'posed', selected: e.standIn !== 'neutral' }, 'Posed, as shown'), h('option', { value: 'neutral', selected: e.standIn === 'neutral' }, 'Neutral grey stand-in'));
  standIn.onchange = () => patchUndo({ standIn: standIn.value === 'neutral' ? 'neutral' : null } as Partial<Entity>, { standIn: e.standIn ?? null } as Partial<Entity>, 'Change stand-in');
  rows.push(h('div', { class: 'imp-row', title: 'Reference-video models copy limb poses from the blockout. A neutral stand-in sends a plain grey figure in a standing pose instead.' }, h('span', { class: 'xyz-l' }, 'Models see'), standIn));
  return h('details', { class: 'object-imported', open: true }, h('summary', {}, 'Imported model'), h('div', { class: 'object-transform-body' }, ...rows));
}
