// Simulated schemas/transports only: no model, GPU, paid call or live submission.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openProject } from '../server/previs/store.mjs';
import { atomicJson } from '../server/previs/atomic.mjs';
import { validateWorkflowDefinition, validateGraph, hashValue, hashBytes, workflowCost, validateApproval, assertNoSecrets } from '../server/previs/workflows.mjs';
import { createBackend, backendSnapshot, backendTransportKey, safeMediaLocation } from '../server/previs/backends.mjs';
import { openGeneration, declaredOutputs, validateAssetConstraints } from '../server/previs/generation.mjs';
import { createSlots } from '../server/previs/concurrency.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const graph = { '1': { class_type: 'LoadImage', inputs: { image: 'author.png' }, _meta: { title: 'Keep authored label' } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'author/output' } } };
const schema = {
  LoadImage: { python_module: 'nodes', output: ['IMAGE', 'MASK'], input: { required: { image: [['author.png'], { image_upload: true }] } } },
  SaveImage: { python_module: 'nodes', output_node: true, output: [], input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'ComfyUI' }] } } },
};
// Priced (a list rate), so Cloud submits pass the budget authority; local ones are free either way.
const definition = () => ({ version: 1, id: 'definition', task: 'passthrough', graph: structuredClone(graph), inputs: { image: { nodeId: '1', input: 'image' } }, outputs: [{ nodeId: '2', mediaType: 'image/png' }], pricing: { status: 'estimate', currency: 'USD', ratePerSecond: 0.1 } });
const approve = job => ({ approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 0 } });
const deferred = [{ nodeId: '1', input: 'image', kind: 'image', mime: 'image/png', filename: 'new.png' }];

test('definition roundtrip preserves unknown nodes, private model names, LoRA chains and author strengths', () => {
  const source = definition();
  source.graph['10'] = { class_type: 'PrivateCheckpoint', inputs: { ckpt_name: 'studio/private.safetensors' }, _meta: { title: 'Private model' } };
  source.graph['11'] = { class_type: 'LoraLoader', inputs: { model: ['10', 0], clip: ['10', 1], lora_name: 'author/custom.safetensors', strength_model: 0.73, strength_clip: -0.3 } };
  source.graph['12'] = { class_type: 'LoraLoader', inputs: { model: ['11', 0], clip: ['11', 1], lora_name: 'second.safetensors', strength_model: 1.2, strength_clip: 0 } };
  source.parameters = { authorLora: { nodeId: '11', input: 'lora_name', kind: 'lora-filename' }, authorStrength: { nodeId: '11', input: 'strength_model', kind: 'lora-strength' } };
  const imported = validateWorkflowDefinition(source);
  assert.deepEqual(imported.graph, source.graph);
  assert.deepEqual(validateWorkflowDefinition(JSON.parse(JSON.stringify(imported))), imported);
  assert.throws(() => { imported.graph['11'].inputs.strength_model = 0; }, TypeError);
  const info = structuredClone(schema);
  info.PrivateCheckpoint = { output: ['MODEL', 'CLIP'], input: { required: { ckpt_name: ['COMBO', { options: ['studio/private.safetensors'] }] } } };
  info.LoraLoader = { output: ['MODEL', 'CLIP'], input: { required: { model: ['MODEL'], clip: ['CLIP'], lora_name: [['author/custom.safetensors', 'second.safetensors']], strength_model: ['FLOAT', { min: -100, max: 100 }], strength_clip: ['FLOAT', { min: -100, max: 100 }] } } };
  assert.equal(validateGraph(imported.graph, info).compatible, true);
  info.LoraLoader.input.required.lora_name[0] = ['second.safetensors'];
  let checked = validateGraph(imported.graph, info);
  assert.deepEqual(checked.issues.find(issue => issue.code === 'missing-model').value, 'author/custom.safetensors');
  delete info.PrivateCheckpoint;
  checked = validateGraph(imported.graph, info);
  assert.ok(checked.issues.some(issue => issue.code === 'missing-node' && issue.nodeId === '10'));
  assert.deepEqual(imported.graph, source.graph);
});

