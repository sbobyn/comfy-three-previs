// Simulation: actual TS adapter, routes, store and backend adapter; fake DOM/fetch.
// Only disposable local fixtures are written. No server, browser, media process,
// Blender, Comfy, network, GPU, downloads or cleanup/deletion runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { openProject } from '../server/previs/store.mjs';
import { generationRoutes } from '../server/previs/generation-routes.mjs';
import { hashBytes } from '../server/previs/workflows.mjs';
import { openGeneration } from '../server/previs/generation.mjs';
import { backendSnapshot } from '../server/previs/backends.mjs';
import { createSlots } from '../server/previs/concurrency.mjs';
import { createJobTracker } from '../server/previs/job-tracker.mjs';
import { assertNoSecrets } from '../server/previs/workflows.mjs';

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
async function browserFixture(h, { intercept, search = '?shot=shot' } = {}) {
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
  const requests = [],location={search};
  const history={replaceState(_state,_title,url){location.search=url;}};
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
    HTMLSelectElement: Select, location, history, URLSearchParams,
    crypto: { randomUUID }, fetch,
  }, { filename: 'previs-generation.simulation.cjs' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(el('status').textContent, search.includes('job=missing')?/This saved comparison is not in the open project/:/^Project revision/);
  el('workflow').change(h.workflow.id);
  const role = name => descendants(el('asset-bindings')).find(e => e.attributes['aria-label'] === name + ' asset');
  role('firstFrame').change('render:' + h.image.id);
  el('prompt').input('New prompt');
  const parameter = name => descendants(el('parameters')).find(e => e.attributes['aria-label'] === name);
  const compare = () => descendants(el('jobs')).find(e => e.textContent === 'Compare source / result').click();
  return { el, role, parameter, requests, compare, location };
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

test('simulation: quote prices the prepared video and render settings never reset its mapping', async t => {
  const workflow={...definition(),task:'transform-video',pricing:{ratePerSecond:0.126,creditsPerSecond:26.59},graph:{
    '1':{class_type:'LoadVideo',inputs:{file:'author.mp4'}},
    '2':{class_type:'KlingOmniProEditVideoNode',inputs:{video:['1',0],model_name:'kling-video-o1',resolution:'720p'}},
    '3':{class_type:'SaveVideo',inputs:{video:['2',0]}},
    '4':{class_type:'LoadImage',inputs:{image:'author.png'}}
  },inputs:{sourceVideo:{nodeId:'1',input:'file'},firstFrame:{nodeId:'4',input:'image'}},outputs:[{nodeId:'3',mediaType:'video/mp4'}]};
  const h=await fixture(t,{workflow}),ids=[randomUUID(),randomUUID()];
  await mkdir(join(h.root,'assets'));
  for(const id of ids)await writeFile(join(h.root,'assets',id+'.mp4'),Buffer.from('SIMULATED video'));
  await h.project.mutate(h.project.get().revision,p=>{p.assets=ids.map((id,i)=>({id,kind:'video',source:i?'comfy':'blender',shotId:'shot',version:i+1,url:'/assets/'+id+'.mp4',mimeType:'video/mp4',sha256:hashBytes(Buffer.from('SIMULATED video')),width:1280,height:720,duration:i?8:3,fps:24,frameCount:i?192:72,audio:false,requestRevision:1,binding:sourceBinding}));});
  const ui=await browserFixture(h);
  ui.role('sourceVideo').change('asset:'+ids[1]);assert.equal(ui.el('asset').value,ids[1]);
  ui.el('asset').value=ids[0]; // A stale player must never determine the quote.
  ui.el('fps').input('12');assert.equal(ui.role('sourceVideo').value,'asset:'+ids[1]);
  await ui.el('prepare').click();
  assert.match(ui.el('status').textContent,/Prepared exact request/);
  assert.equal(h.routes.state().jobs[0].sources.sourceVideo.id,ids[1]);
  assert.match(ui.el('quote').textContent,/\$1\.008 USD/);assert.match(ui.el('quote').textContent,/212\.72 Comfy credits/);
  assert.equal(h.state.submissions.length,0);
  ui.el('asset').change(ids[0]);assert.equal(ui.role('sourceVideo').value,'asset:'+ids[0]);
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
  assert.equal(ui.el('compare-result').currentTime, 2); assert.equal(ui.el('compare-result').paused, true);
  assert.match(ui.el('playback-position').textContent,/Result 2.000 s · ended/);
});

test('simulation: comparison has an empty state, exact downloads and output-scoped saved notes after reload', async t => {
  const h=await fixture(t),job=await h.complete(),ui=await browserFixture(h);
  assert.equal(ui.el('comparison-empty').hidden,false);assert.equal(ui.el('compare-source').hidden,true);assert.equal(ui.el('play-both').disabled,true);
  ui.compare();assert.equal(ui.el('comparison-empty').hidden,true);
  assert.equal(ui.el('source-download').href,'/renders/'+h.image.id+'.png');assert.equal(ui.el('result-download').href,job.results[0].url);
  assert.match(ui.el('comparison-detail').textContent,/Source camera/);assert.doesNotMatch(ui.el('comparison-detail').textContent,/Rebound camera/);
  ui.el('review-notes').value='Reviewed first output';await ui.el('review').click();
  ui.el('comparison-output').change(job.results[1].id);assert.equal(ui.el('review-notes').value,'');
  ui.el('review-notes').value='Unsaved second output';ui.el('comparison-output').change(job.results[0].id);
  assert.equal(ui.el('review-notes').value,'Reviewed first output');
  await ui.el('reload').click();assert.equal(ui.el('review-notes').value,'Reviewed first output');
  assert.match(ui.el('saved-review').textContent,/Saved review/);assert.equal(h.state.submissions.length,1);
});

test('simulation: timing disclosure follows mapped values and invalidates its acknowledgment', async t => {
  const workflow=definition();workflow.graph['8']={class_type:'Timing',inputs:{frames:73,fps:24,width:832,height:480}};
  workflow.parameters={frames:{nodeId:'8',input:'frames'},fps:{nodeId:'8',input:'fps'}};
  workflow.constraints={timingChange:'Review configured timing',outputTiming:{frameCount:{nodeId:'8',input:'frames'},fps:{nodeId:'8',input:'fps'},width:{nodeId:'8',input:'width'},height:{nodeId:'8',input:'height'}}};
  const h=await fixture(t,{workflow}),ui=await browserFixture(h);
  assert.match(ui.el('timing-description').textContent,/73 frames \/ 24 fps = 3.041667 s/);
  ui.el('accept-timing').change(true);ui.parameter('Timing · frames').change('121');ui.parameter('Timing · fps').change('12');
  assert.equal(ui.el('accept-timing').checked,false);assert.match(ui.el('timing-description').textContent,/121 frames \/ 12 fps = 10.083333 s/);
  await ui.el('prepare').click();await ui.el('reload').click();
  assert.match(ui.el('timing-description').textContent,/73 frames \/ 24 fps/);
  ui.el('accept-timing').change(true);await ui.el('restore-binding').click();
  assert.equal(ui.el('accept-timing').checked,false);assert.match(ui.el('timing-description').textContent,/121 frames \/ 12 fps = 10.083333 s/);
  assert.equal(h.state.submissions.length,0);
});

test('simulation: rebinding a saved camera refreshes its inspected lens metadata', async () => {
  const source=await readFile(new URL('../src/previs.ts',import.meta.url),'utf8'),html=await readFile(new URL('../previs.html',import.meta.url),'utf8');
  const elements=new Map();for(const[,tag,id]of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g))elements.set(id,tag==='select'?new Select():new Element(tag));
  const project={revision:1,shots:[{id:'shot',title:'Telephoto',binding:{source:'blender',scene:'Scene',camera:'Long',fps:24,start:1,end:24,frame:1},renders:[]}],renders:[]};
  const catalog={file:'/fixture.blend',token:'fixture',scenes:[{name:'Scene',fps:24,start:1,end:24,cameras:['Wide','Long'],cameraDetails:{Wide:{type:'PERSP',mm:24,sensorWidth:36,frame:1},Long:{type:'PERSP',mm:85,sensorWidth:36,frame:1}}}]};
  runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
    exports:{},require(){},setInterval(){},document:{getElementById:id=>elements.get(id),createElement:tag=>tag==='select'?new Select():new Element(tag),querySelectorAll:()=>[]},
    fetch:async path=>({ok:true,json:async()=>path==='/api/project'?{project}:path==='/api/readiness'?{blender:{}}:{catalog,serverInfo:{name:'Simulated MCP'}}})
  });
  await new Promise(resolve=>setImmediate(resolve));
  await descendants(elements.get('shots')).find(e=>e.textContent==='Rebind camera / range').click();
  assert.equal(elements.get('camera').value,'Long');assert.match(elements.get('camera-detail').textContent,/85 mm/);assert.doesNotMatch(elements.get('camera-detail').textContent,/24 mm/);
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


