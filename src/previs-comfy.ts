import './previs.css';
type Binding = { id: string; title: string; renderId: string; graph: unknown; imageNodeId: string; outputNodeIds: string[] };
type Render = { id: string; shotId: string; source: string; pass: string; binding: { camera: string; frame: number } };
type Project = { revision: number; shots: { id: string; title: string }[]; renders: Render[]; workflowBindings: Binding[] };
type Job = { id: string; promptId: string; status: string; message: string; renderId: string; shotId: string; requestRevision: number; results: { id: string; nodeId: string }[] };
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let project: Project, graph: Graph | null = null, jobs: Job[] = [], busy = false, compatible = false;
const source = el<HTMLSelectElement>('render'), bindings = el<HTMLSelectElement>('bindings'), imageInput = el<HTMLSelectElement>('image-input');
async function api(path: string, body?: unknown) { const response = await fetch('/api/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await response.json(); if (!response.ok) throw Error(data.error); return data; }
function option(value: string, label: string) { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; }
function sourceDetail() {
  const render = project.renders.find(r => r.id === source.value);
  el<HTMLImageElement>('source-image').hidden = !render;
  if (render) { el<HTMLImageElement>('source-image').src = `/renders/${render.id}.png`; el('source-detail').textContent = `${render.source} · ${render.pass} · ${render.binding.camera} · captured frame ${render.binding.frame}`; }
}
function bindingDetail() {
  const binding = project.workflowBindings.find(b => b.id === bindings.value);
  el('binding-detail').textContent = binding ? `Saved render ${binding.renderId} → LoadImage ${binding.imageNodeId}.image → SaveImage ${binding.outputNodeIds.join(', ')}. Authored graph preserved.` : 'Save or choose an explicit binding first.';
  el<HTMLButtonElement>('submit').disabled = busy || !compatible || !binding || jobs.some(j => !['completed','failed','closed'].includes(j.status));
}
async function action(fn: () => Promise<void>) {
  if (busy) return; busy = true; document.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = true);
  try { await fn(); } catch (e) { el('status').textContent = (e as Error).message; }
  finally { busy = false; document.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = false); bindingDetail(); }
}
function loadGraph(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected an API-format graph object');
  graph = value as Graph; el('graph').textContent = JSON.stringify(graph, null, 2);
  imageInput.replaceChildren(option('', 'Choose the image input explicitly'), ...Object.entries(graph).filter(([,node]) => node?.class_type === 'LoadImage').map(([id]) => option(id, `LoadImage ${id} · image`)));
  el('outputs').replaceChildren(); const legend = document.createElement('legend'); legend.textContent = 'Declared output nodes'; el('outputs').append(legend);
  for (const [id,node] of Object.entries(graph)) if (node?.class_type === 'SaveImage') {
    const label = document.createElement('label'), check = document.createElement('input'); check.type = 'checkbox'; check.value = id; label.append(check, `SaveImage ${id}`); el('outputs').append(label);
  }
  el('status').textContent = 'Graph loaded. Choose the image input and declare its SaveImage outputs before saving.';
}
function drawJobs() {
  el('jobs').replaceChildren();
  for (const job of [...jobs].reverse()) {
    const card = document.createElement('article'), title = document.createElement('h3'), info = document.createElement('p'), message = document.createElement('p'), track = document.createElement('button');
    title.textContent = `Passthrough · ${job.status}`; info.textContent = `Prompt ${job.promptId} · request revision ${job.requestRevision}`; info.className = 'note'; message.textContent = job.message;
    track.textContent = 'Track exact prompt'; track.onclick = () => action(async () => { await api('comfy/track', { jobId: job.id }); await reload(); });
    card.append(title,info,message); if (!['failed','closed'].includes(job.status)) card.append(track);
    if (job.status === 'uncertain') {
      const recovery = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = 'Resolve an absent prompt without retrying'; recovery.append(summary);
      const idle = document.createElement('input'), reviewed = document.createElement('input');
      for (const [check, text] of [[idle, 'I confirmed the backend is idle'], [reviewed, 'I reviewed backend history and output files; outcome may remain unknown']] as const) { check.type = 'checkbox'; const label = document.createElement('label'); label.append(check, text); recovery.append(label); }
      const close = document.createElement('button'); close.textContent = 'Close this receipt · no retry'; close.onclick = () => action(async () => { await api('comfy/reconcile', { jobId: job.id, backendIdle: idle.checked, historyReviewed: reviewed.checked }); await reload(); }); recovery.append(close); card.append(recovery);
    }
    const link = document.createElement('a'); link.href = '/#shot-' + job.shotId; link.textContent = 'Originating shot'; card.append(link);
    for (const result of job.results) { const img = document.createElement('img'), a = document.createElement('a'); a.href = `/renders/${result.id}.png`; a.download = `passthrough-${job.id}.png`; img.src = a.href; img.alt = `Local passthrough output ${result.nodeId} — no AI generation`; a.append(img); card.append(a); }
    el('jobs').append(card);
  }
}
async function reload() {
  const selectedRender = source.value || new URLSearchParams(location.search).get('render'), selectedBinding = bindings.value;
  const result = await api('project'); project = result.project; jobs = result.comfyJobs;
  source.replaceChildren(option('', 'Choose a saved render'), ...project.renders.filter(r => r.binding).map(r => option(r.id, `${project.shots.find(s => s.id === r.shotId)?.title || r.shotId} · ${r.pass} · ${r.id.slice(0,8)}`)));
  if (selectedRender) source.value = selectedRender;
  bindings.replaceChildren(option('', 'Choose a saved binding'), ...project.workflowBindings.map(b => option(b.id, b.title + ' · ' + b.id.slice(0,8))));
  if (selectedBinding) bindings.value = selectedBinding;
  sourceDetail(); bindingDetail(); drawJobs();
}
source.onchange = sourceDetail; bindings.onchange = bindingDetail;
el('example').onclick = () => loadGraph({ '1': { class_type: 'LoadImage', inputs: { image: 'choose-a-saved-render.png' } }, '2': { class_type: 'SaveImage', inputs: { images: ['1',0], filename_prefix: 'previs/passthrough' } } });
el<HTMLInputElement>('import').onchange = () => action(async () => { const file = el<HTMLInputElement>('import').files?.[0]; if (!file) return; if (file.size > 256000) throw Error('Workflow must be under 256 KB'); loadGraph(JSON.parse(await file.text())); });
el('bind').onclick = () => action(async () => {
  if (!source.value || !graph || !imageInput.value) throw Error('Choose a saved render, graph and explicit image input');
  const outputNodeIds = Array.from(el('outputs').querySelectorAll<HTMLInputElement>('input:checked')).map(c => c.value);
  const result = await api('comfy/bind', { revision: project.revision, title: el<HTMLInputElement>('binding-title').value, renderId: source.value, graph, imageNodeId: imageInput.value, outputNodeIds });
  await reload(); bindings.value = result.project.workflowBindings.at(-1).id; bindingDetail(); el('status').textContent = 'Explicit binding saved. Inspect local compatibility before submitting.';
});
el('inspect').onclick = () => action(async () => {
  const { readiness } = await api('comfy/inspect', {}); compatible = readiness.compatible;
  el('readiness').textContent = `${readiness.origin} · ${readiness.version || 'unavailable'} · ${readiness.message}${readiness.queue ? ` Queue: ${readiness.queue.running} running, ${readiness.queue.pending} pending.` : ''}`;
});
el('submit').onclick = () => action(async () => {
  const requestId = crypto.randomUUID(); el('status').textContent = `Submitting once · ${requestId}. If the connection fails, reload saved jobs.`;
  const { job } = await api('comfy/submit', { revision: project.revision, workflowBindingId: bindings.value, requestId });
  el('status').textContent = job.message; await reload();
});
el('reload').onclick = () => action(reload);
setInterval(() => { if (!busy && jobs.some(j => ['queued','running'].includes(j.status))) void action(async () => { for (const job of jobs.filter(j => ['queued','running'].includes(j.status))) await api('comfy/track', { jobId: job.id }); await reload(); }); }, 2500);
void action(async () => { await reload(); el('status').textContent = `Project restored · revision ${project.revision}. Saved jobs are never resubmitted.`; });