test('schema checks required/optional/defaults, typed links, upload placeholders and exact media loaders', () => {
  assert.equal(validateGraph(graph, schema).compatible, true);
  const modified = structuredClone(graph); modified['1'].inputs.image = 'not-uploaded.png';
  assert.equal(validateGraph(modified, schema).compatible, false);
  assert.equal(validateGraph(modified, schema, { deferredInputs: deferred }).compatible, true);
  assert.ok(validateGraph(modified, schema, { deferredInputs: [{ ...deferred[0], kind: 'video' }] }).issues.some(issue => issue.code === 'unsupported-media-loader'));
  modified['2'].inputs.images = ['1', 1];
  assert.ok(validateGraph(modified, schema).issues.some(issue => issue.code === 'type-mismatch'));
  modified['2'].inputs.images = ['missing', 0];
  assert.ok(validateGraph(modified, schema).issues.some(issue => issue.code === 'invalid-link'));
  delete modified['2'].inputs.filename_prefix;
  assert.ok(validateGraph(modified, schema).issues.some(issue => issue.code === 'missing-input' && issue.default === 'ComfyUI'));
  const changed = structuredClone(schema); changed.SaveImage.input.optional = { optional: ['BOOLEAN', { default: false }] };
  assert.equal(validateGraph(graph, changed).compatible, true);
  assert.notEqual(validateGraph(graph, changed).schemaHash, validateGraph(graph, schema).schemaHash);
  const inventory = structuredClone(schema); inventory.LoadImage.input.required.image[0].push('new-upload.png');
  assert.equal(validateGraph(graph, inventory).schemaHash, validateGraph(graph, schema).schemaHash);
});