test('simulation: absent private comparison gives a recovery instruction rather than selecting a QA result',async t=>{
  const h=await fixture(t),ui=await browserFixture(h,{search:'?shot=shot&job=missing'});
  assert.match(ui.el('status').textContent,/complete project folder/);
  assert.equal(ui.el('comparison-empty').hidden,false);assert.equal(ui.el('submit').disabled,true);
});


test('simulation: full page reload preserves the deliberate job/output and its exact review/download',async t=>{
  const h=await fixture(t),job=await h.complete(),ui=await browserFixture(h);
  ui.compare();ui.el('comparison-output').change(job.results[1].id);
  ui.el('review-notes').value='Selected second output, no replacement.';await ui.el('review').click();
  const query=new URLSearchParams(ui.location.search);
  assert.equal(query.get('job'),job.id);assert.equal(query.get('output'),job.results[1].id);
  const reopened=await browserFixture(h,{search:ui.location.search});
  assert.equal(reopened.el('comparison-output').value,job.results[1].id);
  assert.equal(reopened.el('review-notes').value,'Selected second output, no replacement.');
  assert.equal(reopened.el('result-download').href,job.results[1].url);
  assert.equal(h.state.submissions.length,1);
});

test('simulation: a stale source deep link refuses fallback while the original graph stays intact',async t=>{
  const h=await fixture(t),before=structuredClone(h.project.get().workflowDefinitions);
  const id=randomUUID();await h.project.mutate(h.project.get().revision,p=>p.assets=[{id,shotId:'shot',kind:'video',source:'three',version:1,width:1280,height:720,frameCount:72,fps:24,duration:3,audio:false,url:'/assets/'+id+'.mp4',binding:sourceBinding}]);
  const ui=await browserFixture(h,{search:'?shot=shot&asset=unavailable'});
  assert.equal(ui.el('asset').value,'');assert.equal(ui.el('source').hidden,true);
  assert.match(ui.el('asset-detail').textContent,/no other capture was substituted/);
  assert.deepEqual(h.project.get().workflowDefinitions,before);
  assert.equal(h.state.submissions.length,0);
});


