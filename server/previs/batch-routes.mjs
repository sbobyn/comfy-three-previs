// Batch HTTP routes (contract C3). The SSE stream needs the raw response, so server.mjs calls batches.stream directly.
const uuid = /^[a-f0-9-]{36}$/;
function fail(message, status = 400) { const e = Error(message); e.status = status; throw e; }
const idOf = v => (uuid.test(String(v || '')) ? String(v) : fail('Unknown batch', 404));

export function batchRoutes(batches) {
  return async function route(method, url, input) {
    const path = url.pathname;
    if (method === 'GET' && path === '/api/director/batch') return { batch: batches.get(idOf(url.searchParams.get('id'))) };
    if (method === 'GET' && path === '/api/director/batches') {
      const projectId = url.searchParams.get('projectId');
      if (projectId && !uuid.test(projectId)) fail('Unknown project', 404);
      return { batches: batches.list(projectId || null) };
    }
    if (method !== 'POST') fail(method === 'GET' ? 'Unknown batch route' : 'Method not allowed', method === 'GET' ? 404 : 405);
    if (path === '/api/director/batch') return { batch: await batches.create(input) };
    if (path === '/api/director/batch/cancel') return { batch: await batches.cancel(idOf(input.id)) };
    if (path === '/api/director/batch/resume') return { batch: await batches.resume(idOf(input.id), { maxCostUsd: input.maxCostUsd }) };
    fail('Unknown batch route', 404);
  };
}
