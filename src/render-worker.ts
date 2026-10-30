// Headless render worker (render.html, driven by server/previs/headless.mjs). Runs one op from the query string
// with the same client code the workspace uses, then sets window.__previsResult = { ok, ...payload } | { ok:false, error }.
//   op=blockout&project&shot&width&height       → { asset, previsShotId }
//   op=frame&project&shot&t&width&height&type[&guide=1] → { data, mime, width, height } (guide: still-guide look)
//   op=sheet&project&entity&sheet&options        → { referenceId }
import { objectLooks } from '../shared/director.mjs';
import type { DirectorProject, Reference } from '../shared/director.mjs';
import { shotPrompt } from '../shared/prompt.mjs';
import { setDef, slotLayout, slotPick } from '../shared/sheet-presets.mjs';
import type { Sheet } from '../shared/sheet-presets.mjs';
import { api } from './director-common';
import { createDirectorScene } from './director-scene';
import { captureShotVideo, shotSignature } from './director-capture';
import { composeSheet, canvasBlob } from './director-sheet-compose';
import type { ComposeOptions } from './director-sheet-compose';

declare global { interface Window { __previsResult?: Record<string, unknown> } }

const q = new URLSearchParams(location.search);
const int = (k: string, d: number) => { const n = Number(q.get(k) ?? d); if (!Number.isInteger(n) || n < 16 || n > 3840) throw Error(`Invalid ${k}`); return n; };

async function run(): Promise<Record<string, unknown>> {
  const op = q.get('op'), projectId = q.get('project') || '';
  let project = (await api<{ project: DirectorProject }>(`director/project?id=${encodeURIComponent(projectId)}`)).project;
  if (op === 'sheet') return sheet(project);
  const s = project.shots.find(x => x.id === q.get('shot'));
  if (!s) throw Error('Unknown shot');
  const host = document.getElementById('stage')!, el = () => host.appendChild(document.createElement('div'));
  const scene = createDirectorScene(host.querySelector('canvas')!, el(), el(), el(), { onRefImage: () => null, onClickSelect() {}, onMarquee() {}, onContextMenu() {}, onTransformCommit() {}, onModal() {} });
  scene.setView('camera'); scene.sync(project, s);
  if (op === 'frame') {
    const t = Number(q.get('t') ?? 0); if (!Number.isFinite(t)) throw Error('Invalid t');
    const width = int('width', 1280), height = int('height', 720), mime = q.get('type') === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const url = scene.capture(Math.min(s.duration, Math.max(0, t)), width, height, mime, 0.9, { guide: q.get('guide') === '1' });
    return { data: url.split(',')[1], mime, width, height };
  }
  if (op === 'blockout') {
    const entity = (id: string | null) => project.scene.entities.find(e => e.id === id) || null;
    const { asset, previsShotId } = await captureShotVideo({ api, scene, project: () => project, entity, signature: shotSignature, apply: p => { project = p; } }, s, { width: int('width', 1280), height: int('height', 720), prompt: shotPrompt(project, s, 'video') });
    return { asset, previsShotId };
  }
  throw Error('Unknown op');
}

async function sheet(project: DirectorProject) {
  const e = project.scene.entities.find(x => x.id === q.get('entity'));
  if (!e) throw Error('Unknown object');
  const sh = ((e.sheets || []) as Sheet[]).find(x => x.id === q.get('sheet'));
  if (!sh) throw Error('Unknown sheet');
  const refs = project.scene.references || [];
  const refUrl = (r: Reference) => `/director-refs/${project.id}/${r.file}`;
  const items = sh.slots.map(s => ({ s, r: refs.find(r => r.id === slotPick(s)?.referenceId) })).filter(x => x.r).map(x => ({ src: refUrl(x.r!), label: x.s.label, layout: slotLayout(x.s.spec as any) }));
  if (!items.length) throw Error('This sheet has no finished views');
  const options: ComposeOptions = { layout: setDef(sh.setId)?.layout || 'turnaround', name: true, labels: true, swatches: true, sameScale: true, ...JSON.parse(q.get('options') || '{}') };
  const look = objectLooks(project, e.id)[0];
  const canvas = await composeSheet({ name: e.name, items, reference: look ? refUrl(look) : null, options });
  let blob = await canvasBlob(canvas);
  if (blob.size > 9.5 * 1024 * 1024) blob = await canvasBlob(canvas, 'image/jpeg', 0.92);
  const data = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(Error('Could not read the sheet')); fr.readAsDataURL(blob); });
  const r = await api('director/reference', { projectId: project.id, scope: 'object', entityId: e.id, name: `${e.name} · design sheet`, data, note: `sheet:${sh.id}:composed` });
  return { referenceId: r.referenceId, width: canvas.width, height: canvas.height };
}

run().then(r => { window.__previsResult = { ok: true, ...r }; }, (e: Error) => { window.__previsResult = { ok: false, error: String(e?.message || e).slice(0, 500) }; });