test('simulation: missing comparison output never substitutes the first candidate',async t=>{
  const h=await fixture(t),job=await h.complete();
  const ui=await browserFixture(h,{search:'?shot=shot&job='+job.id+'&output=missing'});
  assert.equal(ui.el('comparison-output').value,'');assert.equal(ui.el('compare-result-image').hidden,true);
  assert.equal(ui.el('result-download').hidden,true);assert.equal(ui.el('review').disabled,true);
  assert.match(ui.el('comparison-empty').textContent,/no candidate was substituted/);
  await ui.el('reload').click();assert.equal(ui.el('comparison-output').value,'');assert.equal(ui.el('review').disabled,true);assert.equal(new URLSearchParams(ui.location.search).get('output'),'missing');
  ui.el('comparison-output').change(job.results[1].id);
  assert.equal(ui.el('result-download').href,job.results[1].url);assert.equal(ui.el('review').disabled,false);
});


test('simulation: a newly rendered Blender source remains selected across full page refresh',async t=>{
  const h=await fixture(t),id=randomUUID(),asset={id,kind:'video',source:'blender',shotId:'shot',version:1,url:'/assets/'+id+'.mp4',width:1280,height:720,frameCount:72,fps:24,duration:3,audio:false,requestRevision:1,binding:sourceBinding};
  const route=h.routes.route;t.mock.method(h.routes,'route',async(path,input)=>{
    if(path!=='/api/video/blender')return route(path,input);
    const project=await h.project.mutate(input.revision,p=>p.assets.push(asset));return{project,asset};
  });
  const ui=await browserFixture(h);await ui.el('render-video').click();
  assert.equal(ui.el('asset').value,id);assert.equal(new URLSearchParams(ui.location.search).get('asset'),id);
  const reopened=await browserFixture(h,{search:ui.location.search});
  assert.equal(reopened.el('asset').value,id);assert.equal(reopened.el('source').src,asset.url);
  assert.equal(h.state.submissions.length,0);
});


