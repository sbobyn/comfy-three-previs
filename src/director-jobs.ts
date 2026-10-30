import './director-jobs.css';
import { h, toast } from './director-common';
import './director-progress.css';
import { acquireProgress, mountProgressView } from './director-progress';

// Jobs pip (top bar) + side sheet. Reads GET /api/jobs (contract C1) and GET /api/director/batches (C3); additive to pollJobs().
export type JobRow = {
  id: string; kind: 'image' | 'video'; source: 'refgen' | 'generation'; projectId: string | null; label: string; status: string;
  createdAt: string | null; submittedAt: string | null; lastTrackedAt: string | null; trackCount: number; nextTrackAt: string | null;
  ageSeconds: number; expectedSeconds: number; stuck: boolean; uncertain: boolean; costUsd: number | null;
  backend: { kind: string | null; id: string | null }; failure: { phase: string | null; httpStatus: number | null; detail: string | null } | null;
  trackingError?: string; results?: { id: string; kind: string; url: string }[]; shotId?: string; // results: not on live-stream rows
};
export type JobsSnapshot = { jobs: JobRow[]; limits: Record<string, { limit: number; active: number }>; tracker: { running: boolean; startedAt: string | null; resumed: number } };
export type BatchSummary = {
  id: string; projectId: string; status: string; createdAt: string; updatedAt: string; steps: string[]; tier?: string;
  maxCostUsd: number; estimateUsd: number; spentEstimateUsd: number; budgetSkipped?: number;
  counts?: Record<string, number>; nodes?: { status: string }[]; lastEvent?: { at: string; text: string } | null;
};
type Api = <T = any>(path: string, body?: unknown) => Promise<T>;
type Options = { projectId: string; api: Api; onOpenShot?: (shotId: string) => void; shots?: () => { id: string; title: string }[] };

// ---- pure helpers (tests/director-jobs.test.mjs slices this block) ----
const DONE = new Set(['completed', 'failed', 'closed', 'invalidated', 'cancelled', 'orphaned']);
export const isActive = (j: JobRow) => !DONE.has(j.status);
/** Red: stuck, uncertain, or running past twice the expected time. */
export const needsAttention = (j: JobRow) => isActive(j) && (j.stuck || j.uncertain || j.status === 'uncertain' || (j.expectedSeconds > 0 && j.ageSeconds > 2 * j.expectedSeconds));
export const batchLive = (b: BatchSummary) => b.status === 'running' || b.status === 'paused';
/** The panel's batches: live ones, failed ones, then up to 3 finished in the last day. A dry-run plan is not work: never shown. */
export function shownBatches(batches: BatchSummary[], now = Date.now()) {
  const recent = batches.filter(b => !batchLive(b) && b.status !== 'failed' && b.status !== 'planned' && now - Date.parse(b.updatedAt || b.createdAt) < 864e5).slice(0, 3);
  return [...batches.filter(batchLive), ...batches.filter(b => b.status === 'failed'), ...recent];
}
export function batchCounts(b: BatchSummary) {
  const c = b.counts || (b.nodes || []).reduce<Record<string, number>>((m, n) => ({ ...m, [n.status]: (m[n.status] || 0) + 1 }), {});
  const total = Object.values(c).reduce((a, n) => a + n, 0);
  return { done: c.done || 0, running: c.running || 0, failed: c.failed || 0, skipped: (c.skipped || 0) + (c.budget || 0), total };
}
export function groupJobs(jobs: JobRow[]) {
  const attention = jobs.filter(needsAttention), running = jobs.filter(j => isActive(j) && !needsAttention(j));
  const recent = jobs.filter(j => !isActive(j)).slice(0, 20);
  return { attention, running, recent };
}
export type PipState = { tone: 'run' | 'bad' | 'done' | 'fail' | 'batch'; count: number; cost: number; text: string; short: string };
/** What the pip says, or null when there is nothing in flight. Terminal states are shown by the caller for 60 s after the last activity. */
export function pipState(jobs: JobRow[], batches: BatchSummary[]): PipState | null {
  const { attention, running } = groupJobs(jobs);
  const cost = [...attention, ...running].reduce((a, j) => a + (j.costUsd || 0), 0);
  const money = cost > 0 ? ` · $${cost.toFixed(2)}` : '';
  if (attention.length) {
    const stuck = attention.filter(j => !(j.uncertain || j.status === 'uncertain')).length, unsure = attention.length - stuck;
    const text = [stuck ? `${stuck} stuck` : '', unsure ? `${unsure} uncertain` : ''].filter(Boolean).join(' · ') + (running.length ? ` · ${running.length} running` : '');
    return { tone: 'bad', count: attention.length, cost, text, short: text.split(' · ')[0] };
  }
  if (running.length) return { tone: 'run', count: running.length, cost, text: `${running.length} running${money}`, short: `${running.length}${money}` };
  const live = batches.filter(batchLive);
  if (live.length) { const b = live[0], c = batchCounts(b); return { tone: 'batch', count: live.length, cost: 0, text: b.status === 'paused' ? `Batch paused · ${c.done}/${c.total}` : `Batch ${c.done}/${c.total}`, short: `${c.done}/${c.total}` }; }
  return null;
}
/** After the last watched job finishes: "All done", or how many of the watched jobs failed. */
export function settledState(jobs: JobRow[], watched: Set<string>): PipState {
  const failed = jobs.filter(j => j.status === 'failed' && watched.has(j.id)).length;
  return failed ? { tone: 'fail', count: failed, cost: 0, text: `${failed} failed`, short: String(failed) } : { tone: 'done', count: 0, cost: 0, text: 'All done', short: '✓' };
}
export function dur(s: number) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
export const since = (iso: string | null, now = Date.now()) => (iso ? `${dur((now - Date.parse(iso)) / 1000)} ago` : 'never');
// ---- end pure helpers ----

