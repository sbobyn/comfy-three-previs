// Shared, read-only C1 transport. Mounts and action policy remain with each surface.
export type Preview = { version: number; url: string; mime: string; width: number; height: number; receivedAt: string; nodeId: string | null };
export type ProgressJob = { source: 'generation' | 'refgen'; id: string; projectId: string; status: string; label: string;
  uncertain?: boolean; ageSeconds?: number; results?: unknown[];
  live?: { phase: string; observedAt: string; connection: string;
    node: { id: string; label: string; value: number | null; max: number | null; unit: string | null } | null;
    queue: unknown | null; estimate: unknown | null; preview: Preview | null }; [key: string]: unknown };
export type ProgressSnapshot = { jobs: ProgressJob[]; limits: Record<string, unknown>; tracker: Record<string, unknown>; budget?: unknown };
type Options = { document?: Document; eventSource?: ((url: string) => EventSource) | null;
  poll?: (projectId: string, signal: AbortSignal) => Promise<ProgressSnapshot> };
const terminal = new Set(['completed', 'failed', 'cancelled', 'closed', 'invalidated', 'orphaned']);
const keyOf = (j: { source: string; id: string }) => `${j.source}:${j.id}`;
const validJob = (j: any, projectId: string): j is ProgressJob => j && j.projectId === projectId &&
  ['generation', 'refgen'].includes(j.source) && typeof j.id === 'string' && typeof j.status === 'string';