for(const phase of ['bind','quote','refresh'])test('simulation: input edits during '+phase+' never re-enable stale request approval',async t=>{
  const h=await fixture(t),entered=deferred(),resume=deferred();let hold=false;
  const ui=await browserFixture(h,{intercept:async path=>{if(hold&&path===(phase==='refresh'?'/api/generation':'/api/generation/'+phase)){entered.resolve();await resume.promise;}}});
  hold=true;const preparing=ui.el('prepare').click();await entered.promise;
  try{
    assert.equal(ui.el('workspace-controls').disabled,true,'native fieldset prevents ordinary user edits while action is pending');
    // Simulate a queued change event or another script, bypassing native disabled controls.
    ui.el('prompt').input('Changed while request is pending');
  }finally{resume.resolve();await preparing;}
  assert.equal(ui.el('workspace-controls').disabled,false);
  assert.match(ui.el('status').textContent,/Inputs changed during preparation/);
  assert.equal(ui.el('request').textContent,'');assert.equal(ui.el('approve').checked,false);assert.equal(ui.el('submit').disabled,true);
  ui.el('approve').change(true);assert.equal(ui.el('submit').disabled,true);
  assert.equal(h.state.submissions.length,0);assert.equal(h.state.uploads.length,0);
  hold=false;await ui.el('prepare').click();
  const latest=h.routes.state().jobs.find(j=>j.binding.prompt==='Changed while request is pending');assert.ok(latest);assert.equal(latest.status,'quoted');
});

test('simulation: workbench views retain exact source/request state and comparison identity', async t => {
  const h = await fixture(t); await h.complete();
  const ui = await browserFixture(h);
  await ui.el('prepare').click();
  const request = ui.el('request').textContent, prompt = ui.el('prompt').value;
  ui.compare();
  assert.equal(ui.el('source-panel').hidden, true);
  assert.equal(ui.el('request-panel').hidden, true);
  assert.equal(ui.el('comparison-panel').hidden, false);
  assert.equal(ui.el('compare-view').attributes['aria-pressed'], 'true');
  const output = ui.el('comparison-output').value;
  ui.el('source-view').click();
  assert.equal(ui.el('source-panel').hidden, false);
  assert.equal(ui.el('request-panel').hidden, false);
  assert.equal(ui.el('request').textContent, request);
  assert.equal(ui.el('prompt').value, prompt);
  ui.el('compare-view').click();
  assert.equal(ui.el('comparison-output').value, output);
  assert.equal(ui.el('source-view').attributes['aria-pressed'], 'false');
});

