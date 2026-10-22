import './previs.css';
type Scene = { name: string; fps: number; start: number; end: number; cameras: string[] };
type Project = { revision: number; shots: { id: string; title: string; binding: { source: string; scene: string; camera: string; frame: number; fps: number; start: number; end: number }; renders: string[] }[] };
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scene = el<HTMLSelectElement>('scene'), camera = el<HTMLSelectElement>('camera');
let catalog: { file: string; scenes: Scene[] } | null = null;
let project: Project;
async function api(path: string, body?: unknown) { const r = await fetch('/api/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw Error(data.error); return data; }
async function action(fn: () => Promise<void>) { const buttons = Array.from(document.querySelectorAll('button')); buttons.forEach(b => b.disabled = true); try { await fn(); } catch (e) { el('status').textContent = (e as Error).message; } finally { buttons.forEach(b => b.disabled = false); el<HTMLButtonElement>('save').disabled = !catalog; } }
function options(select: HTMLSelectElement, values: string[]) { select.replaceChildren(...values.map(value => { const o = document.createElement('option'); o.value = o.textContent = value; return o; })); }
function chooseScene() { const s = catalog?.scenes.find(s => s.name === scene.value); options(camera, s?.cameras || []); if (s) { for (const k of ['start', 'frame']) el<HTMLInputElement>(k).value = String(s.start); el<HTMLInputElement>('end').value = String(s.end); el('timing').textContent = `${s.fps} fps · scene frames ${s.start}–${s.end}`; } }
scene.onchange = chooseScene;
function draw() {
  el('shots').replaceChildren(); el('empty').hidden = project.shots.length > 0;
  for (const shot of project.shots) {
    const card = document.createElement('article'), title = document.createElement('h3'), detail = document.createElement('p'), button = document.createElement('button');
    title.textContent = shot.title; detail.textContent = `${shot.binding.scene} / ${shot.binding.camera} · ${shot.binding.fps} fps · ${shot.binding.start}–${shot.binding.end} · preview ${shot.binding.frame}`;
    button.textContent = 'Render & save preview'; button.onclick = () => action(async () => { el('status').textContent = 'Rendering through Blender MCP…'; project = (await api('render', { revision: project.revision, shotId: shot.id })).project; draw(); el('status').textContent = 'Preview saved against shot.'; });
    card.append(title, detail);
    if (shot.binding.source === 'blender') card.append(button);
    else { const open = document.createElement('a'); open.href = '/index.html?shot=' + shot.id; open.textContent = 'Open saved camera & motion'; card.append(open); }
    if (shot.renders.length) { const handoff = document.createElement('a'); handoff.href = '/api/handoff?shot=' + shot.id; handoff.download = 'previs-handoff.json'; handoff.textContent = 'Download asset handoff'; handoff.style.display = 'block'; card.append(handoff); }
    for (const id of shot.renders) { const a = document.createElement('a'), img = document.createElement('img'); a.href = `/renders/${id}.png`; a.download = `${shot.title}.png`; img.src = a.href; img.alt = `${shot.title} — Blender beauty preview`; a.append(img); card.append(a); }
    el('shots').append(card);
  }
}
async function reload() { const result = await api('project'); project = result.project; draw(); el('status').textContent = `Project restored · revision ${project.revision}`; }
el('refresh').onclick = () => action(reload);
el('connect').onclick = () => action(async () => { el('status').textContent = 'Connecting to Blender MCP…'; const r = await api('blender/refresh', {}); catalog = r.catalog; options(scene, catalog!.scenes.map(s => s.name)); chooseScene(); el('connection').textContent = `${r.serverInfo.name} · ${catalog!.file || 'Unsaved file — save in Blender first'}`; el('status').textContent = 'Scene state refreshed.'; });
el('save').onclick = () => action(async () => { const binding = { scene: scene.value, camera: camera.value, ...Object.fromEntries(['frame','start','end'].map(k => [k, Number(el<HTMLInputElement>(k).value)])) }; project = (await api('shots', { revision: project.revision, title: el<HTMLInputElement>('title').value, binding })).project; draw(); el('status').textContent = 'Shot saved. Ready to render.'; });
void action(reload);