const dynamic = options => ['COMFY_DYNAMICCOMBO_V3', { options }];
const videoSchema = {
  LoadVideo: { python_module: 'comfy_extras.nodes_video', output: ['VIDEO'], input: { required: { file: ['COMBO', { options: ['author.mp4'], video_upload: true }] } } },
  GetVideoComponents: { python_module: 'comfy_extras.nodes_video', output: ['IMAGE', 'AUDIO', 'FLOAT'], input: { required: { video: ['VIDEO'] } } },
  ImageInvert: { python_module: 'nodes', output: ['IMAGE'], input: { required: { image: ['IMAGE'] } } },
  CreateVideo: { python_module: 'comfy_extras.nodes_video', output: ['VIDEO'], input: { required: { images: ['IMAGE'], fps: ['FLOAT', { min: 1, max: 120 }] }, optional: { audio: ['AUDIO'] } } },
  SaveVideo: { python_module: 'comfy_extras.nodes_video', output: [], output_node: true, input: { required: { video: ['VIDEO'], filename_prefix: ['STRING'], format: dynamic([{ key: 'mp4', inputs: { required: { codec: dynamic([{ key: 'h264', inputs: { optional: { encoding: dynamic([{ key: 'auto', inputs: { required: {} } }, { key: 're-encode', inputs: { required: { crf: ['FLOAT', { min: 0, max: 51, default: 18 }] } } }]) } } }]) } } }]) } } },
};
const videoGraph = {
  '1': { class_type: 'LoadVideo', inputs: { file: 'author.mp4' } },
  '2': { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
  '3': { class_type: 'ImageInvert', inputs: { image: ['2', 0] } },
  '4': { class_type: 'CreateVideo', inputs: { images: ['3', 0], fps: ['2', 2] } },
  '5': { class_type: 'SaveVideo', inputs: { video: ['4', 0], filename_prefix: 'author', format: 'mp4', 'format.codec': 'h264', 'format.codec.encoding': 're-encode', 'format.codec.encoding.crf': 21 } },
};
test('V3 COMBO and recursive dynamic choices validate native IMAGE/VIDEO conversion without timing substitution', () => {
  assert.equal(validateGraph(videoGraph, videoSchema).compatible, true);
  const bad = structuredClone(videoGraph); bad['5'].inputs['format.codec.encoding.crf'] = 99;
  assert.ok(validateGraph(bad, videoSchema).issues.some(issue => issue.code === 'out-of-range'));
  delete bad['5'].inputs['format.codec'];
  assert.ok(validateGraph(bad, videoSchema).issues.some(issue => issue.code === 'missing-input' && issue.input === 'format.codec'));
  assert.equal(workflowCost(videoGraph, videoSchema, { kind: 'local' }).amount, 0);
  assert.equal(workflowCost(videoGraph, videoSchema, { kind: 'cloud' }).status, 'unknown');
  const disguised = structuredClone(videoSchema); disguised.ImageInvert.python_module = 'custom_nodes.billable';
  assert.equal(workflowCost(videoGraph, disguised, { kind: 'local' }).status, 'unknown');
  const paid = structuredClone(videoSchema); paid.ImageInvert.api_node = true; paid.ImageInvert.price_badge = { engine: 'jsonata', expr: '0.126 per second' };
  const quote = workflowCost(videoGraph, paid, { kind: 'local' });
  assert.equal(quote.status, 'unknown'); assert.equal(quote.nodes[2].apiNode, true);
  assert.throws(() => validateApproval(undefined, 'hash', quote), /Explicit approval/);
  assert.throws(() => validateApproval({ approved: true, fingerprint: 'hash', allowance: { currency: 'USD', maxAmount: 100 } }, 'hash', quote), /Unknown charges/);
  assert.equal(validateApproval({ approved: true, fingerprint: 'hash', allowance: { currency: 'USD', maxAmount: 100, allowUnknownCharges: true } }, 'hash', quote), true);
});

test('secret-bearing graphs and export metadata are rejected without echoing credentials', () => {
  for (const extra of [{ api_key: 'do-not-print' }, { api_key_comfy_org: '' }, { nested: { password: 'do-not-print' } }, { prompt: 'Bearer literalcredential' }, { url: 'https://example.test/?token=credential' }]) {
    const value = definition(); value.provenance = extra;
    assert.throws(() => validateWorkflowDefinition(value), error => !error.message.includes('do-not-print') && /Credential|credential/.test(error.message));
  }
  assert.doesNotThrow(() => assertNoSecrets({ max_tokens: 200, token_count: 5 }));
  assert.throws(() => backendSnapshot({ kind: 'cloud', apiKey: 'do-not-print' }));
  for (const url of ['http://example.com', 'https://127.0.0.1:8188', 'http://localhost:8188/path', 'http://user:pass@127.0.0.1:8188']) assert.throws(() => backendSnapshot({ kind: 'local', url }));
});

test('native local inference has no API fee without trusting model names or imported prices', () => {
  const graph = Object.fromEntries(['CheckpointLoaderSimple','ImageScale','CLIPTextEncode','VAEEncode','KSampler','VAEDecode'].map((class_type,i)=>[String(i),{class_type,inputs:{}}]));
  graph['0'].inputs.ckpt_name='private-studio-model.safetensors';
  const info=Object.fromEntries(Object.values(graph).map(n=>[n.class_type,{python_module:'nodes'}]));
  assert.equal(workflowCost(graph,info,{kind:'local'}).amount,0);
  assert.equal(workflowCost(graph,info,{kind:'cloud'}).status,'unknown');
  for(const change of [{python_module:'custom_nodes.sampler'},{api_node:true},{price_badge:{label:'billable'}}]){
    const changed=structuredClone(info);Object.assign(changed.KSampler,change);
    assert.equal(workflowCost(graph,changed,{kind:'local'}).status,'unknown');
  }
  delete info.KSampler;
  assert.equal(workflowCost(graph,info,{kind:'local'}).status,'unknown');
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'previs-generation-')), project = await openProject(root), image = await project.image(png);
  await project.mutate(project.get().revision, p => {
    p.shots.push({ id: 'shot', binding: { source: 'browser', frame: 1, fps: 24 }, renders: [image.id] });
    p.renders.push({ ...image, shotId: 'shot', binding: { source: 'browser', frame: 1, fps: 24 }, requestRevision: 1 });
    p.workflowDefinitions = [definition()];
    p.workflowBindings.push({ id: 'binding', definitionId: 'definition', shotId: 'shot', assetBindings: { image: { renderId: image.id } }, prompt: 'A careful camera move', parameters: {} });
  });
  const state = { schema: structuredClone(schema), submits: 0, uploads: 0, views: 0, visible: false, mismatch: false, ambiguous: false, queueBusy: false, submitted: null };
  const backendFactory = selection => ({
    snapshot: selection,
    inspect: async () => ({ objectInfo: state.schema }),
    queue: async () => ({ queue_running: state.queueBusy ? [[0, 'other']] : [], queue_pending: [] }),
    upload: async (_bytes, input) => { state.uploads++; return { name: input.filename, subfolder: input.subfolder, value: input.subfolder + '/' + input.filename }; },
    submit: async input => { state.submits++; state.submitted = input; if (state.ambiguous) throw Error('SIMULATED lost response'); return { promptId: input.requestId }; },
    history: async promptId => !state.visible ? null : { promptId, requestId: state.mismatch ? 'wrong' : state.submitted.requestId, graph: state.submitted.graph, status: { completed: true, status_str: 'success' }, outputs: { '2': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] }, '99': { images: [{ filename: 'private.png', subfolder: '', type: 'output' }] } } },
    view: async location => { state.views++; assert.notEqual(location.filename, 'private.png'); return png; },
  });
  const input = () => ({ requestId: randomUUID(), revision: project.get().revision, workflowBindingId: 'binding', backend: { kind: 'local', url: 'http://127.0.0.1:8188' } });
  return { root, project, state, backendFactory, input };
}