test('simulation: unknown outcomes stay visible and opening recovery never dispatches or reconciles', async t => {
  const h = await fixture(t); const completed = await h.complete();
  const originalState = h.routes.state;
  h.routes.state = () => ({...originalState(), jobs: [{...completed, status:'uncertain', results:[], message:'Simulated acceptance unknown', failure:{phase:'submitting'}}]});
  const ui = await browserFixture(h);
  assert.equal(ui.el('unknown-jobs').hidden, false);
  assert.match(ui.el('unknown-jobs').textContent, /UNKNOWN OUTCOME.*Do not submit again/);
  assert.equal(ui.el('job-history').open, true);
  assert.match(ui.el('job-summary').textContent, /1 UNKNOWN OUTCOME/);
  let announcements=0, message=ui.el('unknown-jobs').textContent;
  Object.defineProperty(ui.el('unknown-jobs'),'textContent',{get:()=>message,set:value=>{message=value;announcements++;}});
  ui.el('compare-view').click(); ui.el('source-view').click(); await ui.el('reload').click();
  assert.equal(announcements,0,'unchanged unknown-outcome alert is not rewritten');
  assert.equal(ui.requests.filter(r => /submit|reconcile|track/.test(r.path)).length, 0);
});

test('simulation: reload preserves a deliberate return from comparison to source/request', async t => {
  const h = await fixture(t); await h.complete(); const ui = await browserFixture(h);
  ui.compare(); const output=ui.el('comparison-output').value;
  ui.el('source-view').click(); await ui.el('reload').click();
  assert.equal(ui.el('source-panel').hidden,false);
  assert.equal(ui.el('request-panel').hidden,false);
  assert.equal(ui.el('comparison-panel').hidden,true);
  assert.equal(ui.el('comparison-output').value,output);
  assert.equal(ui.el('source-view').attributes['aria-pressed'],'true');
});

test('simulation: a collected Comfy output reused as input is never labelled as a scene capture', async t => {
  const h=await fixture(t);
  await h.project.mutate(h.project.get().revision,p=>p.assets.push({id:'retained-output',shotId:'shot',kind:'video',source:'comfy',version:1,width:1280,height:720,frameCount:73,fps:24,duration:73/24,requestRevision:18,binding:sourceBinding,url:'/assets/retained-output.mp4'}));
  const ui=await browserFixture(h);ui.el('asset').change('retained-output');
  assert.match(ui.el('capture-summary').textContent,/^Comfy result v1/);
  assert.doesNotMatch(ui.el('capture-summary').textContent,/^Captured/);
  assert.match(ui.el('capture-origin').textContent,/^Original input binding of this Comfy result/);
});

// Engine checks against a fake Cloud adapter (backendFactory): nothing leaves the process and nothing is paid.
async function cloudFixture({ limit = '2', submitError = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'previs-generation-cloud-'));
  const project = await openProject(root), image = await project.image(png);
  await project.mutate(project.get().revision, p => {
    p.shots.push({ id: 'shot', title: 'Cloud shot', binding: requestBinding, renders: [image.id] });
    p.renders.push({ ...image, shotId: 'shot', source: 'blender', binding: sourceBinding, requestRevision: 1 });
    p.assets = []; p.workflowDefinitions = [definition()];
  });
  const calls = { uploads: 0, submits: 0, values: [] };
  const backendFactory = selection => ({
    snapshot: backendSnapshot(selection),
    async inspect() { return { objectInfo: structuredClone(schema) }; },
    async queue() { return { queue_running: [], queue_pending: [] }; },
    async upload(bytes) { calls.uploads++; return { name: hashBytes(bytes) + '.png', subfolder: '', type: 'input', value: hashBytes(bytes) + '.png' }; },
    async submit({ graph, requestId }) { calls.submits++; calls.values.push(graph['1'].inputs.image); if (submitError) throw submitError(); return { promptId: 'cloud-' + requestId.slice(0, 8) }; },
    async history() { return null; },
  });
  const generation = await openGeneration(root, project, { backendFactory, allowPaid: true, slots: createSlots({ env: { PREVIS_LIMIT_CLOUD_IMAGES: limit } }) });
  async function quoted() {
    const id = randomUUID();
    await project.mutate(project.get().revision, p => { p.workflowBindings.push({ id, definitionId: 'definition', shotId: 'shot', assetBindings: { firstFrame: { renderId: image.id } }, prompt: 'cloud', parameters: {}, createdAt: new Date().toISOString() }); });
    const input = { requestId: randomUUID(), revision: project.get().revision, workflowBindingId: id, backend: { kind: 'cloud' } };
    return { input, job: await generation.quote(input) };
  }
  const consent = job => ({ approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 1, allowUnknownCharges: true } });
  return { root, project, generation, calls, quoted, consent };
}