const KIND_ICON: Record<string, string> = {
  image: '<rect x="2.5" y="3.5" width="11" height="9" rx="1.6"/><circle cx="6" cy="7" r="1.2"/><path d="m3 12 3.5-3.2 2.4 2 1.8-1.4L13.5 12"/>',
  video: '<rect x="2" y="4" width="8.5" height="8" rx="1.6"/><path d="m10.5 7.2 3.5-2v5.6l-3.5-2"/>',
  batch: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
};
const icon = (k: string) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.3'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = KIND_ICON[k] || KIND_ICON.image; return s; };
const SLOT_NAMES: Record<string, string> = { 'cloud:image': 'Cloud images', 'cloud:video': 'Cloud video', local: 'Local' };

export function mountJobsPip(host: HTMLElement, { projectId, api, onOpenShot, shots }: Options) {
  const dot = h('span', { class: 'jp-dot', 'aria-hidden': 'true' });
  const word = h('span', { class: 'jp-text' }), short = h('span', { class: 'jp-short', 'aria-hidden': 'true' });
  const pip = h('button', { class: 'jobs-pip', type: 'button', hidden: true, 'aria-haspopup': 'dialog', 'aria-live': 'polite', title: 'Generation jobs', onclick: () => open() }, dot, word, short);
  host.prepend(pip);

  let snap: JobsSnapshot = { jobs: [], limits: {}, tracker: { running: false, startedAt: null, resumed: 0 } };
  let batches: BatchSummary[] = [];
  let jobsOk = true, batchesOk = true, lastBusy = 0, timer = 0, hideTimer = 0, inflight = false, fetchedAt = Date.now(), lastTone = '';
  const reconcileOpen = new Set<string>(), recChecks = new Map<string, { idle: boolean; hist: boolean }>(), busy = new Set<string>(), watched = new Set<string>();

  const sheet = h('dialog', { class: 'jobs-sheet', 'aria-labelledby': 'jobs-title' });
  sheet.addEventListener('click', e => { if (e.target === sheet) sheet.close(); });
  sheet.addEventListener('close', () => { sheet.remove(); for (const key of [...views.keys()]) dropView(key); });

  // Live progress for this project's rows: one shared lease. Ticks update keyed views in place; the
  // sheet itself is rebuilt only when a row's status changes, so focus and scroll stay put.
  const lease = projectId ? acquireProgress(projectId) : null;
  const views = new Map<string, { el: HTMLElement; dispose: () => void }>();
  const rowKey = (j: JobRow) => `${j.source}:${j.id}`;
  const shape = (jobs: JobRow[]) => jobs.map(j => `${rowKey(j)}:${j.status}:${j.stuck}:${j.uncertain}`).join('|');
  function dropView(key: string) { views.get(key)?.dispose(); views.get(key)?.el.remove(); views.delete(key); }
  function progressFor(j: JobRow) {
    if (!lease || j.projectId !== projectId || !isActive(j)) return null;
    let view = views.get(rowKey(j));
    if (!view) { const el = h('div', { class: 'jr-progress' }); view = { el, dispose: mountProgressView(el, lease.client, j.source, j.id, j.label) }; views.set(rowKey(j), view); }
    return view.el;
  }
  let liveSeen = false;
  lease?.client.subscribe(() => {
    // Merge only once the shared client holds an authoritative snapshot (SSE or C1 poll).
    if (['live', 'polling'].includes(lease.client.connection())) liveSeen = true;
    if (!liveSeen) return;
    const live = lease.client.snapshot().jobs as unknown as JobRow[];
    const before = shape(snap.jobs), byKey = new Map(live.map(j => [rowKey(j), j]));
    const merged = snap.jobs.filter(j => j.projectId !== projectId || byKey.has(rowKey(j))).map(j => byKey.get(rowKey(j)) || j);
    for (const j of live) if (!merged.some(m => rowKey(m) === rowKey(j))) merged.push(j);
    merged.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    snap = { ...snap, jobs: merged };
    if (shape(merged) !== before) render();
  });

  // A server without the S1/S3 routes answers 404 ("File not found", "Unknown director route"): stop asking.
  const missing = (e: unknown) => /not found|unknown\b.*\broute|\(404\)/i.test((e as Error).message);
  async function load() {
    if (inflight) return; inflight = true;
    try {
      const [j, b] = await Promise.all([
        // A project sees only its own jobs; the global list is for home (projectId '').
        jobsOk ? api<JobsSnapshot>(projectId ? `jobs?projectId=${encodeURIComponent(projectId)}` : 'jobs').catch(e => { if (missing(e)) jobsOk = false; return null; }) : null,
        batchesOk && projectId ? api<{ batches: BatchSummary[] }>(`director/batches?projectId=${encodeURIComponent(projectId)}`).catch(e => { if (missing(e)) batchesOk = false; return null; }) : null,
      ]);
      if (j && Array.isArray(j.jobs)) snap = j;
      if (b && Array.isArray(b.batches)) batches = b.batches;
      fetchedAt = Date.now();
      render();
    } finally { inflight = false; }
  }
  function busyNow() { return snap.jobs.some(isActive) || batches.some(b => b.status === 'running'); }
  function schedule() {
    clearTimeout(timer);
    if (document.hidden || (!jobsOk && !batchesOk)) return;
    timer = window.setTimeout(async () => { await load(); schedule(); }, busyNow() ? 4000 : 20000);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else void load().then(schedule); });

  function render() {
    const live = pipState(snap.jobs, batches);
    for (const j of snap.jobs) if (isActive(j)) watched.add(j.id);
    if (live) lastBusy = Date.now();
    // Idle: show the outcome for 60 s after the last activity this tab saw, then step out of the way.
    const state = live || (lastBusy && Date.now() - lastBusy <= 60000 ? settledState(snap.jobs, watched) : null);
    pip.hidden = !state;
    clearTimeout(hideTimer);
    if (state && !live) hideTimer = window.setTimeout(render, Math.max(0, 60050 - (Date.now() - lastBusy)));
    if (state) {
      pip.className = `jobs-pip jp-${state.tone}`;
      if (lastTone && state.tone !== lastTone) { void pip.offsetWidth; pip.classList.add('jp-pop'); }
      word.textContent = state.text; short.textContent = state.short;
      pip.setAttribute('aria-label', `Jobs: ${state.text}. Open the jobs panel`);
      lastTone = state.tone;
    } else lastTone = '';
    if (sheet.open) renderSheet();
  }

  async function act(key: string, run: () => Promise<unknown>, ok?: string) {
    if (busy.has(key)) return; busy.add(key); if (sheet.open) renderSheet();
    try { await run(); if (ok) toast(ok); } catch (e) { toast((e as Error).message, true); }
    busy.delete(key); await load(); schedule();
  }
  const trackNow = (j: JobRow) => act(`track:${j.id}`, () => j.source === 'refgen'
    ? api('director/refgen/track', { projectId: j.projectId, requestId: j.id })
    : api('generation/track', { jobId: j.id }));
  const reconcile = (j: JobRow) => act(`rec:${j.id}`, async () => { await api('generation/reconcile', { jobId: j.id, backendIdle: true, historyReviewed: true }); reconcileOpen.delete(j.id); recChecks.delete(j.id); }, 'Receipt closed: outcome unknown, nothing was cancelled or retried');
  const dismiss = (j: JobRow) => act(`dis:${j.id}`, () => api('generation/dismiss', { jobId: j.id }));
  const batchCall = (b: BatchSummary, what: 'cancel' | 'resume') => act(`${what}:${b.id}`, () => api(`director/batch/${what}`, { id: b.id }), what === 'cancel' ? 'Batch cancelled' : 'Batch resumed');

  function shotOf(j: JobRow) {
    if (j.projectId !== projectId) return null;
    if (j.shotId) return j.shotId;
    const list = shots?.() || [];
    // Labels look like "Starter · Wingspan · Shot 1 · The valley · LTX 2.5 Pro" or "Shot 02 The dive · FLUX 3 Image": match a shot title as a segment.
    const parts = j.label.split(' · ').map(p => p.replace(/^Shot \d+\s+/, ''));
    return list.find(s => j.label.startsWith(`${s.title} · `) || parts.includes(s.title))?.id || null;
  }

  function jobRow(j: JobRow) {
    const attention = needsAttention(j), active = isActive(j), now = fetchedAt;
    const status = attention ? (j.uncertain || j.status === 'uncertain' ? 'uncertain' : 'stuck') : j.status;
    const tone = attention || j.status === 'failed' ? 'bad' : active ? 'run' : j.status === 'completed' ? 'ok' : 'muted';
    const ratio = j.expectedSeconds > 0 ? j.ageSeconds / j.expectedSeconds : 0;
    const meta = [
      active ? `${dur(j.ageSeconds)} of ~${dur(j.expectedSeconds)}` : j.createdAt ? since(j.createdAt, now) : '',
      active ? `checked ${since(j.lastTrackedAt, now)}${j.trackCount ? ` · ×${j.trackCount}` : ''}` : j.status === 'completed' && j.ageSeconds ? `took ${dur(j.ageSeconds)}` : '',
      j.costUsd != null ? `$${j.costUsd.toFixed(2)}` : '',
      j.status === 'orphaned' ? 'project archived or deleted · output kept' : '',
    ].filter(Boolean);
    const shot = onOpenShot ? shotOf(j) : null;
    const tracking = busy.has(`track:${j.id}`);
    const canReconcile = j.source === 'generation' && j.status === 'uncertain';
    const actions = h('div', { class: 'jr-act' },
      active ? h('button', { class: 'btn ghost sm', type: 'button', 'data-k': `track:${j.id}`, disabled: tracking, onclick: () => void trackNow(j) }, tracking ? 'Checking…' : 'Track now') : null,
      canReconcile ? h('button', { class: 'btn ghost sm', type: 'button', 'data-k': `rec:${j.id}`, 'aria-expanded': String(reconcileOpen.has(j.id)), onclick: () => { if (reconcileOpen.has(j.id)) reconcileOpen.delete(j.id); else reconcileOpen.add(j.id); renderSheet(); } }, 'Reconcile…') : null,
      shot ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { sheet.close(); onOpenShot!(shot); } }, 'Open shot') : null,
      j.status === 'orphaned' ? h('button', { class: 'btn ghost sm', type: 'button', 'data-k': `dis:${j.id}`, disabled: busy.has(`dis:${j.id}`), onclick: () => void dismiss(j) }, 'Dismiss') : null);
    // On a job that is still active, a failure is the last status check, not the job: show it quietly.
    const where = j.failure ? `${j.failure.phase || 'unknown step'}${j.failure.httpStatus ? ` · HTTP ${j.failure.httpStatus}` : ''}` : '';
    const detail = j.failure?.detail || (active ? j.trackingError : '') || '';
    const failure = j.failure || (active && j.trackingError) ? h('div', { class: `jr-fail${active ? ' soft' : ''}` },
      where ? h('div', { class: 'jr-fail-head' }, active ? `Last check failed at ${where}` : `Failed at ${where}`) : null,
      detail ? h('pre', {}, detail) : null) : null;
    let rec: HTMLElement | null = null;
    if (canReconcile && reconcileOpen.has(j.id)) {
      // Checkbox state survives the 4 s refresh.
      const c = recChecks.get(j.id) || { idle: false, hist: false };
      const idle = h('input', { type: 'checkbox', checked: c.idle, 'data-k': `idle:${j.id}` }), hist = h('input', { type: 'checkbox', checked: c.hist, 'data-k': `hist:${j.id}` });
      const go = h('button', { class: 'btn sm jr-close', type: 'button', 'data-k': `go:${j.id}`, onclick: () => void reconcile(j) }, busy.has(`rec:${j.id}`) ? 'Closing…' : 'Close receipt');
      const sync = () => { recChecks.set(j.id, { idle: idle.checked, hist: hist.checked }); go.disabled = !(idle.checked && hist.checked) || busy.has(`rec:${j.id}`); };
      idle.onchange = sync; hist.onchange = sync; go.disabled = !(c.idle && c.hist) || busy.has(`rec:${j.id}`);
      rec = h('div', { class: 'jr-rec' },
        h('p', {}, 'Use this only when the backend shows no trace of this request. It marks the receipt closed; it does not cancel, retry or collect anything.'),
        h('label', {}, idle, 'The backend queue is idle (nothing running or pending)'),
        h('label', {}, hist, 'I reviewed the backend history for this request'),
        h('div', { class: 'jr-rec-go' }, go));
    }
    return h('li', { class: `jr t-${tone}`, dataset: { id: j.id } },
      h('span', { class: 'jr-kind', title: j.kind === 'video' ? 'Video' : 'Image' }, icon(j.kind)),
      h('div', { class: 'jr-main' },
        h('div', { class: 'jr-top' }, h('span', { class: 'jr-label', title: j.label }, j.label), h('span', { class: `jr-status t-${tone}` }, status)),
        h('div', { class: 'jr-meta' }, meta.join(' · ')),
        active ? h('div', { class: `jr-bar${ratio > 1 ? ' over' : ''}${attention ? ' bad' : ''}`, role: 'progressbar', 'aria-label': 'Elapsed against expected time', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.min(100, Math.round(ratio * 100))) }, h('i', { style: `width:${Math.min(100, Math.round(ratio * 100))}%` })) : null,
        progressFor(j), failure, rec,
        actions.childElementCount ? actions : null));
  }

  function batchRow(b: BatchSummary) {
    const c = batchCounts(b), pct = (n: number) => (c.total ? (n / c.total) * 100 : 0);
    const canCancel = batchLive(b), canResume = b.status === 'paused' || b.status === 'failed';
    const tone = b.status === 'failed' ? 'bad' : b.status === 'paused' ? 'warn' : b.status === 'running' ? 'run' : b.status === 'completed' ? 'ok' : 'muted';
    const cb = busy.has(`cancel:${b.id}`), rb = busy.has(`resume:${b.id}`);
    return h('li', { class: `jr batch t-${tone}` },
      h('span', { class: 'jr-kind' }, icon('batch')),
      h('div', { class: 'jr-main' },
        h('div', { class: 'jr-top' }, h('span', { class: 'jr-label' }, `${b.tier ? b.tier[0].toUpperCase() + b.tier.slice(1) : 'Batch'} · ${b.steps.join(', ')}`), h('span', { class: `jr-status t-${tone}` }, b.status)),
        h('div', { class: 'jr-meta' }, [`${c.done} of ${c.total} done`, c.running ? `${c.running} running` : '', c.failed ? `${c.failed} failed` : '', c.skipped ? `${c.skipped} over budget` : '', `$${(b.spentEstimateUsd || 0).toFixed(2)} of $${(b.maxCostUsd || 0).toFixed(2)}`].filter(Boolean).join(' · ')),
        h('div', { class: 'jb-bar', role: 'img', 'aria-label': `${c.done} of ${c.total} steps done` },
          h('i', { class: 'd', style: `width:${pct(c.done)}%` }), h('i', { class: 'r', style: `width:${pct(c.running)}%` }), h('i', { class: 'f', style: `width:${pct(c.failed)}%` }), h('i', { class: 's', style: `width:${pct(c.skipped)}%` })),
        b.lastEvent ? h('div', { class: 'jr-meta faint' }, `${b.lastEvent.text} · ${since(b.lastEvent.at, fetchedAt)}`) : null,
        canCancel || canResume ? h('div', { class: 'jr-act' },
          canResume ? h('button', { class: 'btn ghost sm', type: 'button', 'data-k': `resume:${b.id}`, disabled: rb, onclick: () => void batchCall(b, 'resume') }, rb ? 'Resuming…' : 'Resume') : null,
          canCancel ? h('button', { class: 'btn ghost sm', type: 'button', 'data-k': `cancel:${b.id}`, disabled: cb, onclick: () => void batchCall(b, 'cancel') }, cb ? 'Cancelling…' : 'Cancel') : null) : null));
  }

  function section(title: string, cls: string, rows: HTMLElement[], empty?: string) {
    if (!rows.length && !empty) return null;
    return h('section', { class: `js-sec ${cls}` }, h('h3', {}, title, rows.length ? h('span', { class: 'js-n' }, String(rows.length)) : null),
      rows.length ? h('ul', {}, ...rows) : h('p', { class: 'js-empty' }, empty!));
  }

  function renderSheet() {
    // Re-rendered on every poll: keep scroll position and keyboard focus.
    const scroll = sheet.querySelector('.js-body')?.scrollTop || 0, focusKey = (document.activeElement as HTMLElement | null)?.closest?.('.jobs-sheet') ? (document.activeElement as HTMLElement).dataset.k : undefined;
    const g = groupJobs(snap.jobs);
    const slots = Object.entries(snap.limits || {}).filter(([, v]) => v && v.limit > 0).map(([k, v]) =>
      h('span', { class: 'js-slot', title: `${SLOT_NAMES[k] || k}: ${v.active} of ${v.limit} slots in use` }, h('span', { class: 'js-slot-name' }, SLOT_NAMES[k] || k),
        h('span', { class: 'js-pips', 'aria-hidden': 'true' }, ...Array.from({ length: Math.min(v.limit, 8) }, (_, i) => h('i', { class: i < v.active ? 'on' : '' })))));
    const listed = shownBatches(batches, fetchedAt);
    const nothing = !snap.jobs.length && !listed.length;
    const sub = !jobsOk ? 'Job tracking is not available on this server yet.' : g.attention.length ? `${g.attention.length} need${g.attention.length === 1 ? 's' : ''} attention` : g.running.length ? `${g.running.length} running` : 'Nothing running';
    sheet.replaceChildren(
      h('header', { class: 'js-head' },
        h('div', {}, h('h2', { id: 'jobs-title' }, 'Jobs'), h('p', { class: 'js-sub' }, sub)),
        h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close', onclick: () => sheet.close() }, '✕')),
      slots.length ? h('div', { class: 'js-slots', 'aria-label': 'Backend slots' }, ...slots) : '',
      h('div', { class: 'js-body' },
        section('Needs attention', 'bad', g.attention.map(jobRow)),
        section('Running', 'run', g.running.map(jobRow)),
        section('Batches', 'batches', listed.map(batchRow)),
        section('Recent', 'recent', g.recent.map(jobRow)),
        nothing ? h('div', { class: 'js-idle' }, h('span', { class: 'js-idle-mark', 'aria-hidden': 'true' }), h('p', {}, 'No generation jobs yet. Images and videos you generate show up here while they run.')) : null),
      h('footer', { class: 'js-foot' }, !jobsOk ? 'Waiting for the job tracker' : `${snap.tracker.running ? 'Tracker on' : 'Tracker paused'} · refreshes every ${busyNow() ? 4 : 20} s`));
    for (const key of [...views.keys()]) if (!views.get(key)!.el.isConnected) dropView(key);
    const body = sheet.querySelector('.js-body'); if (body) body.scrollTop = scroll;
    if (focusKey) sheet.querySelector<HTMLElement>(`[data-k="${focusKey}"]`)?.focus();
  }

  function open() {
    if (!sheet.isConnected) document.body.append(sheet);
    renderSheet();
    if (!sheet.open) sheet.showModal();
    void load();
  }

  void load().then(schedule);
  return { refresh: () => load().then(schedule), open, el: pip };
}
