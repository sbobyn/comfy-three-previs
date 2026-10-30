// Mobile layer (compact phones, medium tablets): app bar, Build · Shoot · Cut tab bar, bottom sheets.
// The same modules render everything; this file re-homes their elements and talks to director.ts through `host`.
import './director-mobile.css';
import { h, toast, shapeIcon } from './director-common';
import { SHAPES, MOVES, castRows, castCard, normalizeCast, objectLooks } from '../shared/director.mjs';
import type { DirectorProject, Shot, Entity } from '../shared/director.mjs';
import { KIND_COLORS } from '../shared/prompt.mjs';
import { snap } from '../shared/editor-controls.mjs';
import type { Selection, UndoEntry } from '../shared/editor-controls.mjs';
import { openJourney } from './director-guide';
import type { createDirectorScene } from './director-scene';
import type { createSequence, RowParts } from './director-sequence';
import { openSheet, actionSheet, confirmSheet, icon, openSheets, installSheetHistory } from './director-mobile-sheet';
import type { Sheet } from './director-mobile-sheet';
import { tierOf, QUERIES, reorderIndex, pickLabels, floorHit, LIFT_MS, SLOP } from './director-mobile-core';
import { installGestures } from './director-mobile-gestures';
import { openCameraMode } from './director-mobile-camera';

type Step = 'build' | 'shoot' | 'cut';
type Scene = ReturnType<typeof createDirectorScene>;
export type MobileHost = {
  app: HTMLElement; top: HTMLElement; wsBody: HTMLElement; stage: HTMLElement; viewport: HTMLElement; shotList: HTMLElement; outline: HTMLElement; filterInput: HTMLInputElement;
  shotPane: HTMLElement; objectPane: HTMLElement; readiness: HTMLElement; actionBar: HTMLElement; transport: { playBtn: HTMLElement; scrub: HTMLInputElement; timeOut: HTMLElement };
  modeSeg: HTMLElement; snapBtn: HTMLElement; coach: HTMLElement; labels: HTMLElement; titleInput: HTMLInputElement; undoBtn: HTMLButtonElement; redoBtn: HTMLButtonElement;
  sequence: ReturnType<typeof createSequence>; scene: Scene; selection: Selection;
  project(): DirectorProject; shot(): Shot; step(): Step; setStep(k: Step): void; selectShot(id: string): void; addShot(): Promise<void>; setView(v: 'set' | 'camera'): void; setSection(key: string, open: boolean): void;
  openRender(): void; openAssets(): Promise<void>; claudeDialog(): void; requestDelete(): void; frameSelected(): void; duplicateSelection(): Promise<void>; toggleHidden(id: string): void;
  entity(id: string | null): Entity | null; runEntry(e: UndoEntry): Promise<boolean>; edit(ops: unknown[]): Promise<unknown>; undo(): Promise<void>; redo(): Promise<void>;
};
export type MobileApi = { active(): boolean; onStep(k: Step): void; placeObject(pane: HTMLElement, id: string | null): void };
type Ext = { openAddSheet(x?: number, y?: number): void; objectActions(id: string): void; floor(x: number, y: number): [number, number, number] | null; theatre(): void };
export type MobileCtx = MobileHost & Ext;

const SEGS = [['story', 'Story'], ['cast', 'Cast'], ['camera', 'Camera'], ['video', 'Video']] as const;
const STEP_LABEL: Record<Step, string> = { build: 'Build', shoot: 'Shoot', cut: 'Cut' };
const pad = (n: number) => String(n).padStart(2, '0');