test('engine: two concurrent Cloud submits fit a limit of 2, the third is refused busy and stays quoted', async () => {
  const h = await cloudFixture({ limit: '2' }), requests = [await h.quoted(), await h.quoted(), await h.quoted()];
  const sent = await Promise.all(requests.slice(0, 2).map(({ input, job }) => h.generation.submit({ ...input, approval: h.consent(job) })));
  assert.deepEqual(sent.map(job => job.status), ['queued', 'queued']);
  const [, , third] = requests;
  await assert.rejects(h.generation.submit({ ...third.input, approval: h.consent(third.job) }),
    e => e.status === 409 && e.apiCode === 'busy' && e.retryAfterSeconds === 15 && e.message === 'Backend busy: 2 of 2 cloud image slots in use; retry when a job finishes');
  assert.equal(h.generation.get(third.input.requestId).status, 'quoted');
  assert.equal(h.calls.submits, 2);
  // Upload cache: three requests bound to the same render bytes uploaded them once.
  assert.equal(h.calls.uploads, 1); assert.equal(new Set(h.calls.values).size, 1);
  const cache = JSON.parse(await readFile(join(h.root, 'upload-cache.json'), 'utf8'));
  assert.equal(Object.keys(cache.entries).length, 1); assert.match(Object.keys(cache.entries)[0], /^[a-f0-9]{64}:cloud:https:\/\/cloud\.comfy\.org$/);
});

test('engine: a rejected dispatch persists redacted failure.detail and never the key', async t => {
  const secret = 'test-cloud-key-' + 'q'.repeat(20), previous = process.env.COMFY_CLOUD_API_KEY;
  process.env.COMFY_CLOUD_API_KEY = secret;
  t.after(() => { if (previous === undefined) delete process.env.COMFY_CLOUD_API_KEY; else process.env.COMFY_CLOUD_API_KEY = previous; });
  const h = await cloudFixture({ submitError: () => Object.assign(Error('Backend /prompt returned HTTP 400'), { httpStatus: 400, detail: `{"error":{"type":"prompt_outputs_failed_validation"},"extra_data":{"api_key_comfy_org":"${secret}"}}` }) });
  const { input, job } = await h.quoted();
  const failed = await h.generation.submit({ ...input, approval: h.consent(job) });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure.phase, 'dispatch'); assert.equal(failed.failure.httpStatus, 400);
  assert.match(failed.failure.detail, /HTTP 400 — .*prompt_outputs_failed_validation/); assert.ok(failed.failure.detail.length <= 500);
  const receipt = await readFile(join(h.root, 'generation-jobs', job.id + '.json'), 'utf8');
  assert.equal(receipt.includes(secret), false); assert.doesNotThrow(() => assertNoSecrets(JSON.parse(receipt)));
  // A transport failure before dispatch (e.g. an upload timeout) is a preparation failure with its cause kept.
  const h2 = await cloudFixture();
  const { input: input2, job: job2 } = await h2.quoted();
  await h2.project.mutate(h2.project.get().revision, () => {}); // unrelated edit between quote and submit
  const slow = await openGeneration(h2.root, h2.project, { allowPaid: true, slots: createSlots(), backendFactory: selection => ({ snapshot: backendSnapshot(selection), inspect: async () => ({ objectInfo: structuredClone(schema) }), upload: async () => { throw Object.assign(Error('Backend transport failed; no automatic retry'), { detail: '/upload/image: timed out after 120 s' }); } }) });
  const prep = await slow.submit({ ...input2, approval: h2.consent(job2) });
  assert.equal(prep.status, 'failed'); assert.deepEqual(prep.failure, { phase: 'preparation', httpStatus: null, detail: 'Backend transport failed; no automatic retry — /upload/image: timed out after 120 s' });
});