test('prepare/quote have no uploads; prompt, schema, backend, settings and revision changes invalidate approval', async () => {
  const f = await fixture(), generation = await openGeneration(f.root, f.project, { backendFactory: f.backendFactory });
  const input = f.input(), prepared = await generation.prepare(input), quoted = await generation.quote(input);
  assert.equal(prepared.status, 'prepared'); assert.equal(quoted.status, 'quoted'); assert.equal(quoted.quote.amount, 0);
  assert.equal(f.state.uploads, 0); assert.equal(f.state.submits, 0);
  const anotherQuote = await generation.quote(f.input());
  assert.notEqual(quoted.fingerprint, anotherQuote.fingerprint, 'one approval cannot authorize a second request UUID');
  await assert.rejects(generation.submit(input), /approval/);
  f.state.schema.SaveImage.input.optional = { newSetting: ['INT', { default: 1 }] };
  await assert.rejects(generation.submit({ ...input, approval: approve(quoted) }), /invalidated/);
  assert.equal(generation.get(input.requestId).status, 'invalidated');
  const refreshed = await generation.quote(input);
  assert.notEqual(refreshed.fingerprint, quoted.fingerprint);
  await assert.rejects(generation.submit({ ...input, backend: { kind: 'local', url: 'http://127.0.0.1:9999' }, approval: approve(refreshed) }), /invalidated/);
  const before = await generation.quote(input);
  await f.project.mutate(f.project.get().revision, p => { p.workflowBindings[0].prompt = 'Changed prompt'; });
  const changedInput = { ...input, revision: f.project.get().revision };
  await assert.rejects(generation.submit({ ...changedInput, approval: approve(before) }), /invalidated/);
  assert.equal(f.state.submits, 0);
  const after = await generation.quote(changedInput);
  assert.notEqual(after.fingerprint, before.fingerprint);
});

test('durable uncertain receipt, duplicate/concurrent submission, restart and declared PNG collection', async () => {
  const f = await fixture(); f.state.ambiguous = true;
  let generation = await openGeneration(f.root, f.project, { backendFactory: f.backendFactory });
  const input = f.input(), quoted = await generation.quote(input);
  f.state.queueBusy = true;
  await assert.rejects(generation.submit({ ...input, approval: approve(quoted) }), /queue is busy/);
  assert.equal(f.state.uploads, 0); f.state.queueBusy = false;
  const requests = await Promise.all([generation.submit({ ...input, approval: approve(quoted) }), generation.submit({ ...input, approval: approve(quoted) })]);
  assert.equal(requests[0].status, 'uncertain'); assert.equal(requests[1].status, 'uncertain'); assert.equal(f.state.submits, 1);
  const onDisk = JSON.parse(await readFile(join(f.root, 'generation-jobs', input.requestId + '.json'), 'utf8'));
  assert.equal(onDisk.id, input.requestId); assert.ok(onDisk.submittedGraph);
  assert.deepEqual(f.project.get().workflowDefinitions[0].graph, graph);
  generation = await openGeneration(f.root, f.project, { backendFactory: f.backendFactory });
  assert.equal((await generation.submit(input)).status, 'uncertain');
  assert.equal((await generation.track(input.requestId)).status, 'uncertain');
  const second = f.input(), secondQuote = await generation.quote(second);
  await assert.rejects(generation.submit({ ...second, approval: approve(secondQuote) }), e => e.status === 409 && e.apiCode === 'busy' && /Backend busy: 1 of 1 local slot/.test(e.message));
  f.state.visible = true; f.state.mismatch = true;
  await generation.track(input.requestId); assert.equal(f.state.views, 0);
  f.state.mismatch = false;
  await f.project.mutate(f.project.get().revision, p => { p.shots[0].binding.frame = 30; });
  const result = await generation.track(input.requestId);
  assert.equal(result.status, 'completed'); assert.equal(result.results.length, 1); assert.equal(result.results[0].requestRevision, input.revision);
  assert.equal(result.shot.binding.frame, 1); assert.equal(result.results[0].generationJobId, input.requestId);
  assert.equal(result.results[0].url, '/renders/' + result.results[0].filename);
  assert.deepEqual(await readFile(join(f.root, 'renders', result.results[0].filename)), png);
  await generation.track(input.requestId); assert.equal(f.state.views, 1); assert.equal(f.state.submits, 1);
  assert.equal(f.project.get().renders.length, 1, 'parent owns attachment');
});

