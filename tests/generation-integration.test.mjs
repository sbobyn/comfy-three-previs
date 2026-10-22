// Simulation: actual TS adapter, routes, store and backend adapter; fake DOM/fetch.
// Only disposable local fixtures are written. No server, browser, media process,
// Blender, Comfy, network, GPU, downloads or cleanup/deletion runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { openProject } from '../server/previs/store.mjs';
import { generationRoutes } from '../server/previs/generation-routes.mjs';
import { hashBytes } from '../server/previs/workflows.mjs';

const source = await readFile(new URL('../src/previs-generation.ts', import.meta.url), 'utf8');
const html = await readFile(new URL('../generation.html', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const backend = { kind: 'local', url: 'http://127.0.0.1:8188' };
const sourceBinding = { source: 'blender', scene: 'Saved scene', camera: 'Source camera', start: 1, end: 72, frame: 1, fps: 24 };
const requestBinding = { ...sourceBinding, camera: 'Rebound camera', start: 40, end: 80, frame: 40 };
const definition = () => ({
  version: 1, id: 'definition', title: 'Simulated first frame', task: 'first-frame',
  graph: {
    '1': { class_type: 'LoadImage', inputs: { image: 'author.png' } },
    '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'author/output' } },
  },
  inputs: { firstFrame: { nodeId: '1', input: 'image' } },
  outputs: [{ nodeId: '2', mediaType: 'image/png' }],
});
const schema = {
  LoadImage: { python_module: 'nodes', output: ['IMAGE', 'MASK'], input: { required: { image: [['author.png'], { image_upload: true }] } } },
  SaveImage: { python_module: 'nodes', output_node: true, output: [], input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } } },
  CLIPTextEncode: { python_module: 'nodes', output: ['CONDITIONING'], input: { required: { text: ['STRING'] } } },
};
const approval = job => ({ approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 0 } });

