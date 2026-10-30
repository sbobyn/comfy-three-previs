// Contract C2: server-side blockout, frame and sheet rendering through the headless page pool (headless.mjs).
import { opQuery, unavailable } from './headless.mjs';

function fail(message, status = 400) { const e = Error(message); e.status = status; throw e; }
const ROUTES = new Set(['/api/director/render-blockout', '/api/director/frame', '/api/director/sheet/compose', '/api/director/headless']);
const size = (v, d) => { const n = v ?? d; if (!Number.isInteger(n) || n < 16 || n > 3840) fail('width and height must be whole pixels between 16 and 3840'); return n; };
const pickAsset = a => a && { id: a.id, width: a.width, height: a.height, fps: a.fps, frameCount: a.frameCount, duration: a.duration, sha256: a.sha256 };

export function renderRoutes({ director, headless }) {
  // Blockouts write to the shared engine project (revision-checked), so they run one at a time.
  let blockouts = Promise.resolve();
  const oneAtATime = fn => { const next = blockouts.then(fn); blockouts = next.catch(() => {}); return next; };

  async function route(method, path, input) {
    if (path === '/api/director/headless') { if (method !== 'GET') fail('Method not allowed', 405); return headless.status(); }
    if (method !== 'POST') fail('Method not allowed', 405);
    const p = await director.get(input.projectId);
    if (path === '/api/director/sheet/compose') {
      const e = p.scene.entities.find(x => x.id === input.entityId); if (!e) fail('Unknown object', 404);
      if (!(e.sheets || []).some(s => s.id === input.sheetId)) fail('Unknown sheet', 404);
      if (input.options != null && (typeof input.options !== 'object' || Array.isArray(input.options))) fail('options must be an object');
      const r = await headless.run(opQuery('sheet', { project: p.id, entity: e.id, sheet: input.sheetId, options: input.options }));
      return { referenceId: r.referenceId, project: await director.get(p.id) };
    }
    const s = p.shots.find(x => x.id === input.shotId); if (!s) fail('Unknown shot', 404);
    const width = size(input.width, 1280), height = size(input.height, 720);
    if (path === '/api/director/frame') {
      const t = Number(input.t); if (input.t == null || !Number.isFinite(t)) fail('t (seconds into the shot) is required');
      const type = input.type ?? 'image/png'; if (!['image/png', 'image/jpeg'].includes(type)) fail('type must be image/png or image/jpeg');
      // guide: the still-guide look (front markers, ground grid, light sky) used as image 1 for key-frame stills.
      return headless.run(opQuery('frame', { project: p.id, shot: s.id, t, width, height, type, ...(input.guide === true ? { guide: 1 } : {}) }));
    }
    // render-blockout
    if (s.render && input.force !== true) return { skipped: true, previsShotId: s.render.previsShotId, asset: pickAsset((p.assets || []).find(a => a.id === s.render.assetId)) || { id: s.render.assetId, width: s.render.width, height: s.render.height, fps: 24, frameCount: s.render.frameCount, duration: s.render.duration } };
    if (!headless.enabled) unavailable(headless.reason);
    return oneAtATime(async () => {
      const run = () => headless.run(opQuery('blockout', { project: p.id, shot: s.id, width, height }));
      // Another client can move the engine revision between the page's save and its stage start; retry once.
      const r = await run().catch(e => (/Project changed/.test(e.message) ? run() : Promise.reject(e)));
      return { asset: pickAsset(r.asset), previsShotId: r.previsShotId, project: await director.get(p.id) };
    });
  }

  return {
    route,
    handles: path => ROUTES.has(path),
    /** Serves one C2 route; a disabled renderer answers 409 { error, code: 'headless-unavailable' }. Other errors go to the caller's handler. */
    async serve(req, url, send, body) {
      try {
        if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) fail('JSON required', 415);
        return send(await route(req.method, url.pathname, req.method === 'POST' ? await body(req) : {}));
      } catch (e) {
        if (e.apiCode) return send({ error: e.message, code: e.apiCode }, e.status);
        throw e;
      }
    },
  };
}