test('default checkpoint blocks paid/unknown execution even after explicit unknown-charge approval', async () => {
  const f = await fixture(); f.state.schema.LoadImage.api_node = true;
  const generation = await openGeneration(f.root, f.project, { backendFactory: f.backendFactory });
  const input = f.input(), quoted = await generation.quote(input);
  assert.equal(quoted.quote.status, 'unknown');
  const approval = approve(quoted); approval.allowance.allowUnknownCharges = true; approval.allowance.maxAmount = 20;
  await assert.rejects(generation.submit({ ...input, approval }), /disabled at this checkpoint/);
  assert.equal(f.state.submits, 0); assert.equal(f.state.uploads, 0);
});

test('unresolved transport lock survives display aliases, loopback aliases and restart', async () => {
  for(const kind of ['local','cloud']){
    const f=await fixture();f.state.ambiguous=true;
    // An uncertain request holds its slot; with one slot per transport, nothing else may be sent.
    const slots=()=>createSlots({env:{PREVIS_LIMIT_LOCAL:'1',PREVIS_LIMIT_CLOUD_IMAGES:'1',PREVIS_LIMIT_CLOUD_VIDEOS:'1'}});
    let generation=await openGeneration(f.root,f.project,{backendFactory:f.backendFactory,allowPaid:true,slots:slots()});
    const first={...f.input(),backend:{kind,...(kind==='local'?{url:'http://localhost:8188'}:{})}},quote=await generation.quote(first);
    const approval={approved:true,fingerprint:quote.fingerprint,allowance:{currency:'USD',maxAmount:1,allowUnknownCharges:true}};
    assert.equal((await generation.submit({...first,approval})).status,'uncertain');
    generation=await openGeneration(f.root,f.project,{backendFactory:f.backendFactory,allowPaid:true,slots:slots()});
    for(const url of kind==='local'?['http://127.0.0.1:8188','http://[::1]:8188']:['https://cloud.comfy.org']){
      const next={...f.input(),backend:{kind,url,id:'another-label'}},q=await generation.quote(next);
      await assert.rejects(generation.submit({...next,approval:{...approval,fingerprint:q.fingerprint}}),e=>e.apiCode==='busy'&&/Backend busy: 1 of 1 /.test(e.message));
    }
    assert.equal(f.state.submits,1);assert.equal(f.state.uploads,1);
  }
  assert.notEqual(backendTransportKey({url:'http://localhost:8188'}),backendTransportKey({url:'http://localhost:8189'}));
});

test('journal write failure prevents dispatch; restart during dispatch becomes uncertain', async () => {
  const f = await fixture();
  const persist = async (path, job) => { if (job.status === 'submitting') throw Error('SIMULATED disk full'); return atomicJson(path, job); };
  const generation = await openGeneration(f.root, f.project, { backendFactory: f.backendFactory, persist });
  const input = f.input(), quoted = await generation.quote(input);
  assert.equal((await generation.submit({ ...input, approval: approve(quoted) })).status, 'failed');
  assert.equal(f.state.submits, 0);
  const receipt = generation.get(input.requestId); receipt.status = 'submitting';
  await atomicJson(join(f.root, 'generation-jobs', receipt.id + '.json'), receipt);
  const restarted = await openGeneration(f.root, f.project, { backendFactory: f.backendFactory });
  assert.equal(restarted.get(receipt.id).status, 'uncertain');
  assert.equal((await restarted.submit(input)).status, 'uncertain'); assert.equal(f.state.submits, 0);
});

test('uncertain recovery requires both acknowledgments and an idle backend without retrying', async () => {
  const f=await fixture();f.state.ambiguous=true;
  const generation=await openGeneration(f.root,f.project,{backendFactory:f.backendFactory}),input=f.input(),q=await generation.quote(input);
  await generation.submit({...input,approval:approve(q)});
  for(const ack of [{},{backendIdle:true},{historyReviewed:true}])await assert.rejects(generation.reconcile({jobId:input.requestId,...ack}),/Confirm the exact uncertain request/);
  f.state.queueBusy=true;await assert.rejects(generation.reconcile({jobId:input.requestId,backendIdle:true,historyReviewed:true}),/queue must be empty/);
  f.state.queueBusy=false;const closed=await generation.reconcile({jobId:input.requestId,backendIdle:true,historyReviewed:true});
  assert.equal(closed.status,'closed');assert.match(closed.message,/Outcome remains unknown/);
  assert.equal((await generation.submit(input)).status,'closed');assert.equal(f.state.submits,1);
});

