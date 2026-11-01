// Take lab: compare a shot's takes side by side and pick the winner. Videos across models, seeds and settings play
// on one shared clock (play, pause, scrub, frame step), with the blockout as an optional reference lane; stills are
// compared within one moment against the blockout frame there. Each take is labelled with its model, settings,
// cost, inputs and grades (shared/takes.mjs). Picking a winner is one undoable edit; no take is ever removed.
import './director-takes.css';
import type { DirectorProject, Shot, Asset } from '../shared/director.mjs';
import { api, h, toast } from './director-common';
import { shotTakes, winnerOps, blockoutClips, takeDifferences } from '../shared/takes.mjs';
import type { Take, VideoTake, StillTake, TakeOptions, Grade, TakeGrades } from '../shared/takes.mjs';
import { CAMERA_SOURCE_LABELS } from '../shared/camera-source.mjs';
import { GRADER_PRICES } from '../shared/tiers.mjs';
import type { CameraSource } from '../shared/camera-source.mjs';
import { defaultPicks, togglePick, MAX_LANES, FPS, stepFrame, laneTime, gridColumns, timecode, costText, settingParts, gradeText, directionText, duration } from './director-takes-core';

export type TakeLabCtx = {
  project(): DirectorProject;
  runEntry(e: { label: string; redo: unknown[]; undo: unknown[] }): Promise<unknown>;
  assetUrl(a: Asset): string;
  refUrl(file: string): string;
};

const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const no = (p: DirectorProject, s: Shot) => String(p.shots.indexOf(s) + 1).padStart(2, '0');
const DIRECTION_USD = GRADER_PRICES.gemini; // one direction check books one grader charge (server/previs/take-grade.mjs)

/** Receipts, ledger and image prices for the labels; each is optional (a failed read only drops detail). */
async function loadExtras(projectId: string): Promise<TakeOptions> {
  const [gen, budget, refgen] = await Promise.all([
    api('generation').catch(() => ({ jobs: [] })),
    api(`budget?projectId=${encodeURIComponent(projectId)}`).catch(() => ({ reservations: [] })),
    api(`director/refgen?projectId=${encodeURIComponent(projectId)}`).catch(() => ({ jobs: [], presets: [] })),
  ]);
  return {
    jobs: gen.jobs || [], stillJobs: refgen.jobs || [],
    ledger: Object.fromEntries((budget.reservations || []).map((r: { id: string }) => [r.id, r])),
    prices: Object.fromEntries((refgen.presets || []).map((x: { id: string; pricing?: { usdPerImage?: number } }) => [x.id, x.pricing?.usdPerImage ?? null])),
  };
}

