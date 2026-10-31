import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { openProject } from '../server/previs/store.mjs';
import { generationRoutes } from '../server/previs/generation-routes.mjs';
import { createJobTracker } from '../server/previs/job-tracker.mjs';
import { backendSnapshot } from '../server/previs/backends.mjs';
import { atomicJson } from '../server/previs/atomic.mjs';

// B8: a restart or an archived project must never leave a permanent "stuck" job.
const receipt = (projectId, extra = {}) => {
  const id = randomUUID();
  return { id, status: 'completed', promptId: 'p-' + id, backend: backendSnapshot({ kind: 'local' }), definition: { title: 'Fixture', task: 'image', outputs: [{ nodeId: '1', mediaType: 'image/png' }] },
    results: [{ id: randomUUID(), key: `1:${id.slice(0, 8)}`, kind: 'image', mime: 'image/png', filename: 'x.png', url: '/renders/x.png' }],
    shot: { title: 'Shot', binding: {}, ...(projectId ? { browser: { director: { projectId } } } : {}) }, sources: {}, binding: { prompt: 'p', parameters: {} },
    createdAt: new Date(Date.now() - 3 * 864e5).toISOString(), completedAt: new Date(Date.now() - 3 * 864e5).toISOString(), ...extra };
};
const legacyAsset = job => ({ ...job.results[0], generationJobId: job.id, version: 1, source: 'comfy' });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'previs-orphaned-')), project = await openProject(root);
  await mkdir(join(root, 'generation-jobs'));
  return { root, project, write: job => atomicJson(join(root, 'generation-jobs', job.id + '.json'), job) };
}
const boot = async (f, director) => {
  const routes = await generationRoutes(f.root, f.project, { backendFactory: () => { throw Error('No backend call expected'); } });
  const tracker = createJobTracker({ sources: [routes.trackerSource({ director })], tickMs: 0 }); routes.useTracker(tracker);
  tracker.start(); await tracker.tick(); tracker.stop();
  return { routes, tracker, job: id => routes.state().jobs.find(j => j.id === id) };
};

test('a legacy completed receipt whose result is already in the library is not re-attached on boot', async () => {
  const f = await fixture(), job = receipt(randomUUID());
  await f.write(job); await f.project.append(p => { (p.assets ||= []).push(legacyAsset(job)); });
  let syncs = 0;
  const { job: get, tracker } = await boot(f, { syncResults: async () => { syncs++; throw Object.assign(Error('Unknown project'), { status: 404 }); } });
  assert.equal(get(job.id).status, 'completed'); assert.equal(get(job.id).attachment.migrated, true); assert.equal(syncs, 0);
  assert.equal(tracker.snapshot().jobs.filter(j => j.stuck).length, 0);
});

test('an archived project turns its attaching job orphaned (terminal, not stuck), and Dismiss hides it', async () => {
  const f = await fixture(), job = receipt(randomUUID(), { completedAt: undefined, status: 'attaching' }), old = receipt(randomUUID());
  // `old` predates attachment records and is missing from the library; its project was archived too.
  await f.write(job); await f.write(old);
  const director = { syncResults: async () => { throw Object.assign(Error('Unknown project'), { status: 404 }); } };
  let b = await boot(f, director);
  for (const id of [job.id, old.id]) assert.equal(b.job(id).status, 'orphaned');
  assert.equal(f.project.get().assets.length, 2, 'outputs are kept in the library');
  const snap = b.tracker.snapshot();
  assert.deepEqual(snap.jobs.map(j => [j.id, j.stuck]).sort(), [[job.id, false]], 'the 3-day-old receipt is not recent; the fresh one is not stuck');
  await assert.rejects(b.routes.route('/api/generation/dismiss', { jobId: randomUUID() }), /not found/);
  const dismissed = (await b.routes.route('/api/generation/dismiss', { jobId: job.id })).job;
  assert.ok(dismissed.dismissedAt);
  assert.equal(b.tracker.snapshot().jobs.length, 0);
  b = await boot(f, director); // Restart: still orphaned and dismissed, no new attempt.
  assert.equal(b.job(job.id).status, 'orphaned'); assert.equal(b.tracker.snapshot().jobs.length, 0);
});

test('a receipt already stopped as recovery-required by "Unknown project" becomes orphaned on the next boot', async () => {
  const f = await fixture(), job = receipt(randomUUID(), { status: 'recovery-required', recovery: { attachment: 3 }, failure: { phase: 'attachment', detail: 'Unknown project' } });
  await f.write(job); await f.project.append(p => { (p.assets ||= []).push(legacyAsset(job)); });
  const b = await boot(f, { syncResults: async () => { throw Object.assign(Error('Unknown project'), { status: 404 }); } });
  assert.equal(b.job(job.id).status, 'orphaned'); assert.equal(b.tracker.snapshot().jobs.filter(j => j.stuck).length, 0);
  // Other attachment failures keep their budget and stay recovery-required.
  const g = await fixture(), other = receipt(randomUUID(), { status: 'recovery-required', recovery: { attachment: 3 }, failure: { phase: 'attachment', detail: 'disk full' } });
  await g.write(other);
  assert.equal((await boot(g, { syncResults: async () => ({ project: { assets: [] } }) })).job(other.id).status, 'recovery-required');
});

