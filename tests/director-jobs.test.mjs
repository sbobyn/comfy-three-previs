import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = await readFile(new URL('../src/director-jobs.ts', import.meta.url), 'utf8');
const a = source.indexOf('// ---- pure helpers'), b = source.indexOf('// ---- end pure helpers');
const exports = {};
runInNewContext(ts.transpileModule(source.slice(a, b), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, Date, Set, Math, String, Object });
const { pipState, groupJobs, settledState, batchCounts, needsAttention, dur, shownBatches } = exports;
const { jobs } = JSON.parse(await readFile(new URL('./fixtures/jobs.json', import.meta.url), 'utf8'));
const { batches } = JSON.parse(await readFile(new URL('./fixtures/batches.json', import.meta.url), 'utf8'));
const byStatus = s => jobs.find(j => j.status === s);

test('jobs are grouped into needs attention, running and recent', () => {
  const g = groupJobs(jobs);
  assert.deepEqual(g.attention.map(j => j.status), ['uncertain']);
  assert.deepEqual(g.running.map(j => j.status), ['running', 'submitted']);
  assert.deepEqual(g.recent.map(j => j.status), ['failed', 'completed', 'completed']);
  assert.ok(groupJobs(Array.from({ length: 30 }, (_, i) => ({ ...byStatus('completed'), id: String(i) }))).recent.length === 20);
});

test('pip: amber while running with the in-flight cost, red when stuck or uncertain, null when idle', () => {
  const running = jobs.filter(j => j.status !== 'uncertain');
  assert.deepEqual({ ...pipState(running, []) }, { tone: 'run', count: 2, cost: 0.41, text: '2 running · $0.41', short: '2 · $0.41' });
  const bad = pipState(jobs, []);
  assert.equal(bad.tone, 'bad'); assert.equal(bad.text, '1 uncertain · 2 running'); assert.equal(bad.short, '1 uncertain');
  assert.equal(pipState(jobs.filter(j => ['completed', 'failed'].includes(j.status)), []), null);
});

test('a queued job turns red after twice its expected time even before the server flags it stuck', () => {
  const queued = { ...byStatus('running'), status: 'queued', stuck: false, ageSeconds: 100, expectedSeconds: 60 };
  assert.equal(needsAttention(queued), false);
  assert.equal(needsAttention({ ...queued, ageSeconds: 121 }), true);
  assert.equal(pipState([{ ...queued, ageSeconds: 121 }], []).text, '1 stuck');
  assert.equal(needsAttention({ ...byStatus('failed'), ageSeconds: 9999 }), false);
});

test('settled pip reports failures only for jobs this tab watched', () => {
  const failed = byStatus('failed');
  assert.equal(settledState(jobs, new Set()).text, 'All done');
  assert.equal(settledState(jobs, new Set([failed.id])).text, '1 failed');
});

test('batches: counts from summary or nodes; a live batch shows when no job is in flight', () => {
  assert.deepEqual({ ...batchCounts(batches[0]) }, { done: 7, running: 2, failed: 1, skipped: 0, total: 16 });
  assert.deepEqual({ ...batchCounts(batches[1]) }, { done: 4, running: 0, failed: 0, skipped: 3, total: 9 });
  assert.equal(batchCounts({ nodes: [{ status: 'done' }, { status: 'budget' }, { status: 'waiting' }] }).total, 3);
  assert.equal(pipState([], batches).text, 'Batch 7/16');
  assert.equal(pipState([], [batches[1]]).text, 'Batch paused · 4/9');
  assert.equal(pipState([], [{ ...batches[0], status: 'completed' }]), null);
  assert.equal(dur(59), '59s'); assert.equal(dur(130), '2m 10s'); assert.equal(dur(3720), '1h 02m');
});

test('an orphaned job (project archived or deleted) is terminal and never turns the pip red', () => {
  const orphaned = { ...byStatus('completed'), status: 'orphaned', stuck: false, ageSeconds: 9e5, expectedSeconds: 60 };
  assert.equal(needsAttention(orphaned), false);
  assert.equal(pipState([orphaned], []), null);
  assert.deepEqual(groupJobs([orphaned]).recent.map(j => j.status), ['orphaned']);
});

test('the pip in a project reads only that project\'s jobs; home shows the global count', async () => {
  assert.match(source, /api<JobsSnapshot>\(projectId \? `jobs\?projectId=\$\{encodeURIComponent\(projectId\)\}` : 'jobs'\)/);
  const home = await readFile(new URL('../src/director-home.ts', import.meta.url), 'utf8'), director = await readFile(new URL('../src/director.ts', import.meta.url), 'utf8');
  assert.match(home, /mountJobsPip\(jobsHost, \{ projectId: '', api \}\)/);
  assert.match(director, /mountJobsPip\([^;]*\{ projectId, api/);
});

test('batches: a dry-run plan never lights the pip or lists in Jobs; failed and recent finished batches do', () => {
  const at = Date.parse('2026-10-30T12:00:00Z'), b = (id, status, hoursAgo = 1) => ({ ...batches[0], id, status, updatedAt: new Date(at - hoursAgo * 3600e3).toISOString() });
  assert.equal(pipState([], [b('plan', 'planned')]), null);
  const list = [b('plan', 'planned'), b('done1', 'completed'), b('run', 'running'), b('bad', 'failed', 30), b('done2', 'cancelled'), b('old', 'completed', 30), b('done3', 'completed'), b('done4', 'completed')];
  assert.deepEqual([...shownBatches(list, at).map(x => x.id)], ['run', 'bad', 'done1', 'done2', 'done3']);
});