test('actual asset shape, source hashes and constraints, video probe before save and timing preserved', async () => {
  const f = await fixture(), bytes = Buffer.from('SIMULATED video bytes'), id = randomUUID();
  await mkdir(join(f.root, 'assets'));
  await writeFile(join(f.root, 'assets', id + '.mp4'), bytes);
  await f.project.mutate(f.project.get().revision, p => {
    p.assets = [{ id, kind: 'video', version: 1, shotId: 'shot', source: 'browser', binding: { camera: 'Camera' }, requestRevision: 2, width: 1280, height: 720, fps: 24, fpsRational: '24/1', frameCount: 72, duration: 3, audio: false, mimeType: 'video/mp4', url: `/assets/${id}.mp4`, sha256: hashBytes(bytes) }];
    p.workflowDefinitions = [{ version: 1, id: 'definition', task: 'transform-video', graph: videoGraph, inputs: { sourceVideo: { nodeId: '1', input: 'file' } }, outputs: [{ nodeId: '5', mediaType: 'video/mp4' }], constraints: { sourceVideo: { width: { min: 720 }, height: { min: 720 }, duration: { min: 3, max: 10.05 } } } }];
    p.workflowBindings[0].assetBindings = { sourceVideo: { assetId: id } };
  });
  f.state.schema = videoSchema;
  const backendFactory = selection => ({ ...f.backendFactory(selection), history: async promptId => ({ promptId, requestId: promptId, graph: f.state.submitted.graph, status: { completed: true, status_str: 'success' }, outputs: { '5': { images: [{ filename: 'out.mp4', subfolder: '', type: 'output' }] } } }), view: async () => bytes });
  let probed = false;
  const probeVideo = async (_bytes, info) => { probed = true; assert.equal(info.mime, 'video/mp4'); return { width: 1280, height: 720, fps: 30, frameCount: 120, duration: 4, audio: true, mime: 'video/mp4' }; };
  let generation = await openGeneration(f.root, f.project, { backendFactory });
  const input = f.input(), quoted = await generation.quote(input);
  assert.equal(quoted.validation.compatible, true); assert.equal(quoted.sources.sourceVideo.sha256, hashBytes(bytes));
  await generation.submit({ ...input, approval: approve(quoted) });
  const missingProbe = await generation.track(input.requestId);
  assert.equal(missingProbe.status, 'collecting'); assert.equal(missingProbe.results.length, 0);
  generation = await openGeneration(f.root, f.project, { backendFactory, probeVideo });
  const completed = await generation.track(input.requestId);
  assert.equal(completed.status, 'completed'); assert.equal(probed, true);
  assert.equal(completed.results[0].fps, 30); assert.equal(completed.results[0].duration, 4); assert.equal(completed.sources.sourceVideo.fps, 24);
  assert.equal(completed.results[0].url, '/assets/' + completed.results[0].filename);
  assert.throws(() => validateAssetConstraints({ id: 'x', duration: 2 }, { duration: { min: 3 } }), /No resize, retime/);
  await writeFile(join(f.root, 'assets', id + '.mp4'), Buffer.from('CHANGED'));
  await assert.rejects(generation.quote(f.input()), /hash changed/);
});

test('declared output boundary rejects path traversal and mismatched formats before any view', () => {
  const d = definition();
  for (const filename of ['../out.png', 'dir/out.png', 'out.mp4', '%2e%2e.png']) assert.throws(() => declaredOutputs(d, { '2': { images: [{ filename, subfolder: '', type: 'output' }] } }));
  assert.throws(() => safeMediaLocation({ filename: 'out.png', subfolder: '..', type: 'output' }));
  assert.throws(() => declaredOutputs(d, { '99': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } }));
});