test('engine: a quote survives unrelated project edits but not a changed source', async t => {
  const h = await fixture(t), input = await h.bind(), { job: quoted } = await h.route('quote', input);
  await h.bind(); // another pipeline binds a shot: the global revision moves
  await h.project.mutate(h.project.get().revision, p => { p.shots.push({ id: 'other', title: 'Other shot', binding: requestBinding, renders: [] }); });
  assert.ok(h.project.get().revision > input.revision);
  const { job } = await h.route('submit', { ...input, approval: approval(quoted) });
  assert.equal(job.status, 'queued'); assert.equal(job.requestRevision, input.revision, 'request revision stays as provenance');
  assert.equal((await h.route('track', { jobId: input.requestId })).job.status, 'completed');
  const second = await h.bind(), { job: q2 } = await h.route('quote', second);
  await h.project.mutate(h.project.get().revision, p => { p.renders[0].binding = { ...p.renders[0].binding, camera: 'Changed source camera' }; });
  await assert.rejects(h.route('submit', { ...second, approval: approval(q2) }), e => e.status === 409 && /Approval invalidated/.test(e.message));
  assert.equal(h.routes.state().jobs.find(j => j.id === second.requestId).status, 'invalidated');
  await assert.rejects(h.route('quote', { ...second, requestId: randomUUID(), revision: h.project.get().revision + 5 }), e => e.status === 409);
});

test('engine: the server tracker collects and attaches a queued job without a client track call', async t => {
  const h = await fixture(t), input = await h.bind(), { job: quoted } = await h.route('quote', input);
  let now = Date.parse('2026-10-30T12:00:00Z');
  const tracker = createJobTracker({ sources: [h.routes.trackerSource()], now: () => now, tickMs: 0 });
  h.routes.useTracker(tracker); tracker.start();
  assert.equal(tracker.snapshot().tracker.resumed, 0);
  await h.route('submit', { ...input, approval: approval(quoted) });
  let [row] = tracker.snapshot().jobs;
  assert.equal(row.status, 'queued'); assert.equal(row.source, 'generation'); assert.equal(row.kind, 'image'); assert.equal(row.expectedSeconds, 600, 'local backend');
  assert.match(row.label, /^Rebound shot · Simulated first frame$/); assert.ok(row.nextTrackAt);
  now += 5000; await tracker.tick();
  [row] = tracker.snapshot().jobs;
  assert.equal(row.status, 'completed'); assert.equal(row.trackCount, 1); assert.equal(row.results.length, 2);
  assert.equal(h.project.get().assets.length, 2, 'onTerminal attached results to the project');
  const receipt = JSON.parse(await readFile(join(h.root, 'generation-jobs', input.requestId + '.json'), 'utf8'));
  assert.equal(receipt.tracking.trackCount, 1); assert.ok(receipt.tracking.lastTrackedAt);
  // The HTTP route keeps its { job, project } shape and does not attach twice.
  const again = await h.route('track', { jobId: input.requestId });
  assert.equal(again.job.status, 'completed'); assert.equal(again.project.assets.length, 2);
});