// Migration: boot the real server on a dev-data-shaped directory (live, archived and project-less receipts), restart it,
// and check /api/jobs. Set PREVIS_MIGRATION_DATA=<dev-data> to also run it on an APFS clone of a real data directory.
async function bootServer(dir, port) {
  const server = spawn(process.execPath, ['server/previs/server.mjs'], { env: { ...process.env, PORT: String(port), PREVIS_DATA_DIR: dir, PREVIS_ALLOW_PAID: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Comfy Previs:')) resolve(); }); server.once('exit', c => reject(Error('server exited ' + c))); });
  const base = `http://127.0.0.1:${port}`, json = async (path, body) => (await fetch(base + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  return { json, stop: async () => { const ended = once(server, 'exit'); server.kill('SIGTERM'); await ended; } };
}
async function settled(s) {
  for (let i = 0; i < 80; i++) { const snap = await s.json('/api/jobs'); if (!snap.jobs.some(j => ['attaching'].includes(j.status))) return snap; await new Promise(r => setTimeout(r, 250)); }
  return s.json('/api/jobs');
}
test('migration: restarting on existing data leaves no stuck job from archived or legacy receipts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'previs-migrate-')), port = 15293;
  let s = await bootServer(dir, port);
  const live = (await s.json('/api/director/projects', { title: 'Live' })).project.id, gone = (await s.json('/api/director/projects', { title: 'Gone' })).project.id;
  await s.json('/api/director/archive', { projectId: gone }); await s.stop();
  const legacy = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'));
  const jobs = [receipt(live), receipt(gone), receipt(null), receipt(gone, { completedAt: undefined, status: 'attaching', createdAt: new Date().toISOString() })];
  legacy.assets = jobs.slice(0, 3).map(legacyAsset); await atomicJson(join(dir, 'project.json'), legacy);
  for (const job of jobs) await atomicJson(join(dir, 'generation-jobs', job.id + '.json'), job);
  for (let round = 0; round < 2; round++) {
    s = await bootServer(dir, port);
    try {
      const snap = await settled(s);
      assert.deepEqual(snap.jobs.filter(j => j.stuck || j.status === 'recovery-required').map(j => j.id), []);
      assert.equal(snap.jobs.find(j => j.id === jobs[3].id)?.status, 'orphaned');
      assert.equal((await s.json(`/api/jobs?projectId=${live}`)).jobs.length, 0);
    } finally { await s.stop(); }
  }
  for (const job of jobs.slice(0, 3)) assert.equal(JSON.parse(await readFile(join(dir, 'generation-jobs', job.id + '.json'), 'utf8')).status, 'completed');
  if (process.env.PREVIS_MIGRATION_DATA) {
    const copy = join(await mkdtemp(join(tmpdir(), 'previs-devdata-')), 'data');
    execFileSync('cp', ['-c', '-R', process.env.PREVIS_MIGRATION_DATA, copy]); await rm(join(copy, '.server-lock'), { force: true }); // the source may be in use
    // Put receipts a fixed server already migrated back into their pre-fix state (completed, no attachment record),
    // so the clone reproduces the audit's boot: legacy receipts, some for archived projects.
    const legacyIds = [];
    for (const file of await readdir(join(copy, 'generation-jobs'))) {
      if (!file.endsWith('.json')) continue;
      const job = JSON.parse(await readFile(join(copy, 'generation-jobs', file), 'utf8'));
      if (job.status === 'completed' && job.attachment?.migrated) { delete job.attachment; await atomicJson(join(copy, 'generation-jobs', file), job); legacyIds.push(job.id); }
    }
    for (let round = 0; round < 2; round++) {
      s = await bootServer(copy, port);
      try {
        const snap = await settled(s);
        assert.deepEqual(snap.jobs.filter(j => j.stuck || j.status === 'recovery-required').map(j => `${j.id.slice(0, 8)} ${j.status}`), []);
      } finally { await s.stop(); }
    }
    for (const id of legacyIds) assert.equal(JSON.parse(await readFile(join(copy, 'generation-jobs', id + '.json'), 'utf8')).status, 'completed', `legacy receipt ${id.slice(0, 8)} stays completed`);
    console.log(`# migration clone: ${legacyIds.length} legacy receipts restored to their pre-fix state; none stuck after two boots`);
    assert.ok((await readdir(join(copy, 'generation-jobs'))).length > 0);
  }
});