export function initMobile(host: MobileHost): MobileApi | null {
  const body = document.body;
  let t = tierOf(q => matchMedia(q));
  const setClasses = () => { body.classList.remove('m-compact', 'm-medium', 'm-short', 'm-touch'); body.classList.add(...t.classes); };
  setClasses();
  let reload = 0;
  for (const q of Object.values(QUERIES)) matchMedia(q).addEventListener('change', () => {
    const next = tierOf(x => matchMedia(x));
    if (!!next.tier !== !!t.tier) { clearTimeout(reload); reload = window.setTimeout(() => location.reload(), 300); return; } // desktop ⇄ mobile: rebuild from scratch
    t = next; setClasses();
  });
  if (!t.tier) return null;
  installSheetHistory();

  const P = () => host.project(), S = () => host.shot();
  const refUrl = (file: string) => `/director-refs/${P().id}/${file}`;
  let step: Step = 'build';

  // ---------- App bar ----------
  const sub = h('small', { class: 'm-sub' });
  const pipSlot = h('span', { class: 'm-pipslot' });
  const pip = host.top.querySelector('.jobs-pip'); if (pip) pipSlot.append(pip);
  const more = h('button', { class: 'm-ib m-more', type: 'button', 'aria-label': 'More actions', 'aria-haspopup': 'dialog', onclick: () => openMenu() }, icon('more'));
  const pickBtn = h('button', { class: 'm-ib m-pickbtn', type: 'button', 'aria-label': 'Select shots to generate', 'aria-pressed': 'false', onclick: () => setPicking(!picking) }, icon('check'));
  host.undoBtn.classList.add('m-undo');
  host.titleInput.classList.add('m-titlefield');
  const appbar = h('header', { class: 'm-appbar' }, h('div', { class: 'm-appbar-row' },
    h('a', { class: 'm-ib', href: '/', 'aria-label': 'All projects' }, icon('back')),
    h('label', { class: 'm-title' }, host.titleInput, sub), host.undoBtn, pipSlot, pickBtn, more));

  // ---------- Tab bar ----------
  const cutCount = h('i', { class: 'm-n' });
  const tabs = (['build', 'shoot', 'cut'] as Step[]).map(k => h('button', { type: 'button', role: 'tab', class: 'm-tab', 'data-step': k, 'aria-selected': 'false',
    onclick: () => { if (step === k) retap(k); else host.setStep(k); } }, icon(k), h('span', {}, STEP_LABEL[k]), k === 'cut' ? cutCount : null));
  const tabbar = h('nav', { class: 'm-tabbar', role: 'tablist', 'aria-label': 'Step' }, ...tabs);
  const stepPill = h('button', { class: 'm-steppill', type: 'button', 'aria-haspopup': 'dialog', onclick: () => openMenu(true) });
  function retap(k: Step) {
    if (k === 'build') host.frameSelected();
    else if (k === 'shoot') host.wsBody.scrollTo({ top: 0, behavior: 'smooth' });
    else host.sequence.el.querySelector('.sq-main')?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- Build: viewport overlays + shot strip ----------
  const fabScene = h('button', { class: 'm-fab scene', type: 'button', 'aria-label': 'Scene: every object', onclick: () => openScene() }, icon('list'));
  const fabAdd = h('button', { class: 'm-fab add', type: 'button', 'aria-label': 'Add an object', onclick: () => ext.openAddSheet() }, icon('plus'));
  const frameBtn = h('button', { class: 'm-fab frame', type: 'button', 'aria-label': 'Frame the selection, or everything', onclick: () => host.frameSelected() }, icon('frame'));
  const modebar = h('div', { class: 'm-modebar' }, host.modeSeg, host.snapBtn);
  host.viewport.append(h('div', { class: 'm-vpside' }, fabScene, fabAdd), frameBtn, modebar);
  const coachText = host.coach.children[1];
  coachText?.replaceChildren(h('b', {}, 'Drag'), ' to orbit · ', h('b', {}, 'pinch'), ' to zoom · ', h('b', {}, 'tap'), ' to select');
  const addCard = h('button', { class: 'shot m-addshot', type: 'button', 'aria-label': 'New shot', onclick: () => void host.addShot() }, h('span', { class: 'shot-frame' }, '+'), h('span', { class: 'info' }, h('span', { class: 'title' }, 'New shot')));
  const strip = h('div', { class: 'm-shotstrip' }, host.shotList);
  host.stage.after(strip);
  longPress(host.shotList, '.shot:not(.m-addshot)', el => shotActions(Array.from(host.shotList.querySelectorAll('.shot:not(.m-addshot)')).indexOf(el)));
  // Labels are buttons on touch: tap selects.
  host.labels.addEventListener('click', ev => { const id = (ev.target as HTMLElement).closest<HTMLElement>('.label')?.dataset.id; if (id) { host.selection.set([id], id); navigator.vibrate?.(8); } });

  // ---------- Shoot: transport, switcher, readiness, segmented panel, action bar ----------
  const transport = h('div', { class: 'm-transport' }, host.transport.playBtn, host.transport.scrub.parentElement!, host.transport.timeOut);
  host.viewport.after(transport);
  const swThumb = h('canvas', { width: 96, height: 54, 'aria-hidden': 'true' });
  const swNum = h('span', { class: 'm-sw-n mono' }), swTitle = h('span', { class: 'm-sw-t' });
  const switcher = h('button', { class: 'm-switch', type: 'button', 'aria-haspopup': 'dialog', 'aria-label': 'Choose shot', onclick: () => openShotList() }, swThumb, swNum, swTitle, icon('down'));
  const stepShot = (d: number) => { const list = P().shots, i = list.findIndex(s => s.id === S().id) + d; if (list[i]) host.selectShot(list[i].id); };
  const prev = h('button', { class: 'm-ib', type: 'button', 'aria-label': 'Previous shot', onclick: () => stepShot(-1) }, '‹');
  const next = h('button', { class: 'm-ib', type: 'button', 'aria-label': 'Next shot', onclick: () => stepShot(1) }, '›');
  let seg = localStorage.getItem('previs.m.seg') || 'camera';
  const segBtns = SEGS.map(([k, label]) => h('button', { type: 'button', role: 'radio', 'data-seg': k, 'aria-checked': 'false', onclick: () => { seg = k; localStorage.setItem('previs.m.seg', k); applySeg(); host.wsBody.scrollTo({ top: 0 }); } }, label));
  const segBar = h('div', { class: 'm-seg m-shootseg', role: 'radiogroup', 'aria-label': 'Shot panel' }, ...segBtns);
  const phoneCard = h('button', { class: 'm-flycard', type: 'button', onclick: () => void openCameraMode(ext) }, icon('phone'), h('span', {}, h('b', {}, 'This phone'), h('small', {}, 'Hold it like a camera to aim the shot')), icon('chev'));
  const shootBody = h('div', { class: 'm-shootbody' }, h('div', { class: 'm-switchrow' }, prev, switcher, next), host.readiness, segBar, host.shotPane);
  host.wsBody.append(shootBody);
  host.app.append(host.actionBar, tabbar, stepPill);
  host.app.prepend(appbar);
  host.readiness.addEventListener('click', ev => {
    const label = (ev.target as HTMLElement).closest('.rd')?.querySelector('.rd-label')?.textContent || '';
    const k = label === 'Cast' ? 'cast' : label === 'Blockout' ? 'camera' : label ? 'video' : '';
    if (k) { ev.stopImmediatePropagation(); seg = k; applySeg(); }
  }, true);
  function applySeg() {
    segBtns.forEach(b => { const on = b.dataset.seg === seg; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    host.shotPane.querySelectorAll<HTMLElement>(':scope > .sec').forEach(s => {
      const on = s.dataset.sec === seg || (seg === 'video' && s.dataset.sec === 'more');
      s.classList.toggle('m-on', on);
      if (on && (s.querySelector('.sec-body') as HTMLElement | null)?.hidden) host.setSection(s.dataset.sec!, true);
    });
    const cam = host.shotPane.querySelector('[data-sec="camera"] .sec-body');
    if (cam && cam.firstElementChild !== phoneCard) cam.prepend(phoneCard);
    castGrid();
  }
  new MutationObserver(() => applySeg()).observe(host.shotPane, { childList: true });

  // Cast segment: image-first cards instead of the cast rows.
  function castGrid() {
    const slot = host.shotPane.querySelector('[data-sec="cast"] .sec-body');
    if (!slot || slot.querySelector('.m-castgrid') || !P()) return;
    const p = P(), s = S(), ORDER = ['character', 'vehicle', 'prop', 'environment'];
    const rows = castRows(p, s);
    const described = (r: (typeof rows)[number]) => r.entity.kind !== 'environment' || !!castCard(p, r.entity.id)?.description || objectLooks(p, r.entity.id).length > 0;
    const inCast = rows.filter(r => r.inCast && described(r)).sort((a, b) => ORDER.indexOf(a.entity.kind) - ORDER.indexOf(b.entity.kind));
    const out = rows.filter(r => !r.inCast && r.entity.kind !== 'environment');
    const toggle = (r: (typeof rows)[number]) => {
      const before = normalizeCast(s.cast), nx = normalizeCast(s.cast), id = r.entity.id;
      nx.include = nx.include.filter(x => x !== id); nx.exclude = nx.exclude.filter(x => x !== id);
      if (r.inCast && r.auto) nx.exclude.push(id); else if (!r.inCast && !r.auto) nx.include.push(id);
      void host.runEntry({ label: r.inCast ? 'Remove from cast' : 'Add to cast', redo: [{ op: 'update_shot', id: s.id, patch: { cast: nx } }], undo: [{ op: 'update_shot', id: s.id, patch: { cast: before } }] });
    };
    const card = (r: (typeof rows)[number]) => {
      const e = r.entity, looks = objectLooks(p, e.id), look = looks[0], open = () => host.selection.set([e.id], e.id);
      const why = r.override === 'added' ? 'Added by you' : r.override === 'removed' ? 'Left out by you' : r.auto ? `${Math.round(r.coverage * 100)}% of frame${r.lead ? ' · subject' : ''}` : 'Not in frame';
      return h('div', { class: 'm-castcard' + (r.inCast ? '' : ' m-out'), style: `--k:${KIND_COLORS[e.kind]}` },
        h('button', { class: 'm-cc-img', type: 'button', 'aria-label': `Open ${e.name}` , onclick: open }, look ? h('img', { src: refUrl(look.file), alt: '', loading: 'lazy' }) : h('span', { class: 'm-cc-ph' }, shapeIcon(e.shape), 'No image yet')),
        h('button', { class: 'm-cc-tick' + (r.inCast ? ' on' : ''), type: 'button', role: 'checkbox', 'aria-checked': String(r.inCast), 'aria-label': `${e.name} in this shot`, onclick: () => toggle(r) }, icon('check')),
        h('i', { class: 'm-cc-kind', 'aria-hidden': 'true' }),
        h('div', { class: 'm-cc-meta' }, h('b', {}, e.name), h('span', {}, why, looks.length ? ` · ${looks.length} image${looks.length === 1 ? '' : 's'}` : '')),
        look ? null : h('button', { class: 'm-btn m-sm', type: 'button', onclick: open }, 'Generate'));
    };
    const looksBtn = slot.querySelector<HTMLElement>('.block-head .btn');
    slot.append(h('div', { class: 'm-castgrid' },
      h('div', { class: 'm-sechead' }, h('span', {}, `In this shot · ${inCast.length}`), looksBtn ? h('button', { class: 'm-link', type: 'button', onclick: () => looksBtn.click() }, 'Project style ›') : null),
      h('div', { class: 'm-cast-grid' }, ...inCast.map(card)),
      out.length ? h('div', { class: 'm-sechead' }, h('span', {}, 'Not in frame · tap ✓ to add')) : null,
      out.length ? h('div', { class: 'm-cast-grid' }, ...out.map(card)) : null));
  }

  // ---------- Cut: player above the list, compact rows, Shot sheet ----------
  const seq = host.sequence, parts = seq.parts;
  parts.board.parentElement!.prepend(parts.viewer);
  const exportBlock = parts.viewer.querySelector('.sq-export'); if (exportBlock) parts.board.after(exportBlock);
  const playSeq = parts.viewer.querySelector('.sq-playcut'); if (playSeq) { playSeq.classList.add('m-playfilm'); parts.toolbar.prepend(playSeq); }
  const missing = parts.toolbar.querySelector<HTMLElement>('button[title^="Capture the camera video"]'); if (missing) { missing.classList.add('m-missing'); parts.toolbar.after(missing); }
  playerBar(parts.viewer.querySelector<HTMLVideoElement>('.sq-screen > video:not(.sq-over)'));
  const rowParts = new Map<string, RowParts>();
  let shotSheet: { sheet: Sheet; id: string } | null = null, picking = false;
  function setPicking(on: boolean) { picking = on; pickBtn.setAttribute('aria-pressed', String(on)); pickBtn.classList.toggle('on', on); seq.el.classList.toggle('m-picking', on); }
  seq.mobile({ rowTemplate: cutRow });
  function cutRow(x: RowParts) {
    rowParts.set(x.s.id, x);
    const res = x.version.selectedOptions[0]?.textContent || 'Newest';
    const dot = (st: string[]) => h('span', { class: `m-st ${st[0]}` }, st[1]);
    const f = h('span', { class: 'm-cr-f' }, x.thumb, h('span', { class: 'm-cr-d mono' }, `${x.s.duration}s`));
    const grip = h('span', { class: 'm-cr-grip', role: 'button', 'aria-label': `Reorder shot ${x.i + 1}: press and hold, then drag` }, icon('grip'));
    const main = h('button', { class: 'm-cr-main', type: 'button', 'aria-label': `Shot ${x.i + 1} ${x.s.title}`, onclick: () => openShotSheet(x.s.id) },
      f, h('span', { class: 'm-cr-i' }, h('b', {}, `${pad(x.i + 1)} · ${x.s.title}`), h('span', { class: 'm-cr-st' }, dot(x.bState), x.inCut ? dot(x.gState) : h('span', { class: 'm-st none' }, 'Left out of the cut')), h('span', { class: 'm-chip' }, x.inCut ? res : 'Excluded', ' ⌄')), icon('chev'));
    const el = h('div', { class: 'm-cutrow' + (x.on ? ' on' : '') + (x.inCut ? '' : ' out'), role: 'listitem' }, x.pick, grip, main);
    dragReorder(el, grip, x);
    swipe(el, () => { x.include.click(); navigator.vibrate?.(8); toast(x.inCut ? `Shot ${pad(x.i + 1)} left out of the cut` : `Shot ${pad(x.i + 1)} back in the cut`); });
    if (shotSheet?.id === x.s.id && !shotSheet.sheet.closed()) queueMicrotask(() => fillShotSheet(x));
    return el;
  }
  function fillShotSheet(x: RowParts) {
    if (!shotSheet) return;
    shotSheet.sheet.setTitle(`Shot ${pad(x.i + 1)} · ${x.s.title}`);
    x.moveUp.replaceChildren('↑ Move earlier'); x.moveDown.replaceChildren('↓ Move later'); x.open.textContent = 'Open in Shoot';
    shotSheet.sheet.body.replaceChildren(
      h('label', { class: 'm-lab' }, 'Version in the cut', x.version),
      x.progress || '', // [live-progress] new-version progress, apart from the cut's version
      h('div', { class: 'm-row2' }, h('label', { class: 'm-lab' }, 'Trim in (s)', x.trimIn), h('label', { class: 'm-lab' }, 'Trim out (s)', x.trimOut)),
      h('div', { class: 'm-list' }, h('div', { class: 'm-lrow' }, h('span', {}, x.inCut ? 'In the cut' : 'Left out of the cut'), x.include)),
      h('div', { class: 'm-row2' }, x.moveUp, x.moveDown), x.open,
      parts.batch.hidden ? '' : parts.batch);
  }
  function openShotSheet(id: string) {
    rowParts.get(id)?.select();
    const x = rowParts.get(id); if (!x) return;
    shotSheet?.sheet.close();
    const sheet = openSheet({ title: '', kind: 'panel', detent: 'full', cls: 'm-shotsheet', onClose: () => { if (shotSheet?.sheet === sheet) shotSheet = null; if (!parts.batch.isConnected || parts.batch.closest('.m-sheet')) parts.board.before(parts.batch); } });
    shotSheet = { sheet, id }; fillShotSheet(x);
  }
  function dragReorder(row: HTMLElement, grip: HTMLElement, x: RowParts) {
    grip.addEventListener('pointerdown', ev => {
      ev.preventDefault(); grip.setPointerCapture(ev.pointerId);
      const y0 = ev.clientY; let lifted = false, dy = 0;
      const timer = setTimeout(() => { lifted = true; row.classList.add('m-lift'); navigator.vibrate?.(8); }, LIFT_MS);
      const move = (e: PointerEvent) => { dy = e.clientY - y0; if (lifted) row.style.transform = `translateY(${dy}px)`; else if (Math.abs(dy) > SLOP) clearTimeout(timer); };
      const up = () => {
        clearTimeout(timer); grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
        row.classList.remove('m-lift'); row.style.transform = '';
        if (!lifted) return;
        const to = reorderIndex(x.i, dy, row.getBoundingClientRect().height, x.count);
        if (to !== x.i) void x.reorder(x.i, to);
      };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    });
  }
  function swipe(row: HTMLElement, onLeft: () => void) {
    let s: { x: number; y: number } | null = null;
    row.addEventListener('pointerdown', ev => { if (ev.pointerType !== 'mouse' && !(ev.target as HTMLElement).closest('.m-cr-grip,input')) s = { x: ev.clientX, y: ev.clientY }; });
    row.addEventListener('pointermove', ev => { if (!s) return; const dx = ev.clientX - s.x; if (Math.abs(ev.clientY - s.y) > 24) { s = null; row.style.transform = ''; return; } if (dx < 0) row.style.transform = `translateX(${Math.max(-96, dx)}px)`; });
    const end = (ev: PointerEvent) => { if (!s) return; const dx = ev.clientX - s.x; s = null; row.style.transform = ''; if (dx < -72) onLeft(); };
    row.addEventListener('pointerup', end); row.addEventListener('pointercancel', () => { s = null; row.style.transform = ''; });
  }
  function playerBar(v: HTMLVideoElement | null) {
    if (!v) return;
    v.controls = false;
    const play = h('button', { class: 'm-pplay', type: 'button', 'aria-label': 'Play' }, icon('play'));
    const prog = h('input', { class: 'm-pprog', type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Position in the clip' });
    const time = h('span', { class: 'm-ptime mono' });
    play.onclick = () => { if (v.paused) void v.play().catch(() => {}); else v.pause(); };
    prog.oninput = () => { if (v.duration > 0) v.currentTime = (Number(prog.value) / 1000) * v.duration; };
    const sync = () => { prog.value = String(v.duration > 0 ? Math.round((v.currentTime / v.duration) * 1000) : 0); time.textContent = `${v.currentTime.toFixed(2)} / ${(v.duration || 0).toFixed(2)}`; play.setAttribute('aria-label', v.paused ? 'Play' : 'Pause'); play.classList.toggle('on', !v.paused); };
    for (const e of ['timeupdate', 'play', 'pause', 'loadedmetadata', 'emptied']) v.addEventListener(e, sync);
    v.parentElement!.append(h('div', { class: 'm-pbar' }, play, prog, time));
  }

  // ---------- Sheets: Scene, Add, Object ----------
  let sceneSheet: Sheet | null = null, objSheet: Sheet | null = null, addSheet: Sheet | null = null;
  const addBtn = (shape: string, at?: [number, number]) => h('button', { class: 'm-addbtn', type: 'button', onclick: () => { addSheet?.close(); sceneSheet?.close(); void addAt(shape, at); } }, shapeIcon(shape), h('span', {}, shape[0].toUpperCase() + shape.slice(1)));
  const shapes = () => Object.keys(SHAPES).filter(x => x !== 'group');
  function addGrid(at?: [number, number], all = false) {
    const quick = ['person', 'car', 'box', 'wall'].filter(s => s in SHAPES);
    const grid = h('div', { class: 'm-addgrid' }, ...(all ? shapes() : quick).map(s => addBtn(s, at)));
    if (!all) grid.append(h('button', { class: 'm-addbtn m-all', type: 'button', onclick: () => grid.replaceWith(addGrid(at, true)) }, h('span', {}, `All ${shapes().length} shapes ›`)));
    return grid;
  }
  function openScene() {
    if (sceneSheet && !sceneSheet.closed()) return;
    host.filterInput.classList.add('field');
    sceneSheet = openSheet({ title: 'Scene', kind: 'panel', detent: 'full', cls: 'm-scenesheet', body: [host.filterInput, h('div', { class: 'm-sechead' }, h('span', {}, 'Add')), addGrid(), host.outline], onClose: () => { sceneSheet = null; } });
  }
  async function addAt(shape: string, at?: [number, number]) {
    const pos = (at && ext.floor(at[0], at[1])) || host.scene.orbitTarget(), id = crypto.randomUUID();
    const ok = await host.runEntry({ label: `Add ${shape}`, redo: [{ op: 'add_entity', entity: { id, name: shape[0].toUpperCase() + shape.slice(1), shape, position: [snap(pos[0], 0.1), 0, snap(pos[2], 0.1)] } }], undo: [{ op: 'remove_entity', id }] });
    if (ok) host.selection.set([id], id);
  }
  const ext = Object.assign(Object.create(null) as MobileHost, host, {
    openAddSheet(x?: number, y?: number) { addSheet?.close(); addSheet = openSheet({ title: 'Add an object', kind: 'panel', detent: 'half', body: [addGrid(x != null && y != null ? [x, y] : undefined, true)], onClose: () => { addSheet = null; } }); },
    objectActions(id: string) {
      const e = host.entity(id); if (!e) return;
      host.selection.set([id], id);
      actionSheet(e.name, [
        { label: 'Frame', icon: 'frame', onPick: () => host.frameSelected() },
        { label: 'Duplicate', icon: 'dup', onPick: () => void host.duplicateSelection() },
        { label: 'Hide in the viewport', icon: 'eye', onPick: () => host.toggleHidden(id) },
        { label: 'Camera target of this shot', icon: 'target', disabled: S().camera.target === id, onPick: () => void host.runEntry({ label: 'Aim camera', redo: [{ op: 'update_shot', id: S().id, patch: { camera: { target: id } } }], undo: [{ op: 'update_shot', id: S().id, patch: { camera: { target: S().camera.target } } }] }) },
        { label: 'Delete…', icon: 'trash', destructive: true, onPick: () => host.requestDelete() },
      ]);
    },
    floor(x: number, y: number) {
      const c = host.viewport.querySelector('canvas.main')!.getBoundingClientRect();
      return floorHit(host.scene.worldView(), ((x - c.left) / c.width) * 2 - 1, -(((y - c.top) / c.height) * 2 - 1), c.width / Math.max(1, c.height));
    },
    theatre() { body.classList.toggle('m-theatre'); },
  });
  const objSummary = h('div', { class: 'm-numrow' });
  const hints = h('div', { class: 'm-ghint' },
    ...[['move', 'Drag it', 'moves on the floor'], ['twist', 'Twist', 'two fingers rotate'], ['pinch', 'Pinch', 'on it resizes']].map(([i, b, s]) => h('div', {}, icon(i), h('b', {}, b), h('span', {}, s))));
  const kindTag = h('span', { class: 'm-kind' });
  function placeObject(pane: HTMLElement, id: string | null) {
    body.classList.toggle('m-has-sel', !!id);
    if (!id) { if (objSheet) { const s = objSheet; objSheet = null; s.close(); } return; }
    const e = host.entity(id);
    pane.hidden = false;
    if (!objSheet || objSheet.closed()) {
      sceneSheet?.close();
      const seen = Number(localStorage.getItem('previs.m.gesturecoach') || 0); localStorage.setItem('previs.m.gesturecoach', String(seen + 1));
      hints.hidden = seen >= 3 || step !== 'build';
      const s = openSheet({ title: e?.name || 'Object', kind: 'panel', detent: 'half', cls: 'm-objsheet', aside: kindTag, body: [objSummary, hints, pane], onClose: () => { if (objSheet === s) { objSheet = null; host.selection.clear(); } } });
      objSheet = s;
    } else if (pane.parentElement !== objSheet.body) objSheet.body.append(pane);
    objSheet.setTitle(e?.name || 'Object');
    kindTag.textContent = e ? (e.shape === 'group' ? 'Group' : e.kind[0].toUpperCase() + e.kind.slice(1)) : '';
    const r = (n: number) => Math.round(n * 10) / 10;
    objSummary.replaceChildren(...(e && e.shape !== 'group' ? [['Position', e.position.map(r).join(', ')], ['Rotation', `${Math.round(e.rotation)}°`], ['Size', `${r(e.scale[0])}×`]] : []).map(([l, v]) =>
      h('button', { class: 'm-nf', type: 'button', onclick: () => { const d = pane.querySelector<HTMLDetailsElement>('.object-transforms'); if (d) { d.open = true; objSheet?.setDetent('full'); d.scrollIntoView({ block: 'start' }); } } }, h('span', {}, l), h('b', { class: 'mono' }, v))));
  }

  // ---------- Menus ----------
  function openMenu(withSteps = false) {
    const p = P();
    actionSheet(p?.title || 'Comfy Three Previs', [
      ...(withSteps ? (['build', 'shoot', 'cut'] as Step[]).map(k => ({ label: STEP_LABEL[k] + (k === step ? ' ✓' : ''), icon: k, onPick: () => host.setStep(k) })) : []),
      { label: 'Redo', icon: 'redo', disabled: host.redoBtn.disabled, onPick: () => void host.redo() },
      { label: 'Library', icon: 'library', onPick: () => void host.openAssets() },
      { label: 'Direct with Claude', icon: 'claude', onPick: () => host.claudeDialog() },
      { label: 'Use this phone as camera', icon: 'phone', onPick: () => void openCameraMode(ext) },
      ...(step === 'cut' && missing && !(missing as HTMLButtonElement).disabled ? [{ label: missing.textContent || 'Make missing blockouts', icon: 'cut', onPick: () => missing.click() }] : []),
      { label: 'Guide', icon: 'guide', onPick: () => openJourney() },
      { label: 'Rename project', icon: 'edit', onPick: () => { host.titleInput.focus(); host.titleInput.select(); } },
      { label: 'Export project (.zip)', icon: 'download', onPick: () => { if (p) location.href = `/api/director/export?id=${p.id}`; } },
      { label: 'Show tips again', icon: 'tips', onPick: () => { localStorage.removeItem('previs.coach.viewport'); localStorage.removeItem('previs.m.gesturecoach'); host.coach.hidden = false; } },
    ]);
  }
  function openShotList() {
    actionSheet('Shots', [...P().shots.map((s, i) => ({ label: `${pad(i + 1)} · ${s.title}${s.id === S().id ? ' ✓' : ''}`, icon: 'shoot', onPick: () => host.selectShot(s.id) })), { label: 'New shot', icon: 'plus', onPick: () => void host.addShot() }]);
  }
  function shotActions(i: number) {
    const s = P().shots[i]; if (!s) return;
    actionSheet(`Shot ${pad(i + 1)} · ${s.title}`, [
      { label: 'Open in Shoot', icon: 'shoot', onPick: () => { host.selectShot(s.id); host.setStep('shoot'); } },
      { label: 'Duplicate', icon: 'dup', onPick: () => { host.selectShot(s.id); void host.addShot(); } },
      { label: 'Delete…', icon: 'trash', destructive: true, disabled: P().shots.length < 2, onPick: () => void confirmSheet({ title: `Delete “${s.title}”?`, body: 'Its images stay on disk.', confirm: 'Delete shot', destructive: true }).then(ok => { if (ok) void host.edit([{ op: 'remove_shot', id: s.id }]).catch(() => {}); }) },
    ]);
  }
  function longPress(root: HTMLElement, sel: string, fire: (el: HTMLElement) => void) {
    let timer = 0, fired = false, start: { x: number; y: number } | null = null;
    root.addEventListener('pointerdown', ev => { const el = (ev.target as HTMLElement).closest<HTMLElement>(sel); if (!el) return; fired = false; start = { x: ev.clientX, y: ev.clientY }; timer = window.setTimeout(() => { fired = true; navigator.vibrate?.(8); fire(el); }, 450); });
    root.addEventListener('pointermove', ev => { if (start && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > SLOP) clearTimeout(timer); });
    for (const k of ['pointerup', 'pointercancel']) root.addEventListener(k, () => { clearTimeout(timer); start = null; });
    root.addEventListener('click', ev => { if (fired) { ev.preventDefault(); ev.stopImmediatePropagation(); fired = false; } }, true);
    root.addEventListener('contextmenu', ev => ev.preventDefault());
  }

  // ---------- Existing dialogs become full-screen task sheets ----------
  const TASK = 'dialog.render, dialog.jobs-sheet, dialog.assets, dialog.confirm, dialog.claude-help, dialog.looks, dialog.ds-dialog, dialog.editor, #journey-dialog, #phone-dialog, #connect-dialog';
  const markDialogs = () => document.querySelectorAll<HTMLElement>(TASK).forEach(d => {
    if (d.classList.contains('m-task')) return;
    d.classList.add('m-task');
    // Blockout capture on a phone defaults to 640×360 (the dialog offers both).
    if (body.classList.contains('m-compact')) d.querySelectorAll<HTMLInputElement>('dialog.render input[name="res"], .render-steps input[name="res"]')[1]?.click();
  });
  new MutationObserver(markDialogs).observe(body, { childList: true });
  markDialogs();

  // ---------- Live state ----------
  function refresh() {
    const p = P(); if (!p) return;
    const s = S(), i = p.shots.indexOf(s);
    if (host.shotList.lastElementChild !== addCard) host.shotList.append(addCard);
    host.shotList.querySelector('.shot.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const vids = (p.assets || []).filter(a => a.kind === 'workflow-result').length;
    cutCount.textContent = vids ? String(vids) : '';
    const total = p.shots.reduce((t, x) => t + x.duration, 0);
    sub.textContent = step === 'cut' ? `Cut · ${p.shots.length} shot${p.shots.length === 1 ? '' : 's'} · ${total.toFixed(1)} s` : `${STEP_LABEL[step]} · Shot ${pad(i + 1)} · ${s.title}`;
    stepPill.replaceChildren(STEP_LABEL[step], ' · ', `Shot ${pad(i + 1)}`, icon('down'));
    swNum.textContent = pad(i + 1); swTitle.textContent = s.title;
    (prev as HTMLButtonElement).disabled = i <= 0; (next as HTMLButtonElement).disabled = i >= p.shots.length - 1;
    const key = `${s.id}|${p.revision}`;
    if (swThumb.dataset.key !== key) { swThumb.dataset.key = key; requestAnimationFrame(() => { try { swThumb.getContext('2d')!.drawImage(host.scene.thumbnail(s, 96, 54), 0, 0); } catch {} }); }
    if (objSheet && host.selection.primary) placeObject(host.objectPane, host.selection.primary);
  }
  new MutationObserver(refresh).observe(host.shotList, { childList: true });
  // At most four labels on a phone (eight on a tablet): selection first, then characters, vehicles, props nearest the centre.
  setInterval(() => {
    if (document.hidden || step === 'cut' || !P()) return;
    const vr = host.viewport.getBoundingClientRect(), cx = vr.left + vr.width / 2, cy = vr.top + vr.height / 2;
    const items = Array.from(host.labels.children as HTMLCollectionOf<HTMLElement>).filter(l => l.style.display !== 'none').map(l => { const r = l.getBoundingClientRect(), e = host.entity(l.dataset.id || null); return { id: l.dataset.id || '', kind: e?.kind || 'prop', size: -Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy), selected: host.selection.has(l.dataset.id || '') }; });
    const keep = new Set(pickLabels(items, body.classList.contains('m-compact') ? 4 : 8));
    for (const l of Array.from(host.labels.children as HTMLCollectionOf<HTMLElement>)) l.classList.toggle('m-cap', !keep.has(l.dataset.id || ''));
  }, 250);
  addEventListener('keydown', ev => { if (ev.key === 'Escape' && (objSheet || sceneSheet || addSheet || shotSheet) && !document.querySelector('dialog[open]')) { ev.stopImmediatePropagation(); (shotSheet?.sheet || addSheet || sceneSheet || objSheet)!.close(); } }, true);

  installGestures(ext);
  if (import.meta.env.DEV || /[?&]mcheck\b/.test(location.search)) (window as unknown as { __mobile: unknown }).__mobile = {
    tier: () => t.tier, sheets: () => openSheets(), select: (id: string) => host.selection.set([id], id), clearSelection: () => host.selection.clear(), camera: () => openCameraMode(ext),
    screenOf(id: string) { const canvas = host.viewport.querySelector('canvas.main')!, r = canvas.getBoundingClientRect(); for (let y = r.top + 100; y < r.bottom - 20; y += 6) for (let x = r.left + 20; x < r.right - 140; x += 6) { if (document.elementFromPoint(x, y) === canvas && host.scene.pick(x, y) === id) return { x, y }; } return null; },
  };

  return {
    active: () => true,
    onStep(k) {
      const from = step; step = k; body.dataset.mstep = k;
      tabs.forEach(b => { const on = b.dataset.step === k; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
      host.stage.classList.toggle('m-frame', k === 'shoot');
      if (k !== from) { addSheet?.close(); sceneSheet?.close(); shotSheet?.sheet.close(); if (k === 'cut') objSheet?.close(); }
      if (k === 'build' && from === 'cut' && host.scene.view() === 'camera') host.setView('set');
      if (k === 'shoot') requestAnimationFrame(() => { applySeg(); host.wsBody.scrollTo({ top: 0 }); });
      if (k !== 'cut') setPicking(false);
      refresh();
    },
    placeObject,
  };
}