export function previewURL(projectId: string, job: ProgressJob, p: Preview) {
  const expected = `/api/jobs/${job.source}/${encodeURIComponent(job.id)}/preview?projectId=${encodeURIComponent(projectId)}&version=${p.version}`;
  return Number.isSafeInteger(p.version) && p.version > 0 && p.url === expected ? expected : null;
}
export function createProgressClient(projectId: string, options: Options = {}) {
  const doc = options.document ?? document;
  const makeSource = options.eventSource === undefined ? (typeof EventSource === 'undefined' ? null : (url: string) => new EventSource(url)) : options.eventSource;
  const poll = options.poll ?? (async (id, signal) => {
    const response = await fetch(`/api/jobs?projectId=${encodeURIComponent(id)}`, { signal, credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw Error('Status unavailable'); return response.json();
  });
  let rows = new Map<string, ProgressJob>(), limits = {}, tracker = {}, budget: unknown = undefined, epoch = '', seq = -1;
  let source: EventSource | null = null, timer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | null = null, generation = 0, disposed = false, started = false;
  let connection: 'connecting' | 'live' | 'polling' | 'stale' | 'hidden' = 'connecting';
  const listeners = new Set<() => void>();
  const emit = () => { for (const fn of listeners) { try { fn(); } catch { /* A surface cannot break the shared transport. */ } } };
  const snapshot = (): ProgressSnapshot => structuredClone({ jobs: [...rows.values()], limits, tracker, ...(budget ? { budget } : {}) });
  function stopTransport() {
    generation++; source?.close(); source = null; abort?.abort(); abort = null;
    clearTimeout(timer); clearTimeout(deadline);
  }
  function replace(data: ProgressSnapshot) {
    rows = new Map(data.jobs.filter(j => validJob(j, projectId)).map(j => [keyOf(j), j])); limits = data.limits; tracker = data.tracker;
    if (data.budget && typeof data.budget === 'object') budget = data.budget;
  }
  async function polling() {
    if (disposed || doc.hidden) return;
    const token = generation; abort = new AbortController();
    try {
      const data = await poll(projectId, abort.signal);
      if (token !== generation || disposed) return;
      if (!Array.isArray(data.jobs)) throw Error('Invalid snapshot');
      replace(data); connection = 'polling'; emit();
    } catch { if (token === generation && !disposed) { connection = 'stale'; emit(); } }
    if (token === generation && !disposed && !doc.hidden) timer = setTimeout(() => void polling(), [...rows.values()].some(j => !terminal.has(j.status)) ? 4000 : 20000);
  }
  function fallback() { stopTransport(); connection = 'polling'; emit(); void polling(); }
  function connect() {
    stopTransport(); if (disposed || doc.hidden) return;
    epoch = ''; seq = -1; connection = 'connecting'; emit();
    if (!makeSource) return fallback();
    try {
      const current = source = makeSource(`/api/jobs/stream?projectId=${encodeURIComponent(projectId)}`);
      deadline = setTimeout(() => { if (source === current && connection !== 'live') fallback(); }, 10000);
      for (const type of ['snapshot', 'job', 'remove', 'preview', 'budget']) current.addEventListener(type, event => {
        if (source !== current || disposed || doc.hidden) return;
        let data: any; try { data = JSON.parse((event as MessageEvent).data); } catch { return; }
        if (data.v !== 1 || data.projectId !== projectId || typeof data.epoch !== 'string' || !Number.isSafeInteger(data.seq) || data.seq < 0) return;
        if (type !== 'snapshot' && (!epoch || data.epoch !== epoch)) return connect();
        if (data.epoch === epoch && data.seq <= seq) return;
        if (type === 'snapshot') { if (!Array.isArray(data.jobs) || !data.limits || !data.tracker) return; replace(data); epoch = data.epoch; }
        else if (type === 'job') { if (!validJob(data.job, projectId)) return; rows.set(keyOf(data.job), data.job); }
        else if (type === 'budget') { if (!data.budget || typeof data.budget !== 'object') return; budget = data.budget; }
        else {
          if (!['generation', 'refgen'].includes(data.source) || typeof data.id !== 'string') return;
          const key = keyOf(data), row = rows.get(key);
          if (type === 'remove') rows.delete(key);
          else if (row?.live) rows.set(key, { ...row, live: { ...row.live, preview: data.preview && previewURL(projectId, row, data.preview) ? data.preview : null } });
        }
        seq = data.seq; connection = 'live'; clearTimeout(deadline); emit();
      });
      current.onerror = () => { if (source === current) fallback(); };
    } catch { fallback(); }
  }
  const visibility = () => { if (doc.hidden) { stopTransport(); connection = 'hidden'; emit(); } else connect(); };
  return {
    snapshot, connection: () => connection,
    subscribe(fn: () => void) {
      listeners.add(fn);
      if (!started) { started = true; doc.addEventListener('visibilitychange', visibility); if (doc.hidden) connection = 'hidden'; else connect(); }
      fn(); return () => listeners.delete(fn);
    },
    subscribeJob(sourceName: string, id: string, fn: (job: ProgressJob | undefined) => void) {
      return this.subscribe(() => fn(structuredClone(rows.get(`${sourceName}:${id}`))));
    },
    reconnect: connect,
    dispose() { disposed = true; stopTransport(); doc.removeEventListener('visibilitychange', visibility); listeners.clear(); },
  };
}
const shared = new Map<string, { client: ReturnType<typeof createProgressClient>; refs: number }>();
/** Each mounted surface acquires once and releases on teardown/project switch. */
export function acquireProgress(projectId: string, options?: Options) {
  let entry = shared.get(projectId);
  if (!entry) { entry = { client: createProgressClient(projectId, options), refs: 0 }; shared.set(projectId, entry); }
  entry.refs++; let released = false;
  return { client: entry.client, release() { if (released) return; released = true; if (--entry!.refs === 0) { entry!.client.dispose(); shared.delete(projectId); } } };
}

export function progressText(job: ProgressJob) {
  if (job.uncertain || ['uncertain', 'closed'].includes(job.status)) return 'Outcome unknown. Checking this request';
  if (job.status === 'completed') return 'Ready';
  if (job.status === 'failed') return 'Generation failed';
  if (job.status === 'cancelled' || job.status === 'invalidated') return 'Request closed';
  const phase = job.live?.phase;
  if (phase === 'collecting' || phase === 'done') return 'Saving results';
  if (phase === 'uploading') return 'Uploading reference images';
  // Observed execution wins over a stored 'queued' that the tracker has not refreshed yet.
  if (phase === 'queued' || (job.status === 'queued' && phase !== 'running')) return 'Waiting for a worker';
  if (phase === 'submitting') return 'Submitting request';
  return 'Generating';
}
/** A keyed child: never replaces host contents, selection, actions, or approved media. */
export function mountProgressView(host: HTMLElement, client: ReturnType<typeof createProgressClient>, source: string, id: string, label: string) {
  const doc = host.ownerDocument;
  const root = doc.createElement('section'); root.className = 'director-progress';
  const phase = doc.createElement('span'); phase.setAttribute('role', 'status'); phase.setAttribute('aria-live', 'polite');
  const detail = doc.createElement('span'); detail.className = 'dp-detail';
  const rail = doc.createElement('progress'); rail.className = 'dp-rail'; rail.setAttribute('aria-label', 'Current node work');
  const media = doc.createElement('div'); media.className = 'dp-media'; media.hidden = true;
  const caption = doc.createElement('span'); caption.className = 'dp-caption';
  root.append(media, caption, phase, detail, rail); host.append(root);
  let disposed = false, version = -1, serial = 0, controller: AbortController | null = null;
  let objectURL: string | null = null, lastJob: ProgressJob | undefined;
  let fadeTimer: ReturnType<typeof setTimeout> | undefined, retire: (() => void) | undefined;
  async function preview(job: ProgressJob) {
    const p = job.live?.preview, url = p && previewURL(job.projectId, job, p);
    if (!p || !url || p.version === version || doc.hidden) return;
    version = p.version; const token = ++serial; controller?.abort(); controller = new AbortController();
    let candidate: string | null = null;
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
      if (!response.ok || !['image/png', 'image/jpeg'].includes(response.headers.get('Content-Type') || '')) return;
      const blob = await response.blob(); if (blob.size > 256 * 1024) return;
      candidate = URL.createObjectURL(blob);
      const image = doc.createElement('img'); image.alt = `${label} — intermediate preview`; image.src = candidate;
      await image.decode();
      if (disposed || doc.hidden || token !== serial) return;
      clearTimeout(fadeTimer); retire?.();
      const old = media.lastElementChild, oldURL = objectURL; media.append(image); media.hidden = false;
      retire = () => { old?.remove(); if (oldURL) URL.revokeObjectURL(oldURL); retire = undefined; };
      fadeTimer = setTimeout(() => retire?.(), 160);
      objectURL = candidate; candidate = null; caption.textContent = 'Intermediate preview';
    } catch { /* An expired version or decode failure keeps the last decoded frame. */ }
    finally { if (candidate) URL.revokeObjectURL(candidate); }
  }
  function render(job: ProgressJob | undefined) {
    lastJob = job; root.hidden = !job; if (!job) { serial++; controller?.abort(); return; }
    const text = progressText(job); if (phase.textContent !== text) phase.textContent = text; // one polite region: a failure is read in turn, not over the user
    const node = job.live?.node;
    const measured = !terminal.has(job.status) && !job.uncertain && job.status !== 'uncertain' && job.live?.phase === 'running' &&
      node && Number.isFinite(node.value) && Number.isFinite(node.max) && node.value! >= 0 && node.max! > 0 && node.value! <= node.max!;
    rail.hidden = !measured;
    if (measured) { rail.max = node.max!; rail.value = node.value!; }
    const stale = ['stale', 'connecting'].includes(client.connection()) || job.live?.connection === 'stale';
    detail.textContent = stale ? 'Live updates paused · checking status' : measured ? `${node.label} · ${node.unit === 'step' ? 'step' : 'work'} ${node.value} of ${node.max}` : `${Math.max(0, Math.floor(Number(job.ageSeconds) || 0))}s elapsed`;
    caption.textContent = objectURL ? `Intermediate preview${stale && job.live ? ` · last observed ${job.live.observedAt}` : ''}` : 'Preview not available';
    void preview(job);
  }
  const visibility = () => { if (doc.hidden) { serial++; controller?.abort(); version = -1; } else if (lastJob) render(lastJob); };
  doc.addEventListener('visibilitychange', visibility);
  const unsubscribe = client.subscribeJob(source, id, render);
  return () => { disposed = true; serial++; controller?.abort(); clearTimeout(fadeTimer); retire?.(); unsubscribe(); doc.removeEventListener('visibilitychange', visibility); if (objectURL) URL.revokeObjectURL(objectURL); root.remove(); };
}

/** A self-contained keyed slot for surfaces that rebuild their DOM. The same element is reused while
 * it stays mounted (a rebuild just moves it, so the decoded preview never flashes) and it tears itself
 * down (view, subscription, lease) once it has left the document. It never touches the host's media,
 * selection or actions. `place` separates two surfaces showing the same job. */
const slots = new Map<string, HTMLElement>();
export function progressSlot(projectId: string, source: 'generation' | 'refgen', id: string, label: string, place = '', aspect?: string) {
  const key = `${projectId}:${source}:${id}:${place}`, existing = slots.get(key);
  if (existing) return existing;
  const el = document.createElement('div'); el.className = 'dp-slot';
  if (aspect) el.style.setProperty('--progress-aspect', aspect);
  const lease = acquireProgress(projectId), detach = mountProgressView(el, lease.client, source, id, label);
  slots.set(key, el);
  const born = Date.now(); let seen = false;
  const check = () => {
    if (el.isConnected) { seen = true; return; }
    if (!seen && Date.now() - born < 10000) return; // built but not inserted yet
    if (slots.get(key) === el) slots.delete(key);
    clearInterval(timer); detach(); lease.release();
  };
  const timer = setInterval(check, 2000);
  // Hosts insert synchronously; noting it now lets a view closed within the first tick be disposed on that tick.
  queueMicrotask(() => { if (el.isConnected) seen = true; });
  return el;
}