test('Cloud v1 wire contract uses job details, env-only auth and credential-free redirect', async () => {
  const calls = [], key = 'SIMULATED-in-memory-test-credential', promptId = randomUUID(), requestId = randomUUID();
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    if (url.startsWith('https://storage.example.test/')) { assert.equal(init.headers, undefined); return new Response(png); }
    assert.equal(init.headers['X-API-Key'], key);
    const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    if (path === '/api/object_info') return json(schema);
    if (path === '/api/upload/image') { assert.ok(init.body instanceof FormData); assert.equal(init.headers['Content-Type'], undefined); return json({ name: 'contenthash.png', subfolder: '', type: 'input' }); }
    if (path === '/api/prompt') { const body = JSON.parse(init.body); assert.equal(body.prompt_id, undefined); assert.equal(body.extra_data.api_key_comfy_org, key); assert.deepEqual(body.prompt, graph); return json({ prompt_id: promptId }); }
    if (path === '/api/jobs/' + promptId) return json({ id:promptId,status:'completed',workflow: { prompt: graph, extra_data: { previs: { requestId }, api_key_comfy_org: key } }, execution_status: { completed: true }, outputs: {} });
    if (path === '/api/view') { assert.equal(init.redirect, 'manual'); return new Response(null, { status: 302, headers: { Location: 'https://storage.example.test/signed-output' } }); }
    throw Error('Unexpected test endpoint ' + path);
  };
  const backend = createBackend({ kind: 'cloud' }, { fetch, env: { COMFY_CLOUD_API_KEY: key } });
  assert.equal(backend.snapshot.deprecated, true);
  assert.equal((await backend.inspect()).deprecated, true);
  assert.equal((await backend.upload(png, { filename: 'input.png', subfolder: 'previs/test', mime: 'image/png' })).value, 'contenthash.png');
  assert.deepEqual(await backend.submit({ graph, requestId, projectId: 'project', partnerNodes: true }), { promptId });
  const history = await backend.history(promptId);
  assert.equal(history.promptId,promptId);assert.deepEqual(history.graph,graph);assert.deepEqual(history.status,{completed:true,status_str:'success'});
  assert.equal(history.requestId, requestId); assert.ok(!JSON.stringify(history).includes(key));
  assert.deepEqual(await backend.view({ filename: 'out.png', subfolder: '', type: 'output' }), png);
  assert.ok(!JSON.stringify(backend.snapshot).includes(key)); assert.equal(calls.length, 6);
  const absent = createBackend({ kind: 'cloud' }, { fetch: () => { throw Error('must not call'); }, env: {} });
  await assert.rejects(absent.inspect(), /COMFY_CLOUD_API_KEY/);
});

test('Cloud job details distinguish pending, failed, cancelled, absent and inconsistent responses', async () => {
  const id=randomUUID();let response;
  const backend=createBackend({kind:'cloud'},{env:{COMFY_CLOUD_API_KEY:'SIMULATED'},fetch:async()=>new Response(JSON.stringify(response),{status:response?200:404})});
  assert.equal(await backend.history(id),null);
  response={id,status:'pending'};assert.equal(await backend.history(id),null);
  for(const [status,expected]of [['pending','pending'],['in_progress','in_progress'],['failed','error'],['cancelled','cancelled']]){
    response={id,status,workflow:{prompt:graph,extra_data:{previs:{requestId:id}}},outputs:{}};
    assert.deepEqual((await backend.history(id)).status,{completed:false,status_str:expected});
  }
  response.status='completed';response.execution_status={completed:false};assert.equal((await backend.history(id)).status.completed,false);
  response.status='unexpected';await assert.rejects(backend.history(id),/Unknown Cloud job status/);
});

test('lost Cloud acceptance never guesses a prompt ID or resubmits', async () => {
  const f = await fixture(); f.state.ambiguous = true;
  const generation = await openGeneration(f.root, f.project, { backendFactory: f.backendFactory, allowPaid: true });
  const input = { ...f.input(), backend: { kind: 'cloud' } }, quoted = await generation.quote(input), approval = approve(quoted);
  approval.allowance.maxAmount = 5; approval.allowance.allowUnknownCharges = true;
  const uncertain = await generation.submit({ ...input, approval });
  assert.equal(uncertain.status, 'uncertain'); assert.equal(uncertain.promptId, null);
  assert.equal((await generation.track(input.requestId)).status, 'uncertain');
  await generation.submit({ ...input, approval }); assert.equal(f.state.submits, 1);
});

test('declared timing/framing changes require a fresh explicit binding acknowledgment', async () => {
  const f=await fixture();
  await f.project.mutate(f.project.get().revision,p=>{p.workflowDefinitions[0].constraints={timingChange:'73 frames at 24 fps; 832×480'};});
  const generation=await openGeneration(f.root,f.project,{backendFactory:f.backendFactory});
  const before=await generation.quote(f.input());
  assert.equal(before.validation.compatible,false);
  assert.equal(before.validation.issues.at(-1).code,'timing-review');
  await f.project.mutate(f.project.get().revision,p=>{p.workflowBindings[0].acceptTimingChange=true;});
  const after=await generation.quote(f.input());
  assert.equal(after.validation.compatible,true);
  assert.notEqual(after.fingerprint,before.fingerprint);
  assert.equal(f.state.submits,0);
});

