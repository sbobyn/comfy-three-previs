// MCP parity for look presets (server/previs/agent-look-tools.mjs and the batch `variants` option): the stdio agent lists the
// presets, sets a shot's or the project's look, adds single-axis variants and asks the batch for one quote, against a fake
// Previs server whose edit route applies ops with the real director logic. Nothing is generated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { createProjectDocument, applyOps } from '../server/previs/director.mjs';
import { loadStarters } from '../server/previs/starters.mjs';
import { builtInPresets } from '../server/previs/presets.mjs';

function fake(p) {
  const calls = [];
  const routes = {
    'GET /api/director/project': () => ({ project: p }),
    'POST /api/director/edit': b => { const results = applyOps(p, b.ops); p.revision++; return { project: p, results }; },
    'GET /api/generation': () => ({ presets: builtInPresets, definitions: [], jobs: [] }),
    'POST /api/director/batch': b => ({ batch: { id: '11111111-1111-4111-8111-111111111111', status: 'planned', steps: ['stills', 'videos'], nodes: [], estimateUsd: 2.5, reserveUsd: 2.75, regen: { remake: 6, total: 6, kept: 0, pinned: 0, paid: 6 }, events: [],
      variants: { base: b.variants.shot, preview: true, why: 'Walker walks', list: [{ shotId: 'x', title: 'a · Night (vs base)', label: 'Night (vs base)' }] } } }),
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
  try { await fn(call, rpc); } finally { agent.kill(); f.server.close(); }
}

test('MCP: look presets, set_look (shot and project default), single-axis variants and the batch variants quote', async () => {
  const p = createProjectDocument({ template: 'look-lab' }, undefined, await loadStarters()), base = p.shots[0], f = fake(p);
  await withAgent(f, async (call, rpc) => {
    const names = (await rpc('tools/list', {})).result.tools.map(t => t.name);
    for (const t of ['previs_director_look_presets', 'previs_director_set_look', 'previs_director_add_variants']) assert.ok(names.includes(t), t);
    const batchTool = (await rpc('tools/list', {})).result.tools.find(t => t.name === 'previs_director_batch_generate');
    assert.deepEqual(batchTool.inputSchema.properties.variants.required, ['shot', 'axes']);

    const list = await call('previs_director_look_presets', {});
    assert.deepEqual(list.axes.map(a => a.axis), ['time', 'weather', 'season', 'mood', 'wardrobe', 'style']);
    assert.deepEqual(list.axes.find(a => a.axis === 'style').presets.find(x => x.id === 'anime').suggests, { still: 'nano-banana-2-1', styleRef: false });

    // A shot's look merges per axis; the answer says what it makes out of date (that shot's still, not other shots).
    const set = await call('previs_director_set_look', { projectId: p.id, shot: '1', look: { time: 'night' } });
    assert.equal(set.scope, 'shot'); assert.deepEqual(set.look, { time: 'night' }); assert.equal(set.affects.length, 1);
    assert.equal(set.affects[0].outputs.find(o => o.type === 'still').state, 'stale', JSON.stringify(set.affects));
    const merged = await call('previs_director_set_look', { projectId: p.id, shot: '1', look: { wardrobe: 'raincoat' } });
    assert.deepEqual(merged.look, { time: 'night', wardrobe: 'raincoat' });
    assert.deepEqual((await call('previs_director_set_look', { projectId: p.id, shot: '1', look: null })).look, {});
    assert.match((await call('previs_director_set_look', { projectId: p.id, shot: '1', look: { time: 'midnight' } })).error, /Unknown time preset midnight/);
    // Project default: every shot that inherits it.
    const def = await call('previs_director_set_look', { projectId: p.id, look: { mood: 'soft' } });
    assert.equal(def.scope, 'project'); assert.equal(def.affects.length, p.shots.length); assert.deepEqual(p.look, { mood: 'soft' });
    await call('previs_director_set_look', { projectId: p.id, look: null });

    // Variants: one change each, labelled against the base; the walker's timing suggests Seedance.
    const v = await call('previs_director_add_variants', { projectId: p.id, shot: '1', axes: { time: ['night'], season: ['winter'], style: ['claymation'], subject: [{ objectId: 'Walker', text: 'a tall knight in silver armour' }] } });
    assert.deepEqual(v.added.map(x => x.differs), ['Night (vs base)', 'Winter (vs base)', 'Claymation (vs base)', 'Walker → a tall knight in silver armour (vs base)']);
    assert.equal(v.suggested.video, 'seedance-25-edit-v1'); assert.equal(v.suggested.still, 'nano-banana-2-1');
    assert.deepEqual((await call('previs_director_add_variants', { projectId: p.id, shot: base.id, axes: { time: ['night'] } })).existing.map(x => x.differs), ['Night (vs base)']);
    // The variant's own look view says what differs; a second change on a variant warns.
    const night = p.shots.find(s => s.variantOf === base.id && s.look?.time === 'night');
    const view = await call('previs_director_look_presets', { projectId: p.id, shot: night.id });
    assert.equal(view.look.differs, 'Night (vs base)'); assert.equal(view.look.variantOf.id, base.id);
    const two = await call('previs_director_set_look', { projectId: p.id, shot: night.id, look: { season: 'winter' } });
    assert.equal(two.differs, 'Night + Winter (vs base)'); assert.match(two.warning, /differs from its base on 2 attributes/);

    // batch_generate variants: the agent resolves the base shot and object names, then asks for one quote.
    const q = await call('previs_director_batch_generate', { projectId: p.id, steps: ['stills', 'videos'], maxCostUsd: 10, dryRun: true, variants: { shot: '1', axes: { time: ['dawn'], subject: [{ objectId: 'Walker', text: 'a robot' }] } } });
    const sent = f.calls.findLast(c => c.path === '/api/director/batch').body;
    assert.equal(sent.variants.shot, base.id); assert.equal(sent.variants.axes.subject[0].entityId, p.scene.entities.find(e => e.name === 'Walker').id);
    assert.deepEqual(q.variants.shots, [{ shot: 'a · Night (vs base)', differs: 'Night (vs base)' }]); assert.equal(q.estimateUsd, 2.5);
  });
});