async function fixture(t, { workflow = definition() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'previs-generation-integration-'));
  const project = await openProject(root), image = await project.image(png);
  await project.mutate(project.get().revision, p => {
    p.shots.push({ id: 'shot', title: 'Rebound shot', binding: requestBinding, renders: [image.id] });
    p.renders.push({ ...image, shotId: 'shot', source: 'blender', binding: sourceBinding, requestRevision: 1 });
    p.assets = []; p.workflowDefinitions = [workflow];
  });
  const state = { schema: structuredClone(schema), calls: [], uploads: [], submissions: [], views: [] };
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  // Intercept the actual backend adapter's transport, including unexpected URLs.
  // There is deliberately no fallback to the original fetch.
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const parsed = new URL(url); assert.equal(parsed.origin, backend.url);
    state.calls.push(parsed.pathname);
    if (parsed.pathname === '/object_info') return json(state.schema);
    if (parsed.pathname === '/queue') return json({ queue_running: [], queue_pending: [] });
    if (parsed.pathname === '/upload/image') {
      assert.equal(init.method, 'POST'); assert.ok(init.body instanceof FormData);
      const image = init.body.get('image'), bytes = Buffer.from(await image.arrayBuffer());
      state.uploads.push({ bytes, name: image.name });
      return json({ name: image.name, subfolder: init.body.get('subfolder'), type: 'input' });
    }
    if (parsed.pathname === '/prompt') {
      assert.equal(init.method, 'POST'); const body = JSON.parse(init.body);
      state.submissions.push(body); return json({ prompt_id: body.prompt_id });
    }
    if (parsed.pathname.startsWith('/history/')) {
      const id = parsed.pathname.split('/').at(-1), body = state.submissions.find(s => s.prompt_id === id);
      assert.ok(body, 'history must identify a submitted request');
      return json({ [id]: { prompt: [0, id, body.prompt, body.extra_data], status: { completed: true, status_str: 'success' }, outputs: {
        '2': { images: [{ filename: 'first.png', subfolder: '', type: 'output' }, { filename: 'second.png', subfolder: '', type: 'output' }] },
        '99': { images: [{ filename: 'undeclared.png', subfolder: '', type: 'output' }] },
      } } });
    }
    if (parsed.pathname === '/view') {
      const filename = parsed.searchParams.get('filename');
      assert.ok(['first.png', 'second.png'].includes(filename)); state.views.push(filename);
      return new Response(png);
    }
    assert.fail('Unexpected simulated backend endpoint: ' + parsed.pathname);
  });
  const routes = await generationRoutes(root, project);
  const route = (operation, input) => routes.route('/api/generation/' + operation, input);
  async function bind(extra = {}) {
    const bound = await route('bind', { revision: project.get().revision, definitionId: workflow.id, shotId: 'shot', assetBindings: { firstFrame: { renderId: image.id } }, prompt: 'New prompt', parameters: {}, ...extra });
    return { requestId: randomUUID(), revision: bound.project.revision, workflowBindingId: bound.workflowBindingId, backend };
  }
  async function complete() {
    const input = await bind(), { job: quoted } = await route('quote', input);
    assert.equal(quoted.validation.compatible, true);
    assert.equal((await route('submit', { ...input, approval: approval(quoted) })).job.status, 'queued');
    const { job } = await route('track', { jobId: input.requestId });
    assert.equal(job.status, 'completed'); return job;
  }
  return { root, project, image, workflow, state, routes, route, bind, complete };
}

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {};
    this.value = ''; this.textContent = ''; this.type = ''; this.checked = false;
    this.disabled = false; this.hidden = false; this.duration = NaN; this.currentTime = 0;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'src') { this.src = ''; this.duration = NaN; } }
  pause() { this.paused = true; }
  async play() { this.paused = false; }
  click() { if (!this.disabled) return this.onclick?.(); }
  change(value) { if (this.type === 'checkbox') this.checked = value; else this.value = String(value); return this.onchange?.(); }
  input(value) { this.value = String(value); return this.oninput?.(); }
}
class Select extends Element {
  constructor() { super('select'); this.type = 'select-one'; }
  get options() { return this.children; }
  get value() { return this.selected?.value || ''; }
  // Real selects clear an unavailable assignment. A generic value bag would
  // hide the LoRA regression that this suite is intended to catch.
  set value(value) { this.selected = this.children.find(option => option.value === String(value)); }
  append(...children) { super.append(...children); if (!this.selected) this.selected = this.children[0]; }
  replaceChildren(...children) { this.selected = undefined; super.replaceChildren(...children); }
}
function descendants(element) { return element.children.flatMap(child => [child, ...descendants(child)]); }
function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function browserFixture(h, { intercept } = {}) {
  const elements = new Map(), createElement = tag => tag === 'select' ? new Select() : new Element(tag);
  // Use the actual page IDs, initial field values and disabled/hidden states.
  for (const [, tag, attributes, id] of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = createElement(tag); elements.set(id, element);
    element.type = attributes.match(/\btype="([^"]+)"/)?.[1] || element.type;
    element.value = attributes.match(/\bvalue="([^"]*)"/)?.[1] || '';
    element.hidden = /\bhidden\b/.test(attributes); element.disabled = /\bdisabled\b/.test(attributes);
  }
  const el = id => { assert.ok(elements.has(id), 'Unknown page element ' + id); return elements.get(id); };
  for (const [, id, content] of html.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    for (const [, value, text] of content.matchAll(/<option\b[^>]*\bvalue="([^"]*)"[^>]*>([^<]*)<\/option>/g)) {
      const option = createElement('option'); option.value = value; option.textContent = text; el(id).append(option);
    }
  }
  el('task').value = h.workflow.task; el('backend').value = 'local'; el('endpoint').value = backend.url;
  const requests = [];
  const fetch = async (path, init) => {
    const input = init.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ path, input }); await intercept?.(path, input);
    let data;
    try {
      if (path === '/api/project') data = { project: h.project.get() };
      else if (path === '/api/generation') data = h.routes.state();
      else { assert.equal(init.method, 'POST'); data = await h.routes.route(path, input); }
      return { ok: true, json: async () => structuredClone(data) };
    } catch (error) { return { ok: false, json: async () => ({ error: error.message }) }; }
  };
  runInNewContext(compiled, {
    exports: {}, require(name) { assert.equal(name, './previs.css'); },
    document: { getElementById: el, createElement, createTextNode: text => Object.assign(new Element('text'), { textContent: text }) },
    HTMLSelectElement: Select, location: { search: '?shot=shot' }, URLSearchParams,
    crypto: { randomUUID }, fetch,
  }, { filename: 'previs-generation.simulation.cjs' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(el('status').textContent, /^Project revision/);
  el('workflow').change(h.workflow.id);
  const role = name => descendants(el('asset-bindings')).find(e => e.attributes['aria-label'] === name + ' asset');
  role('firstFrame').change('render:' + h.image.id);
  el('prompt').input('New prompt');
  const parameter = name => descendants(el('parameters')).find(e => e.attributes['aria-label'] === name);
  const compare = () => descendants(el('jobs')).find(e => e.textContent === 'Compare source / result').click();
  return { el, role, parameter, requests, compare };
}

test('simulation: replacing an approved quote clears consent before awaiting the new binding', async t => {
  const h = await fixture(t), entered = deferred(), resume = deferred();
  let hold = false;
  const ui = await browserFixture(h, { intercept: async path => {
    if (hold && path === '/api/generation/bind') { entered.resolve(); await resume.promise; }
  } });
  await ui.el('prepare').click();
  const first = h.routes.state().jobs[0]; assert.equal(first.status, 'quoted');
  ui.el('approve').change(true); assert.equal(ui.el('submit').disabled, false);
  hold = true; const replacing = ui.el('prepare').click();
  try {
    await entered.promise;
    assert.equal(ui.el('approve').checked, false);
    assert.equal(ui.el('submit').disabled, true);
  } finally { resume.resolve(); await replacing; }
  const second = h.routes.state().jobs.find(job => job.id !== first.id);
  assert.ok(second); assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(ui.el('approve').checked, false); assert.equal(ui.el('submit').disabled, true);
  await ui.el('submit').click(); assert.equal(h.state.submissions.length, 0);
  ui.el('approve').change(true); await ui.el('submit').click();
  assert.equal(h.state.submissions.length, 1); assert.equal(h.state.submissions[0].prompt_id, second.id);
  assert.equal(h.routes.state().jobs.find(job => job.id === first.id).status, 'quoted');
  assert.equal(ui.el('approve').checked, false);
});

test('simulation: failed quote replacement leaves the previous request unapproved and disabled', async t => {
  const h = await fixture(t), ui = await browserFixture(h);
  await ui.el('prepare').click(); ui.el('approve').change(true);
  // No change event: Prepare itself must invalidate approval even if validation fails.
  ui.role('firstFrame').value = '';
  await ui.el('prepare').click();
  assert.match(ui.el('status').textContent, /Choose firstFrame explicitly/);
  assert.equal(ui.el('approve').checked, false); assert.equal(ui.el('submit').disabled, true);
  ui.el('approve').change(true); assert.equal(ui.el('submit').disabled, true);
  await ui.el('submit').click(); assert.equal(h.state.submissions.length, 0);
});

test('simulation: collected outputs retain the source camera and distinct request-shot snapshot', async t => {
  const h = await fixture(t), input = await h.bind(), { job: quoted } = await h.route('quote', input);
  await h.route('submit', { ...input, approval: approval(quoted) });
  await h.project.mutate(h.project.get().revision, p => { p.shots[0].binding.camera = 'Edited while queued'; });
  const { job, project } = await h.route('track', { jobId: input.requestId });
  assert.equal(job.status, 'completed'); assert.equal(project.assets.length, 2);
  for (const asset of project.assets) {
    assert.deepEqual(asset.binding, sourceBinding);
    assert.deepEqual(asset.provenance.requestShot.binding, requestBinding);
    assert.deepEqual(asset.provenance.sourceAssets.firstFrame.binding, sourceBinding);
    assert.equal(asset.requestRevision, input.revision);
  }
  assert.equal(project.shots[0].binding.camera, 'Edited while queued');
  assert.deepEqual(h.state.views, ['first.png', 'second.png']);
  const again = await h.route('track', { jobId: job.id });
  assert.equal(again.project.revision, project.revision); assert.equal(again.project.assets.length, 2);
  assert.equal(h.state.views.length, 2);
});

test('simulation: a collected PNG in renders can be rebound as an asset and submitted again', async t => {
  const h = await fixture(t), first = await h.complete(), asset = h.project.get().assets[0];
  assert.equal(asset.url, '/renders/' + asset.id + '.png');
  assert.deepEqual(await readFile(join(h.root, 'renders', asset.filename)), png);
  const input = await h.bind({ assetBindings: { firstFrame: { assetId: asset.id } } });
  const { job: quoted } = await h.route('quote', input);
  assert.equal(quoted.validation.compatible, true);
  assert.equal(quoted.sources.firstFrame.sourceType, 'asset');
  assert.equal(quoted.sources.firstFrame.sha256, hashBytes(png));
  assert.deepEqual(quoted.sources.firstFrame.binding, sourceBinding);
  assert.equal((await h.route('submit', { ...input, approval: approval(quoted) })).job.status, 'queued');
  assert.equal(h.state.submissions.length, 2); assert.notEqual(input.requestId, first.id);
  assert.deepEqual(h.state.uploads.map(upload => upload.bytes), [png, png]);
  const second = await h.route('track', { jobId: input.requestId });
  assert.equal(second.job.status, 'completed'); assert.equal(second.project.assets.length, 4);
  assert.deepEqual(second.project.assets.at(-1).binding, sourceBinding);
});

test('simulation: collected PNG reuse requires the exact renders URL and original content hash', async t => {
  const h = await fixture(t); await h.complete(); const asset = h.project.get().assets[0];
  await h.project.mutate(h.project.get().revision, p => { p.assets[0].url += '?alternate'; });
  let input = await h.bind({ assetBindings: { firstFrame: { assetId: asset.id } } });
  await assert.rejects(h.route('quote', input), { code: 'ENOENT' });
  await h.project.mutate(h.project.get().revision, p => { p.assets[0].url = asset.url; p.assets[0].sha256 = '0'.repeat(64); });
  input = await h.bind({ assetBindings: { firstFrame: { assetId: asset.id } } });
  await assert.rejects(h.route('quote', input), /hash changed/);
  assert.equal(h.state.submissions.length, 1); assert.equal(h.state.uploads.length, 1);
});

test('simulation: first-frame/PNG comparison displays images and reviews only the selected output', async t => {
  const h = await fixture(t), job = await h.complete(), ui = await browserFixture(h);
  ui.compare();
  assert.equal(ui.el('compare-source-image').hidden, false);
  assert.equal(ui.el('compare-source-image').src, '/renders/' + h.image.id + '.png');
  assert.equal(ui.el('compare-source').hidden, true);
  assert.equal(ui.el('compare-result-image').hidden, false);
  assert.equal(ui.el('compare-result-image').src, job.results[0].url);
  assert.equal(ui.el('compare-result').hidden, true);
  assert.deepEqual(ui.el('comparison-output').options.map(o => o.value), job.results.map(r => r.id));
  ui.el('comparison-output').change(job.results[1].id);
  assert.equal(ui.el('compare-result-image').src, job.results[1].url);
  assert.match(ui.el('differences').textContent, /still image has no camera-motion timing/);
  ui.el('review-notes').value = 'Second declared PNG preserves the source framing.';
  await ui.el('review').click();
  const review = h.project.get().reviews[0];
  assert.equal(review.jobId, job.id); assert.deepEqual(review.resultIds, [job.results[1].id]);
  assert.equal(review.notes, ui.el('review-notes').value);
  assert.equal(h.state.submissions.length, 1);
});

test('simulation: review rejects absent, empty and foreign output identities without mutating the project', async t => {
  const h = await fixture(t), job = await h.complete();
  const review = () => ({ revision: h.project.get().revision, jobId: job.id, visuallyReviewed: true, notes: 'Inspected the selected image.' });
  const before = h.project.get();
  for (const resultIds of [undefined, [], 'all', [randomUUID()], [job.results[0].id, randomUUID()]]) {
    await assert.rejects(h.route('review', { ...review(), resultIds }), /exact collected output/);
    assert.deepEqual(h.project.get(), before);
  }
  await h.route('review', { ...review(), resultIds: [job.results[1].id, job.results[1].id] });
  assert.deepEqual(h.project.get().reviews[0].resultIds, [job.results[1].id]);
});

test('simulation: comparison switches between image and video outputs without retaining stale media', async t => {
  const h = await fixture(t), collected = await h.complete();
  const video = { id: randomUUID(), nodeId: 'video-output', kind: 'video', mimeType: 'video/mp4', url: '/assets/simulated.mp4', width: 640, height: 360, fps: 30, frameCount: 60, duration: 2, audio: false };
  // Only DOM media metadata is simulated: no video bytes are decoded or played.
  const mixed = { ...collected, results: [collected.results[0], video] };
  const videos = { ...collected, id: randomUUID(), sources: { sourceVideo: { ...video, url: '/assets/simulated-source.mp4', fps: 24, frameCount: 96, duration: 4 } }, results: [video] };
  const state = h.routes.state;
  t.mock.method(h.routes, 'state', () => ({ ...state(), jobs: [mixed, videos] }));
  const ui = await browserFixture(h); ui.compare();
  ui.el('comparison-output').change(video.id);
  assert.equal(ui.el('compare-source-image').hidden, false);
  assert.equal(ui.el('compare-result').hidden, false); assert.equal(ui.el('compare-result').src, video.url);
  assert.equal(ui.el('compare-result-image').hidden, true); assert.equal(ui.el('compare-result-image').src, '');
  assert.equal(ui.el('seek').max, '2');
  ui.el('comparison-output').change(collected.results[0].id);
  assert.equal(ui.el('compare-result').hidden, true); assert.equal(ui.el('compare-result').src, '');
  assert.equal(ui.el('compare-result-image').src, collected.results[0].url);
  const buttons = descendants(ui.el('jobs')).filter(e => e.textContent === 'Compare source / result');
  buttons[1].click();
  assert.equal(ui.el('compare-source-image').hidden, true); assert.equal(ui.el('compare-source-image').src, '');
  assert.equal(ui.el('compare-source').src, videos.sources.sourceVideo.url);
  assert.equal(ui.el('seek').max, '4'); assert.match(ui.el('differences').textContent, /fps: 24 → 30 CHANGED/);
  assert.match(ui.el('differences').textContent, /duration: 4 → 2 CHANGED/);
  ui.el('compare-source').duration = 4; ui.el('compare-result').duration = 2;
  ui.el('seek').input('1'); await ui.el('play-both').click();
  assert.equal(ui.el('compare-source').currentTime, 1); assert.equal(ui.el('compare-result').currentTime, 1);
  assert.equal(ui.el('compare-source').paused, false); assert.equal(ui.el('compare-result').paused, false);
  ui.el('seek').input('3'); await ui.el('play-both').click();
  assert.equal(ui.el('compare-source').currentTime, 3); assert.equal(ui.el('compare-source').paused, false);
  assert.equal(ui.el('compare-result').currentTime, 1); assert.equal(ui.el('compare-result').paused, true);
});

test('simulation: live inspection retains a user-selected LoRA missing from both author and backend choices', async t => {
  const workflow = definition();
  workflow.graph['4'] = { class_type: 'LoraLoader', inputs: { lora_name: 'author.safetensors', strength_model: 0.73, strength_clip: -0.3 } };
  workflow.parameters = {
    lora: { nodeId: '4', input: 'lora_name', label: 'LoRA filename' },
    modelStrength: { nodeId: '4', input: 'strength_model', label: 'Model strength' },
    clipStrength: { nodeId: '4', input: 'strength_clip', label: 'Clip strength' },
  };
  const h = await fixture(t, { workflow });
  h.state.schema.LoraLoader = { python_module: 'nodes', output: ['MODEL', 'CLIP'], input: { required: {
    lora_name: [['author.safetensors', 'chosen.safetensors']], strength_model: ['FLOAT'], strength_clip: ['FLOAT'],
  } } };
  const ui = await browserFixture(h); await ui.el('inspect').click();
  ui.parameter('LoRA filename').change('chosen.safetensors');
  ui.parameter('Model strength').change('1.25'); ui.parameter('Clip strength').change('-0.6');
  h.state.schema.LoraLoader.input.required.lora_name[0] = ['backend-only.safetensors'];
  await ui.el('inspect').click();
  assert.equal(ui.parameter('LoRA filename').value, 'chosen.safetensors');
  assert.match(ui.parameter('LoRA filename').options.find(o => o.value === 'chosen.safetensors').textContent, /unavailable/);
  assert.equal(ui.parameter('Model strength').value, '1.25'); assert.equal(ui.parameter('Clip strength').value, '-0.6');
  await ui.el('prepare').click();
  const job = h.routes.state().jobs[0]; assert.equal(job.status, 'quoted');
  assert.equal(job.validation.compatible, false);
  assert.ok(job.validation.issues.some(issue => issue.code === 'missing-model' && issue.value === 'chosen.safetensors'));
  assert.deepEqual(job.preparedGraph['4'].inputs, { lora_name: 'chosen.safetensors', strength_model: 1.25, strength_clip: -0.6 });
  assert.deepEqual(h.project.get().workflowDefinitions[0].graph, workflow.graph);
  ui.el('approve').change(true); assert.equal(ui.el('submit').disabled, true);
  assert.equal(h.state.submissions.length, 0); assert.equal(h.state.uploads.length, 0);
});

test('simulation: a saved unavailable LoRA survives reload, restore and live inspection', async t => {
  const workflow = definition();
  workflow.graph['4'] = { class_type: 'LoraLoader', inputs: { lora_name: 'author.safetensors' } };
  workflow.parameters = { lora: { nodeId: '4', input: 'lora_name', label: 'LoRA filename' } };
  const h = await fixture(t, { workflow });
  h.state.schema.LoraLoader = { python_module: 'nodes', output: ['MODEL', 'CLIP'], input: { required: { lora_name: [['backend-only.safetensors']] } } };
  const ui = await browserFixture(h);
  ui.parameter('LoRA filename').change('chosen.safetensors');
  await ui.el('prepare').click();
  assert.equal(h.project.get().workflowBindings.at(-1).parameters.lora, 'chosen.safetensors');
  await ui.el('inspect').click(); assert.equal(ui.parameter('LoRA filename').value, 'chosen.safetensors');
  await ui.el('reload').click(); await ui.el('restore-binding').click();
  assert.equal(ui.parameter('LoRA filename').value, 'chosen.safetensors');
  await ui.el('inspect').click(); assert.equal(ui.parameter('LoRA filename').value, 'chosen.safetensors');
  assert.equal(h.state.uploads.length, 0); assert.equal(h.state.submissions.length, 0);
});

test('simulation: timing changes require literal true acknowledgment before submission', async t => {
  const workflow = definition(); workflow.constraints = { timingChange: 'Output uses a fixed 73 frames at 24 fps.' };
  const h = await fixture(t, { workflow });
  for (const acceptTimingChange of [undefined, false, 'true', 1]) {
    const input = await h.bind({ acceptTimingChange }), { job } = await h.route('quote', input);
    assert.equal(job.validation.compatible, false);
    assert.ok(job.validation.issues.some(issue => issue.code === 'timing-review' && issue.message.includes(workflow.constraints.timingChange)));
    await assert.rejects(h.route('submit', { ...input, approval: approval(job) }), /not schema-compatible/);
  }
  assert.equal(h.state.uploads.length, 0); assert.equal(h.state.submissions.length, 0);
  const input = await h.bind({ acceptTimingChange: true }), { job } = await h.route('quote', input);
  assert.equal(job.binding.acceptTimingChange, true); assert.equal(job.validation.compatible, true);
  assert.equal((await h.route('submit', { ...input, approval: approval(job) })).job.status, 'queued');
  assert.equal(h.state.submissions.length, 1);
});

test('simulation: prompt maximum accepts the boundary and rejects an overlong prompt before transport', async t => {
  const workflow = definition(); workflow.constraints = { promptMaxLength: 5 };
  workflow.graph['3'] = { class_type: 'CLIPTextEncode', inputs: { text: 'Author prompt' } };
  workflow.inputs.prompt = { nodeId: '3', input: 'text' };
  const h = await fixture(t, { workflow });
  const boundary = await h.bind({ prompt: '12345' }), { job } = await h.route('quote', boundary);
  assert.equal(job.validation.compatible, true); assert.equal(job.preparedGraph['3'].inputs.text, '12345');
  const calls = h.state.calls.length;
  const overlong = await h.bind({ prompt: '123456' });
  await assert.rejects(h.route('quote', overlong), /Prompt exceeds workflow maximum length/);
  assert.equal(h.state.calls.length, calls); assert.equal(h.state.uploads.length, 0); assert.equal(h.state.submissions.length, 0);
});
