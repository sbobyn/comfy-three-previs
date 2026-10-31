import { startPhoneLan } from './phone-lan.mjs';
import { attachRelay } from '../../dist-server/relay.js';
import { createServer } from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlenderMcp } from './mcp-client.mjs';
import { inspectCode, renderCode, catalogToken } from './blender.mjs';
import { openProject, validateBinding, validateBrowser, sameBinding } from './store.mjs';
import { randomUUID } from 'node:crypto';
import { openOperations } from './operations.mjs';
import { lockProject } from './lock.mjs';
import { openComfy, validateWorkflow } from './comfy.mjs';
import { cameraTransfer, transferCode, verifyTransfer } from './transfer.mjs';
import { releaseFrameStage } from './video.mjs';
import { videoRoutes } from './video-routes.mjs';
import { generationRoutes } from './generation-routes.mjs';
import { openDirector, directorRoutes } from './director.mjs';
import { openAgentRunner } from './agent-runner.mjs'; // [agent]
import { openRefgen, refgenRoutes } from './refgen.mjs';
import { setupChecks } from './setup-check.mjs';
import { openHeadless } from './headless.mjs'; // [headless]
import { renderRoutes } from './render-routes.mjs'; // [headless]
import { frameRoutes } from './frames.mjs'; // [frames]
import { openBatches } from './batch.mjs'; import { batchRoutes } from './batch-routes.mjs'; import { fakeBackend, loopbackDrivers, loopbackJobs } from './batch-drivers.mjs'; // [batch]
import { createJobTracker } from './job-tracker.mjs';
import { slotsFor } from './concurrency.mjs';
import { WebSocket } from 'ws';
import { createJobProgress, createProgressSocketFactory } from './job-progress.mjs'; // [live-progress]
import { createJobProgressRoutes } from './job-progress-routes.mjs';
import { createProgressCoordinator } from './job-progress-coordinator.mjs';
import { keyedLock } from './keyed-lock.mjs';
import { openBudget, budgetDir, refusalFields } from './budget.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const data = resolve(process.env.PREVIS_DATA_DIR || join(root, '.previs'));
await mkdir(data, { recursive: true });
const releaseLock = await lockProject(data);
const project = await openProject(data);
const blender = new BlenderMcp();
const operations = await openOperations(data);
const comfy = await openComfy(data, project);
// One budget authority for every paid dispatch in this server (and any other server sharing PREVIS_BUDGET_DIR).
let progress;
const budget = await openBudget(budgetDir(data), { onChange: ({ alerts }) => { for (const a of alerts) console.log(`[budget] ${a.message}`); progress?.publishBudget(); } });
// [live-progress] Ephemeral observer; stores get nonthrowing hooks, the tracker stays the only authority.
let tracker; const jobSources = {};
const observe = createJobProgress({ connect: createProgressSocketFactory({ WebSocket }), trackNow: (source, id) => tracker?.trackNow(source, id) });
progress = createProgressCoordinator({ observe, sources: jobSources, budget });
const generation = await generationRoutes(data,project,{ telemetry: progress.telemetry('generation'), budget, log: console.log });
let refgen, agentRunner; // [agent]
const director = await openDirector(data, { startersDir: process.env.PREVIS_STARTERS_DIR || undefined, engineJobs: () => generation.state().jobs, onImported: id => refgen?.load(id), runner: () => agentRunner });
refgen = await openRefgen(data, director, { telemetry: progress.telemetry('refgen'), budget, log: console.log });
jobSources.generation = generation.trackerSource({ director }); jobSources.refgen = refgen.trackerSource();
tracker = createJobTracker({ sources: [jobSources.generation, jobSources.refgen], limits: () => slotsFor(data).snapshot(), log: line => console.log(`[jobs] ${line}`) });
generation.useTracker(tracker); refgen.useTracker(tracker); tracker.start();
progress.restore(); progress.start(tracker); // [live-progress] observe accepted receipts; reconcile from C1
// Same policy as every route (loopback host/origin, checked before this runs) plus an existing director project.
const projectExists = async id => { try { await director.get(id); return true; } catch { return false; } };
const progressRoutes = createJobProgressRoutes({ observe, resolveProject: async (_req, id) => (await projectExists(id)) ? progress.scope(id) : null });
const refgenRoute = refgenRoutes(refgen);
const directorRoute = directorRoutes(director, project, () => ({ command: process.execPath, args: [join(root, 'server/previs/agent.mjs')], env: { PREVIS_URL: `http://127.0.0.1:${port}` } }), () => agentRunner);
const videos = videoRoutes({data,project,blender,operations,refreshBlender});
let connectionError = null;
async function refreshBlender() {
  operations.assertIdle();
  try {
    const serverInfo = await blender.connect();
    const result = await blender.execute(inspectCode, { mutation: false });
    catalog = { ...result, token: catalogToken(result), inspectedAt: new Date().toISOString() };
    connectionError = null; return { catalog, serverInfo };
  } catch (error) { catalog = null; connectionError = error.message; throw error; }
}
function blenderReadiness() { return { configured: Boolean(process.env.PREVIS_BLENDER_MCP_COMMAND), process: blender.serverInfo || null, addon: catalog ? 'inspected' : 'not-inspected', error: connectionError, operation: operations.get(), ownership: 'Blender owns its source file; Previs stores shot bindings and previews.' }; }
let catalog = null;
let operation = Promise.resolve();
const serial = fn => { const next = operation.then(fn); operation = next.catch(() => {}); return next; };
// Routes of the retired Blender/workbench pages: Blender MCP, camera transfer, raw Comfy passthrough, handoff and
// Blender previews. Nothing in the director uses them; they answer only when PREVIS_LEGACY_ROUTES=1.
const legacyRoutes = process.env.PREVIS_LEGACY_ROUTES === '1';
const LEGACY_ROUTE = /^\/api\/(transfer|handoff|render|shots|readiness|comfy\/[a-z]+|blender\/[a-z]+|video\/blender)$/;
// Video capture runs on its own queue, one chain per frame stage (a 120-frame capture never waits behind
// generation or another capture). Blender video stays on the global queue with every other Blender call.
const videoLock = keyedLock();
const port = Number(process.env.PORT || 5190);
agentRunner = await openAgentRunner({ root, dataDir: data, port, director }); // [agent] built-in Claude Code runner
const headless = openHeadless({ port }), renderRoute = renderRoutes({ director, headless }); // [headless] C2 render routes
const frameRoute = frameRoutes({ director, headless }); // [frames] A6 video/still frames and contact sheets for agents
const batches = await openBatches(data, { ...(process.env.PREVIS_BATCH_FAKE === '1' ? fakeBackend({ log: console.log }) : { drivers: loopbackDrivers(`http://127.0.0.1:${port}`), jobs: loopbackJobs(`http://127.0.0.1:${port}`) }), loadProject: id => director.get(id), costs: () => ({ marginPct: budget.marginPct(), graderOn: refgen.graderOn() }), log: console.log }), batchRoute = batchRoutes(batches); // [batch]
function fail(message, status = 400) { const e = Error(message); e.status = status; throw e; }
async function body(req) {
  let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 16 * 1024 * 1024) fail('Request too large', 413); }
  return JSON.parse(text || '{}');
}
const server = createServer(async (req, res) => {
  const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  try {
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) fail('Loopback host required', 403);
    if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) fail('Cross-origin request refused', 403);
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (!legacyRoutes && LEGACY_ROUTE.test(url.pathname)) fail('Retired route (Blender/workbench pages); start Previs with PREVIS_LEGACY_ROUTES=1 to use it', 404);
    if (await progressRoutes.handle(req, res)) return; // [live-progress] GET /api/jobs/stream, /api/jobs/{source}/{id}/preview
    if (req.method === 'GET' && url.pathname === '/api/director/agent/stream') { const id = url.searchParams.get('id') || ''; if (!/^[a-f0-9-]{36}$/.test(id)) fail('Unknown project', 404); return agentRunner.stream(req, res, id); } // [agent] live steps + reply text (SSE)
    if (req.method === 'GET' && url.pathname === '/api/director/setup') return send({ ...(await setupChecks({ root, data })), agent: director.agentStatus(), dataDir: data });
    if (req.method === 'GET' && url.pathname === '/api/director/export') {
      const { filename, data: zip } = await director.exportZip(url.searchParams.get('id'));
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(zip);
    }
    if (req.method === 'POST' && url.pathname === '/api/director/import') {
      if (!/^application\/(zip|octet-stream)/.test(req.headers['content-type'] || '')) fail('Upload a .previs.zip export', 415);
      const parts = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1024 ** 3) fail('Export is larger than 1 GB', 413); parts.push(chunk); }
      return send(await director.importZip(Buffer.concat(parts)));
    }
    if (renderRoute.handles(url.pathname)) return await renderRoute.serve(req, url, send, body); // [headless]
    if (req.method === 'GET' && url.pathname === '/api/director/asset-frame') { try { return send(await frameRoute(url)); } catch (e) { if (e.apiCode) return send({ error: e.message, code: e.apiCode }, e.status); throw e; } } // [frames]
    if (req.method === 'GET' && url.pathname === '/api/director/batch/stream') { const id = url.searchParams.get('id') || ''; if (!/^[a-f0-9-]{36}$/.test(id)) fail('Unknown batch', 404); return batches.stream(req, res, id); } // [batch]
    if (/^\/api\/director\/batch(es|\/|$)/.test(url.pathname)) { if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) fail('JSON required', 415); return send(await batchRoute(req.method, url, req.method === 'POST' ? await body(req) : {})); } // [batch]
    if (url.pathname.startsWith('/api/director/')) {
      if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) fail('JSON required', 415);
      if (!['GET', 'POST'].includes(req.method)) fail('Method not allowed', 405);
      // Director edits serialize on their own queue so agent long-polls never block Blender or video work.
      const input = req.method === 'POST' ? await body(req) : {};
      return send((url.pathname.startsWith('/api/director/refgen') ? await refgenRoute(req.method, url, input) : undefined) ?? await directorRoute(req.method, url, input, { agent: req.headers['x-previs-agent'] === '1' }));
    }
    if (req.method === 'GET' && url.pathname === '/api/phone') return send(phoneLan.readiness());
    if (req.method === 'GET' && url.pathname === '/api/generation') return send(generation.state());
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      await budget.refresh().catch(() => {}); // another server may share the ledger
      const id = url.searchParams.get('projectId'), snap = tracker.snapshot(); if (id === null) return send({ ...snap, budget: budget.status(null) });
      if (!(await projectExists(id))) fail('Unknown project', 404);
      return send({ ...snap, jobs: snap.jobs.filter(job => job.projectId === id), budget: budget.status(id) });
    }
    // Budget: status (account + optional project), reservations, caps, and releasing a hold after checking the bill.
    if (req.method === 'GET' && url.pathname === '/api/budget') {
      await budget.refresh();
      const id = url.searchParams.get('projectId') || null;
      return send({ ...budget.status(id), reservations: budget.list().filter(r => !id || r.projectId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200) });
    }
    if (req.method === 'POST' && (url.pathname === '/api/budget/caps' || url.pathname === '/api/budget/release')) {
      if (!req.headers['content-type']?.startsWith('application/json')) fail('JSON required', 415);
      const input = await body(req);
      if (url.pathname === '/api/budget/caps') return send(await budget.setCaps(input));
      const r = budget.get(String(input.id || '')); if (!r) fail('Unknown reservation', 404);
      await budget.release(r.id, String(input.note || 'Released by the operator after checking the bill').slice(0, 200));
      return send(budget.status(r.projectId));
    }
    if (req.method === 'GET' && url.pathname === '/api/project') return send({ project: project.get(), catalog, blender: blenderReadiness(), comfyJobs: comfy.list() });
    if (req.method === 'GET' && url.pathname === '/api/readiness') return send({ blender: blenderReadiness(), comfy: comfy.readiness(), browser: { available: true, scope: 'Editable camera-study set' } });
    if (req.method === 'GET' && url.pathname === '/api/comfy/jobs') return send({ jobs: comfy.list() });
    if (req.method === 'GET' && url.pathname === '/api/handoff') {
      const p = project.get(), shot = p.shots.find(s => s.id === url.searchParams.get('shot'));
      if (!shot) fail('Shot not found', 404);
      if ((url.searchParams.get('pass') || 'beauty') !== 'beauty') fail('Only beauty is supported. Depth/pose/other guides are unavailable; no beauty substitution.');
      const images = p.renders.filter(r => r.shotId === shot.id && r.pass === 'beauty' && sameBinding(r.binding, shot.binding)).map(r => ({ id: r.id, pass: r.pass, width: r.width, height: r.height, url: `/renders/${r.id}.png`, source: r.source, binding: r.binding, requestRevision: r.requestRevision }));
      if (!images.length) fail('Render a preview for the current binding before exporting a handoff. Historical images retain their original camera and timing.');
      return send({ version: 1, kind: 'previs-explicit-assets', projectId: p.id, shotId: shot.id, timing: shot.binding, images, workflowBinding: null, execution: 'not-submitted', limitation: 'Beauty stills only. A compatible image-input workflow must be selected separately. No depth, pose, video, or automatic scene transfer.' });
    }
    if (req.method === 'POST'  && url.pathname.startsWith('/api/')) {
      if (!req.headers['content-type']?.startsWith('application/json')) fail('JSON required', 415);
      const input = await body(req);
      // Generation serializes per request id inside the engine; it never waits on this queue.
      if (url.pathname.startsWith('/api/generation/')) return send(await generation.route(url.pathname, input));
      if (url.pathname.startsWith('/api/video/') && url.pathname !== '/api/video/blender') return send(await videoLock(`stage:${typeof input.stageId === 'string' ? input.stageId : ''}`, () => videos(url.pathname, input)));
      const result = await serial(async () => {
        if (url.pathname === '/api/phone/pair') return phoneLan.pair();
        if (url.pathname === '/api/phone/revoke') { phoneLan.revoke(); return {revoked:true}; }
        if (url.pathname.startsWith('/api/video/')) return videos(url.pathname,input);
        if (url.pathname === '/api/transfer') {
          if (!/^[a-f0-9-]{36}$/.test(input.requestId || '') || input.disposableProject !== true) fail('Confirm a disposable Blender project and provide a transfer request UUID');
          const existing = project.get().transfers?.find(t => t.id === input.requestId);
          if (existing) { if (existing.sourceShotId !== input.shotId) fail('Transfer request belongs to another shot', 409); return { project: project.get(), transfer: existing }; }
          let operationId = null, transferred = null;
          try {
            const saved = await project.mutate(input.revision, async p => {
              const shot = p.shots.find(s => s.id === input.shotId);
              const payload = cameraTransfer(shot);
              await refreshBlender();
              if (!catalog.file || input.catalogToken !== catalog.token) fail('Refresh the saved disposable Blender project before transfer', 409);
              const identity = { file: catalog.file, shotId: shot.id, revision: p.revision, requestId: input.requestId };
              operationId = await operations.begin('transfer-camera', identity);
              transferred = await blender.execute(transferCode(payload, identity));
              const verification = verifyTransfer(payload, transferred);
              const targetShotId = randomUUID();
              const binding = { source: 'blender', file: catalog.file, scene: transferred.scene, camera: transferred.camera, fps: 24, start: 1, end: payload.end, frame: 1 };
              const transfer = { id: input.requestId, sourceShotId: shot.id, targetShotId, requestRevision: p.revision, binding, manifest: payload, verification, targetChecks: transferred.checks, fileSaved: false, createdAt: new Date().toISOString() };
              (p.transfers ||= []).push(transfer);
              p.scenes.push({ id: randomUUID(), owner: 'blender', file: catalog.file, name: binding.scene, transferredFrom: shot.id });
              p.shots.push({ id: targetShotId, title: shot.title + ' · transferred camera', binding, renders: [], transferId: transfer.id, limitation: 'Camera only. Add geometry in Blender before rendering. Save the disposable Blender project yourself to persist the new scene.' });
            });
            await operations.finish(operationId, 'completed', { scene: transferred.scene, savedRevision: saved.revision });
            return { project: saved, transfer: saved.transfers.find(t => t.id === input.requestId) };
          } catch (error) {
            if (operationId && operations.get()?.status === 'running') await operations.finish(operationId, blender.uncertain ? 'uncertain' : 'failed', { reason: error.message, retainedScene: transferred?.scene });
            throw error;
          }
        }
        if (url.pathname === '/api/comfy/inspect') return { readiness: await comfy.inspect() };
        if (url.pathname === '/api/comfy/bind') return { project: await project.mutate(input.revision, async p => {
          const render = p.renders.find(r => r.id === input.renderId);
          if (!render?.binding) fail('Choose a saved render with provenance');
          const workflow = validateWorkflow(input.graph, input.imageNodeId, input.outputNodeIds);
          p.workflowBindings.push({ id: randomUUID(), title: String(input.title || 'Local passthrough').slice(0, 160), renderId: render.id, shotId: render.shotId, sourceBinding: render.binding, ...workflow, createdAt: new Date().toISOString() });
        }) };
        if (url.pathname === '/api/comfy/submit') return { job: await comfy.submit(input), project: project.get() };
        if (url.pathname === '/api/comfy/track') return { job: await comfy.track(input.jobId), project: project.get() };
        if (url.pathname === '/api/comfy/reconcile') return { job: await comfy.reconcile(input), project: project.get() };
        if (url.pathname === '/api/blender/refresh') return refreshBlender();
        if (url.pathname === '/api/blender/reconcile') { const operation = await operations.reconcile(input); blender.reconcile(); if(operation.kind==='render-video'&&operation.details?.stage?.directory)releaseFrameStage(operation.details.stage.directory); catalog = null; return { operation }; }
        if (url.pathname === '/api/shots') return { project: await project.mutate(input.revision, async p => {
          if (!input.catalogToken) fail('Refresh Blender and use the displayed catalog token', 409);
          await refreshBlender();
          if (input.catalogToken !== catalog.token) fail('Blender source changed since inspection. Refresh and choose the binding again.', 409);
          const title = String(input.title || 'Untitled shot').trim().slice(0, 160);
          const binding = validateBinding(input.binding, catalog);
          const shot = input.shotId ? p.shots.find(s => s.id === input.shotId && s.binding.source === 'blender') : null;
          if (input.shotId && !shot) fail('Blender shot not found');
          if (shot) { shot.title = title; shot.binding = binding; }
          else p.shots.push({ id: randomUUID(), title, binding, renders: [] });
          if (!p.scenes.some(s => s.file === binding.file && s.name === binding.scene)) p.scenes.push({ id: randomUUID(), owner: 'blender', file: binding.file, name: binding.scene });
        }) };
        if (url.pathname === '/api/browser-shot') return { project: await project.mutate(input.revision, async p => {
          const browser = validateBrowser(input);
          const image = await project.image(Buffer.from(String(input.png), 'base64'));
          const id = randomUUID();
          const binding = { source: 'three', scene: browser.director ? String(browser.director.sceneName || 'Director scene').slice(0, 120) : 'Camera study', camera: browser.director ? 'Director camera' : 'Operated camera', fps: 24, start: 0, end: Math.max(0, Math.floor((browser.frames.at(-1)?.t || 0) * 24 + 1e-8)), frame: 0 };
          p.shots.push({ id, title: String(input.title || 'Camera study').slice(0, 160), createdRevision: p.revision + 1, binding, browser, renders: [image.id] });
          p.renders.push({ id: image.id, shotId: id, source: 'three', pass: 'beauty', width: image.width, height: image.height, binding, createdAt: new Date().toISOString() });
          if (!browser.director && !p.scenes.some(s => s.owner === 'three')) p.scenes.push({ id: randomUUID(), owner: 'three', name: 'Camera study', version: 1 });
        }) };
        if (url.pathname === '/api/render') {
          let operationId = null, renderId = null;
          try {
            const saved = await project.mutate(input.revision, async p => {
              const shot = p.shots.find(s => s.id === input.shotId); if (!shot) fail('Shot not found');
              if (shot.binding.source !== 'blender') fail('Open this shot in the browser camera studio to capture it');
              await refreshBlender();
              if (catalog.file !== shot.binding.file) fail('Blender file changed. Reopen the bound file or rebind this shot.');
              operationId = await operations.begin('render-preview', { shotId: shot.id, requestRevision: input.revision, binding: shot.binding });
              const result = await blender.execute(renderCode(shot.binding));
              if (result.ok !== true) fail(result.error || 'Blender refused the preview');
              const image = await project.image(Buffer.from(result.png, 'base64')); renderId = image.id;
              p.renders.push({ ...image, shotId: shot.id, source: 'blender', pass: 'beauty', binding: structuredClone(shot.binding), requestRevision: input.revision, createdAt: new Date().toISOString() });
              shot.renders.push(image.id);
            });
            await operations.finish(operationId, 'completed', { renderId, savedRevision: saved.revision });
            return { project: saved };
          } catch (error) {
            if (operationId && operations.get()?.status === 'running') await operations.finish(operationId, blender.uncertain ? 'uncertain' : 'failed', { reason: error.message, renderId });
            throw error;
          }
        }
        fail('Unknown operation', 404);
      });
      return send(result);
    }
    if (req.method !== 'GET') fail('Method not allowed', 405);
    let file;
    if (/^\/renders\/[a-f0-9-]{36}\.png$/.test(url.pathname)) file = join(data, url.pathname);
    else if (/^\/director-assets\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(mp4|webm|mov|png)$/.test(url.pathname)) { const [, , pid, name] = url.pathname.split('/'); file = await director.assetFile(pid, name); }
    else if (/^\/director-refs\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(png|jpg|webp)$/.test(url.pathname)) { const [, , pid, name] = url.pathname.split('/'); file = await director.refFile(pid, name); }
    else if (/^\/assets\/[a-f0-9-]{36}\.(mp4|webm|mov|mkv|png)$/.test(url.pathname)) file = join(data,url.pathname);
    else {
      const path = url.pathname === '/' ? '/start.html' : url.pathname;
      file = resolve(root, 'dist', '.' + decodeURIComponent(path));
      if (!file.startsWith(join(root, 'dist') + '/')) fail('Invalid path', 403);
    }
    const media = ['.mp4','.webm','.mov','.mkv'].includes(extname(file));
    const headers = { 'Content-Type': ({ '.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.mkv':'video/x-matroska', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (!media) { const bytes = await readFile(file); res.writeHead(200, headers); return res.end(bytes); }
    // Media: stream only the requested range (scrubbing a 40 MB film no longer reads 40 MB per request).
    const { size } = await stat(file);
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0, end = range ? Math.min(size-1, range[2] ? Number(range[2]) : size-1) : size-1;
    if (range && (start > end || start >= size)) { res.writeHead(416,{'Content-Range':`bytes */${size}`}); return res.end(); }
    res.writeHead(range ? 206 : 200, { 'Accept-Ranges':'bytes','Content-Length':Math.max(0, end-start+1),...(range ? {'Content-Range':`bytes ${start}-${end}/${size}`} : {}), ...headers });
    if (!size) return res.end();
    const stream = createReadStream(file, { start, end }); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
  } catch (e) { send({ error: e.code === 'ENOENT' ? 'File not found; run pnpm build first.' : e.message, ...(e.apiCode ? { code: e.apiCode, retryAfterSeconds: e.retryAfterSeconds } : {}), ...refusalFields(e) }, e.status || (e.code === 'ENOENT' ? 404 : 400)); }
});
const relay = attachRelay(server);
const phoneLan = await startPhoneLan({root,relay});
server.listen(port, '127.0.0.1', () => { console.log(`Comfy Previs: http://127.0.0.1:${port}`); batches.start(); });
async function stop() { progressRoutes.stop(); progress.stop(); tracker.stop(); batches.close(); agentRunner.close(); phoneLan.close();relay.close();blender.close(); server.close(); await headless.close(); await releaseLock(); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