test('auto-grow input groups expand to named slots and are optional', async () => {
  const { validateGraph } = await import('../server/previs/workflows.mjs');
  const objectInfo = {
    LoadImage: { input: { required: { image: [['a.png'], { image_upload: true }] } }, output: ['IMAGE'], python_module: 'nodes' },
    Gen: { input: { required: { prompt: ['STRING', {}], model: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'm1', inputs: { required: { images: ['COMFY_AUTOGROW_V3', { template: { input: { required: { image: ['IMAGE', {}] } }, names: ['image_1', 'image_2'], min: 0 } }] } } }] }] } }, output: ['IMAGE'], python_module: 'x' },
  };
  assert.equal(validateGraph({ 1: { class_type: 'Gen', inputs: { prompt: 'p', model: 'm1' } } }, objectInfo).compatible, true, 'an empty auto-grow group is fine');
  const linked = validateGraph({ 0: { class_type: 'LoadImage', inputs: { image: 'a.png' } }, 1: { class_type: 'Gen', inputs: { prompt: 'p', model: 'm1', 'model.images.image_1': ['0', 0] } } }, objectInfo);
  assert.equal(linked.compatible, true, JSON.stringify(linked.issues));
  const bad = validateGraph({ 1: { class_type: 'Gen', inputs: { prompt: 'p', model: 'm1', 'model.images.image_9': 'x' } } }, objectInfo);
  assert.equal(bad.compatible, false, 'unknown slots are still rejected');
});

test('budget: an unpriced Cloud request is refused before any upload; a priced one reserves its rate × seconds and settles', async () => {
  const { openBudget } = await import('../server/previs/budget.mjs');
  const { generationEstimate } = await import('../server/previs/generation.mjs');
  const f = await fixture(), budget = await openBudget(join(f.root, 'budget'), { env: {} });
  const generation = await openGeneration(f.root, f.project, { backendFactory: f.backendFactory, allowPaid: true, budget });
  const cloud = () => ({ ...f.input(), backend: { kind: 'cloud' } });
  const consent = job => ({ ...approve(job), allowance: { currency: 'USD', maxAmount: 5, allowUnknownCharges: true } });
  await f.project.mutate(f.project.get().revision, p => { p.workflowDefinitions[0].pricing = { status: 'unknown' }; });
  const unpriced = cloud(), q1 = await generation.quote(unpriced);
  assert.equal(generationEstimate(q1), null);
  await assert.rejects(generation.submit({ ...unpriced, approval: consent(q1) }), e => e.status === 402 && e.apiCode === 'budget' && /no price estimate/.test(e.message));
  assert.equal(f.state.uploads, 0); assert.equal(f.state.submits, 0);
  assert.equal(generation.get(unpriced.requestId).status, 'quoted'); assert.equal(generation.get(unpriced.requestId).lastAttempt.code, 'budget');
  await f.project.mutate(f.project.get().revision, p => { p.workflowDefinitions[0].pricing = { status: 'estimate', currency: 'USD', ratePerSecond: 0.2 }; p.workflowBindings[0].parameters = {}; });
  const priced = cloud(), q2 = await generation.quote(priced);
  assert.equal(generationEstimate(q2), 1, '0.2/s × the 5 s default');
  await generation.submit({ ...priced, approval: consent(q2) });
  assert.equal(budget.get(priced.requestId).state, 'reserved'); assert.equal(budget.get(priced.requestId).estimateUsd, 1);
  assert.equal(budget.get(priced.requestId).reserveMicros, 1100000, 'the default 10% safety margin is held on top of the list price');
  f.state.visible = true;
  assert.equal((await generation.track(priced.requestId)).status, 'completed');
  assert.equal(budget.get(priced.requestId).state, 'settled'); assert.equal(budget.get(priced.requestId).costMicros, 1000000, 'settled at the list price, the margin released');
  // Local work without partner API nodes never touches the ledger.
  const local = f.input(), q3 = await generation.quote(local);
  await generation.submit({ ...local, approval: approve(q3) });
  assert.equal(budget.get(local.requestId), null);
});
