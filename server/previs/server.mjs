import { attachRelay } from '../../dist-server/relay.js';
import { createServer } from 'node:http';
import { readFile, open, unlink, mkdir } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlenderMcp } from './mcp-client.mjs';
import { inspectCode, renderCode } from './blender.mjs';
import { openProject, validateBinding, validateBrowser } from './store.mjs';
import { randomUUID } from 'node:crypto';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const data = resolve(process.env.PREVIS_DATA_DIR || join(root, '.previs'));
await mkdir(data, { recursive: true });
const lockPath = join(data, '.server-lock');
const lock = await open(lockPath, 'wx').catch(() => { throw Error('This project is already open, or its prior server exited unexpectedly. Use another PREVIS_DATA_DIR; recover a stale lock only after verifying no server owns it.'); });
await lock.writeFile(String(process.pid));
const project = await openProject(data);
const blender = new BlenderMcp();
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
    if (req.method === 'GET' && url.pathname === '/api/project') return send({ project: project.get(), catalog });
    if (req.method === 'GET' && url.pathname === '/api/handoff') {
      const p = project.get(), shot = p.shots.find(s => s.id === url.searchParams.get('shot'));
      if (!shot) fail('Shot not found', 404);
      if ((url.searchParams.get('pass') || 'beauty') !== 'beauty') fail('Only beauty is supported. Depth/pose/other guides are unavailable; no beauty substitution.');
      const images = p.renders.filter(r => r.shotId === shot.id).map(r => ({ id: r.id, pass: r.pass, width: r.width, height: r.height, url: `/renders/${r.id}.png`, source: r.source }));
      if (!images.length) fail('Render a preview before exporting a handoff');
      return send({ version: 1, kind: 'previs-explicit-assets', projectId: p.id, shotId: shot.id, timing: shot.binding, images, workflowBinding: null, execution: 'not-submitted', limitation: 'Beauty stills only. A compatible image-input workflow must be selected separately. No depth, pose, video, or automatic scene transfer.' });
    }
    if (req.method === 'POST'  && url.pathname.startsWith('/api/')) {
      if (!req.headers['content-type']?.startsWith('application/json')) fail('JSON required', 415);
      const input = await body(req);
      const result = await serial(async () => {
        if (url.pathname === '/api/blender/refresh') { const serverInfo = await blender.connect(); catalog = await blender.execute(inspectCode); return { catalog, serverInfo }; }
        if (url.pathname === '/api/shots') return { project: await project.mutate(input.revision, p => {
          const title = String(input.title || 'Untitled shot').trim().slice(0, 160);
          const binding = validateBinding(input.binding, catalog);
          const shot = { id: randomUUID(), title, binding, renders: [] };
          p.shots.push(shot);
          if (!p.scenes.some(s => s.file === binding.file && s.name === binding.scene)) p.scenes.push({ id: randomUUID(), owner: 'blender', file: binding.file, name: binding.scene });
        }) };
        if (url.pathname === '/api/browser-shot') return { project: await project.mutate(input.revision, async p => {
          const browser = validateBrowser(input);
          const image = await project.image(Buffer.from(String(input.png), 'base64'));
          const id = randomUUID();
          const binding = { source: 'three', scene: 'Camera study', camera: 'Operated camera', fps: 24, start: 0, end: Math.max(0, Math.round((browser.frames.at(-1)?.t || 0) * 24)), frame: 0 };
          p.shots.push({ id, title: String(input.title || 'Camera study').slice(0, 160), binding, browser, renders: [image.id] });
          p.renders.push({ id: image.id, shotId: id, source: 'three', pass: 'beauty', width: image.width, height: image.height, binding, createdAt: new Date().toISOString() });
          if (!p.scenes.some(s => s.owner === 'three')) p.scenes.push({ id: randomUUID(), owner: 'three', name: 'Camera study', version: 1 });
        }) };
        if (url.pathname === '/api/render') {
          // Hold the project revision and operation queue across rendering. No silent overwrite after external UI edits.
          return { project: await project.mutate(input.revision, async p => {
            const shot = p.shots.find(s => s.id === input.shotId); if (!shot) fail('Shot not found');
            if (shot.binding.source !== 'blender') fail('Open this shot in the browser camera studio to capture it');
            catalog = await blender.execute(inspectCode);
            if (catalog.file !== shot.binding.file) fail('Blender file changed. Reopen the bound file before rendering.');
            const result = await blender.execute(renderCode(shot.binding));
            const image = await project.image(Buffer.from(result.png, 'base64'));
            const id = image.id;
            p.renders.push({ id, shotId: shot.id, source: 'blender', pass: 'beauty', width: image.width, height: image.height, binding: structuredClone(shot.binding), createdAt: new Date().toISOString() });
            shot.renders.push(id);
          }) };
        }
        fail('Unknown operation', 404);
      });
      return send(result);
    }
    if (req.method !== 'GET') fail('Method not allowed', 405);
    let file;
    if (/^\/renders\/[a-f0-9-]{36}\.png$/.test(url.pathname)) file = join(data, url.pathname);
    else {
      const path = url.pathname === '/' ? '/previs.html' : url.pathname;
      file = resolve(root, 'dist', '.' + decodeURIComponent(path));
      if (!file.startsWith(join(root, 'dist') + '/')) fail('Invalid path', 403);
    }
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' })[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes);
  } catch (e) { send({ error: e.code === 'ENOENT' ? 'File not found; run pnpm build first.' : e.message }, e.status || (e.code === 'ENOENT' ? 404 : 400)); }
});
attachRelay(server);
server.listen(port, '127.0.0.1', () => console.log(`Comfy Previs: http://127.0.0.1:${port}`));
async function stop() { blender.close(); server.close(); await lock.close(); await unlink(lockPath); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
