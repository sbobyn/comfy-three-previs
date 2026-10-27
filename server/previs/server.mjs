import { startPhoneLan } from './phone-lan.mjs';
import { attachRelay } from '../../dist-server/relay.js';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
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

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const data = resolve(process.env.PREVIS_DATA_DIR || join(root, '.previs'));
await mkdir(data, { recursive: true });
const releaseLock = await lockProject(data);
const project = await openProject(data);
const blender = new BlenderMcp();
const operations = await openOperations(data);
const comfy = await openComfy(data, project);
const generation = await generationRoutes(data,project);
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
const port = Number(process.env.PORT || 5190);
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
    if (req.method === 'GET' && url.pathname === '/api/phone') return send(phoneLan.readiness());
    if (req.method === 'GET' && url.pathname === '/api/generation') return send(generation.state());
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
      const result = await serial(async () => {
        if (url.pathname === '/api/phone/pair') return phoneLan.pair();
        if (url.pathname === '/api/phone/revoke') { phoneLan.revoke(); return {revoked:true}; }
        if (url.pathname.startsWith('/api/generation/')) return generation.route(url.pathname,input);
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
          const binding = { source: 'three', scene: 'Camera study', camera: 'Operated camera', fps: 24, start: 0, end: Math.max(0, Math.floor((browser.frames.at(-1)?.t || 0) * 24 + 1e-8)), frame: 0 };
          p.shots.push({ id, title: String(input.title || 'Camera study').slice(0, 160), createdRevision: p.revision + 1, binding, browser, renders: [image.id] });
          p.renders.push({ id: image.id, shotId: id, source: 'three', pass: 'beauty', width: image.width, height: image.height, binding, createdAt: new Date().toISOString() });
          if (!p.scenes.some(s => s.owner === 'three')) p.scenes.push({ id: randomUUID(), owner: 'three', name: 'Camera study', version: 1 });
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
    else if (/^\/assets\/[a-f0-9-]{36}\.(mp4|webm|mov|mkv|png)$/.test(url.pathname)) file = join(data,url.pathname);
    else {
      const path = url.pathname === '/' ? '/previs.html' : url.pathname;
      file = resolve(root, 'dist', '.' + decodeURIComponent(path));
      if (!file.startsWith(join(root, 'dist') + '/')) fail('Invalid path', 403);
    }
    const bytes = await readFile(file);
    const media = ['.mp4','.webm','.mov','.mkv'].includes(extname(file));
    const range = media && req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0, end = range ? Math.min(bytes.length-1, range[2] ? Number(range[2]) : bytes.length-1) : bytes.length-1;
    if (range && (start > end || start >= bytes.length)) { res.writeHead(416,{'Content-Range':`bytes */${bytes.length}`}); return res.end(); }
    res.writeHead(range ? 206 : 200, { ...(media ? {'Accept-Ranges':'bytes','Content-Length':end-start+1,...(range ? {'Content-Range':`bytes ${start}-${end}/${bytes.length}`} : {})} : {}), 'Content-Type': ({ '.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.mkv':'video/x-matroska', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' })[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(range ? bytes.subarray(start,end+1) : bytes);
  } catch (e) { send({ error: e.code === 'ENOENT' ? 'File not found; run pnpm build first.' : e.message }, e.status || (e.code === 'ENOENT' ? 404 : 400)); }
});
const relay = attachRelay(server);
const phoneLan = await startPhoneLan({root,relay});
server.listen(port, '127.0.0.1', () => console.log(`Comfy Previs: http://127.0.0.1:${port}`));
async function stop() { phoneLan.close();relay.close();blender.close(); server.close(); await releaseLock(); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
