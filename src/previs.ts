import './previs.css';
type Scene = { name: string; fps: number; start: number; end: number; cameras: string[] };
type Project = { renders: { id: string; binding: { camera: string; frame: number }; pass: string; source: string; requestRevision?: number }[]; revision: number; shots: { id: string; title: string; limitation?: string; binding: { source: string; scene: string; camera: string; frame: number; fps: number; start: number; end: number }; renders: string[] }[] };
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scene = el<HTMLSelectElement>('scene'), camera = el<HTMLSelectElement>('camera');
let catalog: { file: string; token: string; scenes: Scene[] } | null = null;
let project: Project;
let editingShotId: string | undefined;
let operationId: string | undefined;
let busy = false;
async function api(path: string, body?: unknown) { const r = await fetch('/api/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw Error(data.error); return data; }
async function readiness() {
  const { blender } = await api('readiness');
  const current = blender.operation;
  operationId = current?.id;
  const uncertain = current?.status === 'uncertain';
  el('recovery').hidden = !uncertain;
  el('operation-detail').textContent = current ? `${current.kind} · ${current.status} · ${current.id}` : '';
  el('blender-readiness').textContent = !blender.configured
    ? 'Missing MCP command. Follow setup to install the matching addon and configure the upstream MCP process. Browser work remains available.'
    : current?.status === 'running' ? 'Blender operation running. Keep external edits idle; disconnecting will not cancel it.'
    : uncertain ? current.reason
    : blender.error || (blender.process ? `MCP process ready · addon ${blender.addon}. Refresh after external edits.` : 'MCP configured. Connect to inspect the addon and current file.');
}
async function action(fn: () => Promise<void>) {
  if (busy) return;
  busy = true; document.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = true);
  try { await fn(); } catch (e) { el('status').textContent = (e as Error).message; }
  finally { busy = false; document.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = false); el<HTMLButtonElement>('save').disabled = !catalog; await readiness().catch(() => {}); }
}
function options(select: HTMLSelectElement, values: string[]) { select.replaceChildren(...values.map(value => { const o = document.createElement('option'); o.value = o.textContent = value; return o; })); }
function chooseScene() { const s = catalog?.scenes.find(s => s.name === scene.value); options(camera, s?.cameras || []); if (s) { for (const k of ['start', 'frame']) el<HTMLInputElement>(k).value = String(s.start); el<HTMLInputElement>('end').value = String(s.end); el('timing').textContent = `${s.fps} fps · scene frames ${s.start}–${s.end}`; } }
scene.onchange = chooseScene;
function draw() {
  el('shots').replaceChildren(); el('empty').hidden = project.shots.length > 0;
  for (const shot of project.shots) {
    const card = document.createElement('article'), title = document.createElement('h3'), detail = document.createElement('p'), button = document.createElement('button');
    card.id = 'shot-' + shot.id; title.textContent = shot.title; detail.textContent = `${shot.binding.scene} / ${shot.binding.camera} · ${shot.binding.fps} fps · ${shot.binding.start}–${shot.binding.end} · preview ${shot.binding.frame}`;
    button.textContent = 'Render & save preview'; button.onclick = () => action(async () => { el('status').textContent = 'Rendering through Blender MCP…'; project = (await api('render', { revision: project.revision, shotId: shot.id })).project; draw(); el('status').textContent = 'Preview saved against shot.'; });
    card.append(title, detail); if (shot.limitation) { const limit = document.createElement('p'); limit.textContent = shot.limitation; card.append(limit); }
    if (shot.binding.source === 'blender') {
      const edit = document.createElement('button'); edit.textContent = 'Rebind camera / range';
      edit.onclick = () => action(async () => {
        await connect(); editingShotId = shot.id; el<HTMLInputElement>('title').value = shot.title;
        if (catalog?.scenes.some(s => s.name === shot.binding.scene)) scene.value = shot.binding.scene; chooseScene();
        if (Array.from(camera.options).some(o => o.value === shot.binding.camera)) camera.value = shot.binding.camera;
        for (const key of ['start','end','frame'] as const) el<HTMLInputElement>(key).value = String(shot.binding[key]);
        el('save').textContent = 'Save new binding'; el('cancel-binding').hidden = false; el('status').textContent = 'Choose the replacement binding. Existing previews keep their original provenance.';
      }); const video = document.createElement('a'); video.href = '/generation.html?shot=' + shot.id; video.textContent = 'Render video & choose workflow'; card.append(button, edit, video);
    }
    else { const open = document.createElement('a'); open.href = '/index.html?shot=' + shot.id; open.textContent = 'Open saved camera & motion'; card.append(open); }
    if (shot.renders.length) { const handoff = document.createElement('a'); handoff.href = '/api/handoff?shot=' + shot.id; handoff.download = 'previs-handoff.json'; handoff.textContent = 'Download asset handoff'; handoff.style.display = 'block'; card.append(handoff); }
    for (const id of shot.renders) { const a = document.createElement('a'), img = document.createElement('img'); a.href = `/renders/${id}.png`; a.download = `${shot.title}.png`; img.src = a.href; img.alt = `${shot.title} — ${shot.binding.source === 'blender' ? 'Blender' : 'browser'} beauty preview`; a.append(img); const provenance = document.createElement('p'); const render = project.renders.find(r => r.id === id); provenance.textContent = render?.binding ? `${render.pass === 'passthrough' ? 'Local Comfy passthrough · no AI generation ·' : 'Captured'} ${render.binding.camera} · frame ${render.binding.frame}${render.requestRevision ? ' · request revision ' + render.requestRevision : ''}` : 'Legacy preview — provenance unavailable'; const comfy = document.createElement('a'); comfy.href = '/comfy.html?render=' + id; comfy.textContent = 'Use this render in local Comfy'; card.append(a, provenance, comfy); }
    el('shots').append(card);
  }
}
async function connect() { const r = await api('blender/refresh', {}); catalog = r.catalog; options(scene, catalog!.scenes.map(s => s.name)); chooseScene(); el('connection').textContent = `${r.serverInfo.name} · ${catalog!.file || 'Unsaved file — save in Blender first'}`; el('status').textContent = 'Scene state refreshed.'; }
async function reload() { const result = await api('project'); project = result.project; draw(); el('status').textContent = `Project restored · revision ${project.revision}`; }
el('refresh').onclick = () => action(reload);
el('connect').onclick = () => action(connect);
el('save').onclick = () => action(async () => { const binding = { scene: scene.value, camera: camera.value, ...Object.fromEntries(['frame','start','end'].map(k => [k, Number(el<HTMLInputElement>(k).value)])) }; project = (await api('shots', { revision: project.revision, shotId: editingShotId, title: el<HTMLInputElement>('title').value, catalogToken: catalog?.token, binding })).project; draw(); editingShotId = undefined; el('save').textContent = 'Save shot'; el('cancel-binding').hidden = true; el('status').textContent = 'Shot saved. Ready to render.'; });
el('cancel-binding').onclick = () => { editingShotId = undefined; el('save').textContent = 'Save shot'; el('cancel-binding').hidden = true; };
el('reconcile').onclick = () => action(async () => {
  await api('blender/reconcile', { operationId, blenderIdle: el<HTMLInputElement>('blender-idle').checked, settingsReviewed: el<HTMLInputElement>('settings-reviewed').checked });
  el<HTMLInputElement>('blender-idle').checked = false; el<HTMLInputElement>('settings-reviewed').checked = false;
  await connect(); el('status').textContent = 'Reconciled and refreshed. No operation was retried.';
});
setInterval(() => { void readiness().catch(() => {}); }, 3000);
void action(reload);
