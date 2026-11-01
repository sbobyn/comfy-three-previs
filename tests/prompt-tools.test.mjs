// MCP parity for prompt transparency (server/previs/agent-prompt-tools.mjs): the stdio agent reads the assembled prompt by
// section, sets overrides and locks, diffs versions and saves model settings, against a fake Previs server whose edit route
// applies ops with the real director logic. Nothing is generated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { createProjectDocument, applyOps } from '../server/previs/director.mjs';
import { loadStarters } from '../server/previs/starters.mjs';
import { builtInPresets } from '../server/previs/presets.mjs';
import { videoPromptPlan } from '../shared/prompt-plan.mjs';
import { videoReferences } from '../shared/director.mjs';
import { CAMERA_LINES } from '../shared/camera-source.mjs';
import { frameCount, frameTime } from '../shared/keyframes.mjs';

function fake(p) {
  const calls = [];
  const routes = {
    'GET /api/director/project': () => ({ project: p }),
    'POST /api/director/edit': b => { const results = applyOps(p, b.ops); p.revision++; return { project: p, results }; },
    'GET /api/generation': () => ({ presets: builtInPresets, definitions: [], jobs: [] }),
    'GET /api/director/refgen': () => ({ presets: [{ id: 'flux-3', title: 'FLUX 3 Image (BFL)', maxRefs: 9, pricing: { usdPerImage: 0.066 } }, { id: 'flux-2-pro', title: 'Flux.2 [pro] (BFL)', maxRefs: 7, pricing: { usdPerImage: 0.028 } }] }),
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'); let text = ''; for await (const c of req) text += c;
    const body = text ? JSON.parse(text) : {}; calls.push({ method: req.method, path: url.pathname, body });
    const fn = routes[`${req.method} ${url.pathname}`]; let status = 200, json;
    try { json = fn ? fn(body) : (status = 404, { error: 'not found' }); } catch (e) { status = 400; json = { error: e.message }; }
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json));
  });
  return { server, calls, listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))) };
}
async function withAgent(f, fn) {
  const base = await f.listen();
  const agent = spawn(process.execPath, ['server/previs/agent.mjs'], { env: { ...process.env, PREVIS_MCP_LEGACY: '', PREVIS_URL: base }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map(); let n = 0;
  createInterface({ input: agent.stdout }).on('line', l => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
  const rpc = (method, params) => new Promise(r => { const id = ++n; pending.set(id, r); agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args) => { const m = await rpc('tools/call', { name, arguments: args }); return { error: m.result.isError ? m.result.content[0].text : null, ...(m.result.isError ? {} : JSON.parse(m.result.content[0].text)) }; };
  try { await fn(call); } finally { agent.kill(); f.server.close(); }
}

test('MCP: prompt by section equals what generation binds; overrides, locks, history and model settings round-trip', async () => {
  const starters = await loadStarters(), p = createProjectDocument({ template: 'final-lap' }, undefined, starters), s = p.shots[0];
  const f = fake(p);
  await withAgent(f, async call => {
    // Read: the shot's saved model (seedance edit) and the exact text the shared assembly produces.
    await call('previs_director_model_settings', { projectId: p.id, shot: '1', kind: 'video', model: 'seedance-25-edit-v1' });
    let r = await call('previs_director_prompt_sections', { projectId: p.id, shot: '1', kind: 'video' });
    assert.equal(r.error, null); assert.equal(r.model, 'seedance-25-edit-v1'); assert.equal(r.cameraSource, 'blockout');
    const d = builtInPresets.find(x => x.id === 'seedance-25-edit-v1');
    assert.equal(r.final, videoPromptPlan(p, s, { cameraSource: 'blockout', refs: videoReferences(p, s, 7, { stills: true }), maxLength: d.constraints.promptMaxLength }).text, 'MCP reads the bytes generation sends');
    assert.equal(r.sections.find(x => x.key === 'camera').policy, 'system');
    assert.ok(r.sections.some(x => x.status === 'omitted'), 'what the budget leaves out is listed');

    // The camera rule is not editable; a camera-directing override is saved but flagged.
    r = await call('previs_director_set_prompt_section', { projectId: p.id, shot: '1', kind: 'video', section: 'camera', mode: 'override', text: 'Dolly in.' });
    assert.match(r.error, /system rule/);
    r = await call('previs_director_set_prompt_section', { projectId: p.id, shot: '1', kind: 'video', section: 'action', mode: 'override', text: 'The Comfy car crosses the line first; crane up over the crowd.' });
    assert.equal(r.ok, true); assert.deepEqual(r.cameraWords, ['crane up']); assert.match(r.final, /^The Comfy car crosses the line first/);
    assert.equal(s.promptSections.video.action.mode, 'override');
    assert.equal(r.final.split(CAMERA_LINES.blockout).length - 1, 1, 'the camera line stays');

    // Lock, then a locked section refuses edits until unlocked.
    r = await call('previs_director_set_prompt_section', { projectId: p.id, shot: '1', kind: 'video', section: 'action', mode: 'lock' });
    assert.equal(r.policy, 'lock'); assert.equal(s.promptSections.video.action.text, 'The Comfy car crosses the line first; crane up over the crowd.');
    r = await call('previs_director_set_prompt_section', { projectId: p.id, shot: '1', kind: 'video', section: 'action', mode: 'override', text: 'Something else.' });
    assert.match(r.error, /locked/);
    r = await call('previs_director_set_prompt_section', { projectId: p.id, shot: '1', kind: 'video', section: 'action', mode: 'inherit' });
    assert.equal(r.ok, true); assert.equal(s.promptSections, undefined);

    // History: each change saved a version (by Claude); diff a version against the current prompt.
    r = await call('previs_director_prompt_history', { projectId: p.id, shot: '1', kind: 'video' });
    // Locking kept the same final text, so it adds no version (versions are distinct final prompts).
    assert.deepEqual(r.versions.map(v => v.reason), ['edit', 'unlock']); assert.ok(r.versions.every(v => v.by === 'claude'));
    r = await call('previs_director_prompt_history', { projectId: p.id, shot: '1', kind: 'video', from: r.versions[0].id });
    assert.ok(r.diff.removed > 0 && r.diff.parts.some(x => x.op === 'del' && /crane up/.test(x.text)));

    // Model settings: registry parameters, a saved seed and clip length, the estimate for them.
    r = await call('previs_director_model_settings', { projectId: p.id, shot: '1', kind: 'video', model: 'veo-31-flf-v1', params: { seed: 11, duration: 8 } });
    assert.equal(r.model, 'veo-31-flf-v1'); assert.equal(r.seconds, 8); assert.equal(r.estimateUsd, 1.6);
    assert.deepEqual(r.params.find(x => x.key === 'duration').options, [4, 6, 8]); assert.equal(r.params.find(x => x.key === 'resolution').editable, false);
    assert.deepEqual(s.settings.video, { model: 'veo-31-flf-v1', params: { seed: 11, duration: 8 } });
    r = await call('previs_director_prompt_sections', { projectId: p.id, shot: '1', kind: 'video' });
    assert.equal(r.cameraSource, 'keyframes', 'the saved model sets the camera rule');
    r = await call('previs_director_model_settings', { projectId: p.id, shot: '1', kind: 'image', model: 'flux-2-pro', params: { count: 2, seed: 3 } });
    assert.equal(r.model, 'flux-2-pro'); assert.equal(r.estimate.listUsd, 0.056);
    r = await call('previs_director_prompt_sections', { projectId: p.id, shot: '1', kind: 'image', at: 'end' });
    assert.equal(r.model, 'flux-2-pro'); assert.equal(r.at, frameTime(frameCount(p, s) - 1), 'the last encoded frame, as generate_still sends it'); assert.deepEqual(r.sections.filter(x => x.policy === 'system').map(x => x.key), ['guide', 'frame', 'moment', 'camera', 'refs', 'rules'].filter(k => r.sections.some(x => x.key === k)));
    r = await call('previs_director_model_settings', { projectId: p.id, shot: '1', kind: 'video', reset: true });
    assert.equal(s.settings.video, undefined);
  });
  assert.equal(f.calls.filter(c => /generation\/(bind|quote|submit)|refgen\/(prepare|submit)/.test(c.path)).length, 0, 'nothing is bound, quoted or sent');
});