export async function openTakeLab(ctx: TakeLabCtx, shotId: string, initial?: 'video' | 'still') {
  document.getElementById('takes-dialog')?.remove();
  const P = () => ctx.project(), shot = () => P().shots.find(s => s.id === shotId) || null;
  if (!shot()) return;
  let extras: TakeOptions = {};
  // Direction checks run here land on the project at the server; until the workspace's next poll brings them in, overlay them.
  const checks = new Map<string, unknown>();
  const withChecks = (p: DirectorProject): DirectorProject => (checks.size ? { ...p, assets: (p.assets || []).map(a => (checks.has(a.id) && !a.checks?.direction ? { ...a, checks: { ...(a.checks || {}), direction: checks.get(a.id) as any } } : a)) } : p);
  const data = () => shotTakes(withChecks(P()), shot()!, extras);
  let kind: 'video' | 'still' = initial || (data().videos.length || !data().stills.length ? 'video' : 'still');
  let picked: string[] = defaultPicks(data().videos), moment = data().stills.find(m => m.key === '0.00')?.key || data().stills[0]?.key || '';
  let stillPicked: string[] = defaultPicks(data().stills.find(m => m.key === moment)?.takes || []);
  let showRef = localStorage.getItem('previs.takes.ref') !== '0', onlyDiff = false;

  // ---------- Shared clock ----------
  type Lane = { id: string; video: HTMLVideoElement | null; duration: number | null; ended: HTMLElement };
  let lanes: Lane[] = [], t = 0, playing = false, raf = 0, startedAt = 0, rate = 1, loop = false;
  const mediaCache = new Map<string, HTMLVideoElement | HTMLImageElement>();
  const longest = () => Math.max(0, ...lanes.map(l => (l.video && Number.isFinite(l.video.duration) ? l.video.duration : l.duration || 0)));
  const playBtn = h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Play all lanes' }, '▶ Play');
  const back = h('button', { class: 'btn sm icon', type: 'button', 'aria-label': 'Back one frame', title: 'Back one frame (←)' }, '◀');
  const fwd = h('button', { class: 'btn sm icon', type: 'button', 'aria-label': 'Forward one frame', title: 'Forward one frame (→)' }, '▶');
  const scrub = h('input', { class: 'tk-scrub', type: 'range', min: 0, max: 1, step: 1 / FPS, value: 0, 'aria-label': 'Position in every lane' });
  const clock = h('span', { class: 'tk-clock mono' }, timecode(0));
  const speed = h('select', { class: 'field sm tk-speed', 'aria-label': 'Playback speed' }, ...[1, 0.5, 0.25].map(r => h('option', { value: String(r) }, `${r}×`)));
  const loopBox = h('input', { type: 'checkbox' });
  const transport = h('div', { class: 'tk-transport', role: 'group', 'aria-label': 'Playback, all lanes together' }, back, playBtn, fwd, scrub, clock, speed, h('label', { class: 'tk-check' }, loopBox, 'Loop'));
  const paintClock = () => {
    const end = longest(); scrub.max = String(end || 1); scrub.value = String(Math.min(t, end));
    clock.textContent = timecode(t); scrub.setAttribute('aria-valuetext', `${timecode(t)} of ${end.toFixed(2)} s`);
    playBtn.textContent = playing ? '❚❚ Pause' : '▶ Play'; playBtn.setAttribute('aria-label', playing ? 'Pause all lanes' : 'Play all lanes');
  };
  /** Put every lane at shared time t: a shorter lane holds its last frame and says it ended. */
  function seekAll(time: number, tolerance = 0.5 / FPS) {
    t = Math.max(0, time);
    for (const l of lanes) {
      if (!l.video) continue;
      const d = Number.isFinite(l.video.duration) ? l.video.duration : l.duration, at = laneTime(t, d);
      l.ended.hidden = !at.ended;
      if (at.ended || (d && t >= d - 0.5 / FPS)) { if (!l.video.paused) l.video.pause(); if (Math.abs(l.video.currentTime - at.t) > 0.5 / FPS) l.video.currentTime = at.t; continue; }
      if (Math.abs(l.video.currentTime - at.t) > tolerance) l.video.currentTime = at.t;
      if (playing && l.video.paused) void l.video.play().catch(() => {});
    }
    paintClock();
  }
  function tick(now: number) {
    if (!playing) return;
    let next = ((now - startedAt) / 1000) * rate;
    const end = longest();
    if (end && next >= end) {
      if (loop) { startedAt = now; next = 0; for (const l of lanes) if (l.video) l.video.currentTime = laneTime(0, l.duration).t; }
      else { pause(); seekAll(end - 0.5 / FPS); return; }
    }
    seekAll(next, 2 / FPS);
    raf = requestAnimationFrame(tick);
  }
  function play() {
    if (!lanes.some(l => l.video)) return;
    if (t >= longest() - 1 / FPS) t = 0;
    playing = true; startedAt = performance.now() - (t * 1000) / rate;
    for (const l of lanes) if (l.video) l.video.playbackRate = rate;
    seekAll(t); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
  }
  function pause() { playing = false; cancelAnimationFrame(raf); for (const l of lanes) l.video?.pause(); paintClock(); }
  const step = (d: number) => { pause(); seekAll(stepFrame(t, d, longest())); };
  playBtn.onclick = () => (playing ? pause() : play());
  back.onclick = () => step(-1); fwd.onclick = () => step(1);
  scrub.oninput = () => { if (playing) pause(); seekAll(Number(scrub.value)); };
  speed.onchange = () => { rate = Number(speed.value) || 1; if (playing) { pause(); play(); } };
  loopBox.onchange = () => { loop = loopBox.checked; };

  // ---------- Layout ----------
  const kindSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Compare' });
  const clearBtn = h('button', { class: 'btn ghost sm', type: 'button', title: 'No winner: the cut plays the newest take again' }, 'Clear winner');
  const close = h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close takes' }, '✕');
  const picker = h('div', { class: 'tk-picker' });
  const tools = h('div', { class: 'tk-tools' });
  const lanesEl = h('div', { class: 'tk-lanes' });
  const status = h('p', { class: 'tk-status note', role: 'status' });
  const title = h('h2', { id: 'takes-title' });
  const dlg = h('dialog', { class: 'takes', id: 'takes-dialog', 'aria-labelledby': 'takes-title' },
    h('div', { class: 'dialog-head' }, title, kindSeg, clearBtn, close),
    h('div', { class: 'tk-body' }, picker, tools, transport, lanesEl, status,
      h('p', { class: 'note tk-foot' }, 'Every take is kept. The winner is what the Cut and film export play, and a newer take never replaces it. Grades say only what was measured: layout from the paid still grader, direction from the paid direction check (which way the subject faces and travels against the blockout, on request), timing from frame counts against the blockout; nothing judges identity yet.')));
  close.onclick = () => dlg.close();
  dlg.addEventListener('close', () => { pause(); for (const m of mediaCache.values()) if (m instanceof HTMLVideoElement) { m.removeAttribute('src'); m.load(); } dlg.remove(); });
  dlg.addEventListener('keydown', ev => {
    const el = ev.target as HTMLElement;
    if (kind !== 'video' || el.closest('select, textarea, summary, input:not([type="range"])')) return;
    if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && el !== scrub) { ev.preventDefault(); step(ev.key === 'ArrowLeft' ? -1 : 1); }
    if (ev.key === ' ' && !el.closest('button, input')) { ev.preventDefault(); playBtn.click(); }
  });

  const say = (text: string) => { status.textContent = text; };
  async function pickWinner(tk: Take) {
    const s = shot()!;
    if (tk.kind === 'video') {
      const { redo, undo, inCut } = winnerOps(P(), s, tk.id);
      if (await ctx.runEntry({ label: `Winner: shot ${no(P(), s)} ${tk.label}`, redo, undo }) === false) return;
      say(`${tk.label} · ${tk.model} is the winner.${inCut ? ' The cut plays it.' : ' This shot is left out of the cut.'}`);
    } else {
      const m = data().stills.find(x => x.key === tk.moment)!;
      if (await ctx.runEntry({ label: `Use still ${tk.label} · shot ${no(P(), s)}`, redo: [{ op: 'use_take', shotId: s.id, referenceId: tk.id }], undo: [{ op: 'use_take', shotId: s.id, referenceId: m.inUse }] }) === false) return;
      say(`${tk.label} is now the ${m.label.toLowerCase()} still; video models get it.`);
    }
    draw();
  }
  clearBtn.onclick = async () => {
    const s = shot()!, { redo, undo } = winnerOps(P(), s, null);
    if (await ctx.runEntry({ label: `Clear winner · shot ${no(P(), s)}`, redo, undo }) === false) return;
    say('No winner: the cut plays the newest take.'); draw();
  };

  // ---------- Lanes ----------
  function mediaFor(key: string, make: () => HTMLVideoElement | HTMLImageElement) {
    let m = mediaCache.get(key); if (!m) { m = make(); mediaCache.set(key, m); } return m;
  }
  const videoEl = (url: string, label: string) => { const v = h('video', { src: url, muted: true, playsinline: true, preload: 'auto', disablePictureInPicture: true, 'aria-label': label }); v.addEventListener('loadedmetadata', () => { seekAll(t); }); return v; };
  function gradeList(g: TakeGrades, tk: Take) {
    const items = ([['Layout', g.layout], ['Identity', g.identity], ['Timing', g.timing]] as const).map(([name, grade]: readonly [string, Grade]) => {
      const x = gradeText(grade);
      // What was measured gets its explanation; "not graded / not assessed" is explained once, in the footer.
      return h('li', { class: `tone-${x.tone}` }, h('span', { class: 'tk-gname' }, name), h('b', {}, x.value), x.detail && x.tone !== 'none' ? h('small', {}, x.detail) : null);
    });
    // Video takes: which way the subject faces and travels against the blockout (paid check, run on request).
    if (tk.kind === 'video') {
      const x = directionText(g.direction);
      const run = g.direction?.status === 'checked' ? null : h('button', { class: 'btn sm tk-dircheck', type: 'button', title: g.direction?.note || '', 'aria-label': `Check direction: ${tk.label}` }, `Check direction · $${DIRECTION_USD.toFixed(2)}`);
      if (run) run.onclick = () => void checkDirection(tk as VideoTake, run);
      items.push(h('li', { class: `tone-${x.tone} tk-dir` }, h('span', { class: 'tk-gname' }, 'Direction'), h('b', {}, x.value), x.tone !== 'none' ? h('small', {}, x.detail) : null, run));
    }
    return h('ul', { class: 'tk-grades', 'aria-label': 'Grades' }, ...items);
  }
  /** Run the paid direction check on one take, then redraw with its result and the ledger's amount. */
  async function checkDirection(tk: VideoTake, btn: HTMLButtonElement) {
    btn.disabled = true; btn.textContent = 'Checking…'; say(`Checking ${tk.label}’s direction against the blockout…`);
    try {
      const r = await api('director/grade-take', { projectId: P().id, assetId: tk.id, maxCostUsd: DIRECTION_USD });
      checks.set(tk.id, r.check); extras = await loadExtras(P().id);
      say(`${tk.label} direction: ${r.check.verdict}. ${r.check.why} (check ${r.cost.status === 'billed' ? '' : '≈ '}$${r.cost.usd.toFixed(3)})`); draw();
    } catch (e) { btn.disabled = false; btn.textContent = `Check direction · $${DIRECTION_USD.toFixed(2)}`; say(''); toast((e as Error).message); }
  }
  function fact(label: string, value: Node | string, key?: string, diffs?: Set<string>) {
    const differs = !!key && !!diffs?.has(key);
    if (onlyDiff && key && !differs) return null;
    return h('div', { class: differs ? 'diff' : '' }, h('dt', {}, label), h('dd', {}, value));
  }
  function lane(tk: Take, diffs: Set<string>) {
    const s = shot()!, isVideo = tk.kind === 'video';
    const name = `${tk.label} · ${tk.model}`;
    const media = isVideo
      ? mediaFor(tk.id, () => videoEl(ctx.assetUrl(P().assets!.find(a => a.id === tk.id)!), name))
      : mediaFor(tk.id, () => h('img', { src: ctx.refUrl((tk as StillTake).file), alt: `${name} still`, draggable: false }));
    const ended = h('span', { class: 'tk-ended', hidden: true }, 'Ended · holding last frame');
    if (media instanceof HTMLVideoElement) lanes.push({ id: tk.id, video: media, duration: (tk as VideoTake).media.duration, ended });
    const v = tk as VideoTake, settings = settingParts(tk, onlyDiff ? diffs : undefined);
    const settingsRow = settings.length ? h('span', { class: 'tk-chips' }, ...settings.map(p => h('span', { class: `tk-chip${diffs.has(p.key) ? ' diff' : ''}` }, p.text))) : onlyDiff ? null : 'Not recorded';
    const badges = [tk.winner ? h('span', { class: 'tk-badge win' }, isVideo ? '★ Winner' : '★ In use') : null, isVideo && v.inCut && !v.winner ? h('span', { class: 'tk-badge' }, 'In cut') : null, tk.stale ? h('span', { class: 'tk-badge warn', title: isVideo ? 'Made from an earlier blockout' : 'Made before the shot changed' }, 'Older blocking') : null];
    // The accessible name starts with the visible words (WCAG 2.5.3), then says which take.
    const winText = tk.winner ? (isVideo ? 'Winner' : 'In use') : isVideo ? 'Mark winner' : 'Use this still';
    const win = h('button', { class: `btn sm tk-win${tk.winner ? ' on' : ''}`, type: 'button', 'aria-pressed': String(tk.winner), disabled: tk.winner, 'aria-label': `${winText}: ${name}` }, tk.winner ? `★ ${winText}` : winText);
    win.onclick = () => void pickWinner(tk);
    return h('section', { class: 'tk-lane', 'aria-label': name },
      h('div', { class: 'tk-media' }, media, h('span', { class: 'tk-tag' }, tk.label), ended),
      h('div', { class: 'tk-card' },
        h('div', { class: 'tk-head' }, h('strong', {}, name), ...badges),
        h('dl', { class: 'tk-facts' },
          fact('Model', tk.model, 'model', diffs),
          settingsRow ? fact('Settings', settingsRow) : null,
          fact('Cost', costText(tk.cost)),
          fact('Inputs', tk.inputs.map(x => x.label).join(' · ') || 'Not recorded', 'inputs', diffs),
          isVideo ? fact('Camera', v.cameraSource ? CAMERA_SOURCE_LABELS[v.cameraSource as CameraSource] || v.cameraSource : 'Not recorded', 'cameraSource', diffs) : null,
          isVideo ? fact('Media', `${v.media.width ?? '?'}×${v.media.height ?? '?'} · ${v.media.fps ?? '?'} fps · ${v.media.frames ?? '?'} frames · ${v.media.duration == null ? '?' : v.media.duration.toFixed(2)} s`) : null,
          fact('Made', `${when(tk.createdAt)}${tk.elapsedSeconds != null ? ` · ran ${duration(tk.elapsedSeconds)}` : ''}`)),
        gradeList(tk.grades, tk),
        tk.prompt && (!onlyDiff || diffs.has('prompt')) ? h('details', { class: `tk-prompt${diffs.has('prompt') ? ' diff' : ''}` }, h('summary', {}, `Prompt · ${tk.promptLength} characters`), h('p', {}, tk.prompt)) : null,
        win));
  }
  /** The blockout as a reference lane: the clip the takes were made from, or (stills) its frame at the moment. */
  function refLane(takes: Take[]) {
    const p = P(), s = shot()!, clips = blockoutClips(p, s);
    const versions = [...new Set(takes.filter((x): x is VideoTake => x.kind === 'video').map(x => x.source?.assetId).filter(Boolean))] as string[];
    const a = (versions.length ? clips.find(c => c.id === versions[0]) : null) || (s.render ? clips.find(c => c.id === s.render!.assetId) : null) || clips[0];
    if (!a) return h('section', { class: 'tk-lane ref', 'aria-label': 'Blockout reference' }, h('div', { class: 'tk-media empty' }, h('span', {}, 'No blockout clip yet')));
    const m = data().stills.find(x => x.key === moment), at = kind === 'still' ? m?.t ?? 0 : null;
    const v = mediaFor(`ref:${a.id}:${kind}`, () => videoEl(ctx.assetUrl(a), `Blockout v${a.version ?? 1}`)) as HTMLVideoElement;
    const ended = h('span', { class: 'tk-ended', hidden: true }, 'Ended · holding last frame');
    if (at === null) lanes.push({ id: a.id, video: v, duration: a.duration, ended });
    else { const seek = () => { v.currentTime = laneTime(at, v.duration || a.duration).t; }; if (v.readyState >= 1) seek(); else v.addEventListener('loadedmetadata', seek, { once: true }); }
    const mixed = versions.length > 1;
    return h('section', { class: 'tk-lane ref', 'aria-label': 'Blockout reference' },
      h('div', { class: 'tk-media' }, v, h('span', { class: 'tk-tag ref' }, 'Blockout'), ended),
      h('div', { class: 'tk-card' }, h('div', { class: 'tk-head' }, h('strong', {}, `Blockout v${a.version ?? 1}`), mixed ? h('span', { class: 'tk-badge warn' }, 'Takes differ') : null),
        h('dl', { class: 'tk-facts' },
          fact('Role', at === null ? 'Reference: the camera every take should follow' : `Reference: the blockout frame at ${at.toFixed(2)} s`),
          fact('Media', `${a.width}×${a.height} · ${a.fps ?? '?'} fps · ${a.frameCount ?? '?'} frames · ${a.duration == null ? '?' : a.duration.toFixed(2)} s`),
          mixed ? fact('Note', 'The selected takes were made from different blockout versions; this is the first one’s.') : null)));
  }

  // ---------- Draw ----------
  function draw() {
    const p = P(), s = shot(); if (!s) { dlg.close(); return; }
    const d = data();
    title.textContent = `Takes · Shot ${no(p, s)} · ${s.title}`;
    kindSeg.replaceChildren(...(['video', 'still'] as const).map(k => h('button', { type: 'button', role: 'radio', 'aria-checked': String(kind === k), class: kind === k ? 'on' : '', onclick: () => { if (kind !== k) { pause(); kind = k; t = 0; say(''); draw(); dlg.querySelector('.tk-body')!.scrollTop = 0; } } }, k === 'video' ? `Videos · ${d.videos.length}` : `Stills · ${d.stills.reduce((n, m) => n + m.takes.length, 0)}`)));
    clearBtn.hidden = kind !== 'video' || !d.winner.video;
    transport.hidden = kind !== 'video';
    pause(); lanes = [];
    // The picker: every take of this kind (stills: of the chosen moment), ticked ones become lanes.
    const pool: Take[] = kind === 'video' ? d.videos : d.stills.find(m => m.key === moment)?.takes || [];
    const sel = kind === 'video' ? picked : stillPicked;
    const setSel = (next: string[]) => { if (kind === 'video') picked = next; else stillPicked = next; draw(); };
    const live = sel.filter(id => pool.some(x => x.id === id));
    const moments = kind === 'still' && d.stills.length > 1 ? h('div', { class: 'seg tk-moments', role: 'radiogroup', 'aria-label': 'Moment' }, ...d.stills.map(m => h('button', { type: 'button', role: 'radio', 'aria-checked': String(m.key === moment), class: m.key === moment ? 'on' : '', onclick: () => { moment = m.key; stillPicked = defaultPicks(m.takes); say(''); draw(); } }, `${m.label} · ${m.takes.length}`))) : null;
    picker.replaceChildren(
      h('div', { class: 'tk-picker-head' }, h('span', { class: 'eyebrow', id: 'takes-pick-label' }, `Choose up to ${MAX_LANES} takes to compare`), h('span', { class: 'note' }, `${live.length} of ${pool.length} selected`), moments),
      pool.length ? h('div', { class: 'tk-pool', role: 'group', 'aria-labelledby': 'takes-pick-label' }, ...[...pool].reverse().map(tk => {
        const on = live.includes(tk.id), box = h('input', { type: 'checkbox', checked: on, disabled: !on && live.length >= MAX_LANES, 'aria-label': `Compare ${tk.label} · ${tk.model}` });
        box.onchange = () => setSel(togglePick(live, tk.id));
        const thumb = tk.kind === 'video' ? h('video', { src: `${ctx.assetUrl(p.assets!.find(a => a.id === tk.id)!)}#t=${((tk.media.duration || 1) / 2).toFixed(2)}`, muted: true, preload: 'metadata', playsinline: true, 'aria-hidden': 'true', tabindex: -1 }) : h('img', { src: ctx.refUrl(tk.file), alt: '', loading: 'lazy' });
        return h('label', { class: `tk-pick${on ? ' on' : ''}` }, box, thumb,
          h('span', { class: 'tk-pick-t' }, h('b', {}, tk.label), ` ${tk.model}`),
          h('span', { class: 'tk-pick-s mono', title: costText(tk.cost) }, [tk.seed != null ? `seed ${tk.seed}` : '', tk.cost.usd != null ? `${tk.cost.status === 'billed' ? '' : '≈ '}$${tk.cost.usd.toFixed(2)}` : ''].filter(Boolean).join(' · ')),
          tk.winner ? h('span', { class: 'tk-badge win' }, tk.kind === 'video' ? '★ Winner' : '★ In use') : null);
      })) : h('p', { class: 'tk-empty' }, kind === 'video' ? 'No generated videos for this shot yet. Generate one in Shoot or Cut; every new video is kept here as a take.' : 'No stills for this shot yet. Make one in Shoot’s storyboard.'));
    const chosen = live.map(id => pool.find(x => x.id === id)!).filter(Boolean).sort((a, b) => a.number - b.number);
    const diffs = new Set(takeDifferences(chosen));
    const refBox = h('input', { type: 'checkbox', checked: showRef }), diffBox = h('input', { type: 'checkbox', checked: onlyDiff, disabled: chosen.length < 2 });
    refBox.onchange = () => { showRef = refBox.checked; localStorage.setItem('previs.takes.ref', showRef ? '1' : '0'); draw(); };
    diffBox.onchange = () => { onlyDiff = diffBox.checked; draw(); };
    tools.replaceChildren(...[
      h('label', { class: 'tk-check' }, refBox, kind === 'video' ? 'Blockout lane' : 'Blockout frame'),
      h('label', { class: 'tk-check', title: 'Show only what differs between the selected takes' }, diffBox, 'Only differences'),
      chosen.length > 1 ? h('span', { class: 'note' }, diffs.size ? `Differs: ${[...diffs].map(k => k.replace(/^settings\./, '').replace('cameraSource', 'camera').replace('source', 'blockout')).join(', ')}` : 'Same model, settings and inputs') : null,
      kind === 'video' ? h('span', { class: 'note tk-keys' }, 'Space play · ← → one frame') : null].filter((x): x is HTMLElement => !!x));
    const items = [...(showRef && pool.length ? [refLane(chosen)] : []), ...chosen.map(tk => lane(tk, diffs))];
    lanesEl.style.setProperty('--cols', String(gridColumns(items.length)));
    lanesEl.replaceChildren(...items);
    lanesEl.hidden = !items.length;
    seekAll(t);
  }

  document.body.append(dlg); draw(); dlg.showModal();
  extras = await loadExtras(P().id);
  if (dlg.isConnected) draw();
}
