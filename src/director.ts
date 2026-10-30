import './director.css';
import { SHAPES, MOVES, MAX_DURATION, ROLES, handleOf, cameraKeys, compilePrompt, describeCamera, focusPoint, objectLooks, lookPrompt, lookViews, shotCast, lookSource, videoReferences, castRows, castCard, normalizeCast, entityAt, upsertKey, removeKeys, sceneLength, MAX_SCENE_TIME, withDescendants, rootOf } from '../shared/director.mjs';
import type { DirectorProject, Shot, Entity, Reference, Vec3, Asset } from '../shared/director.mjs';
import { api, h, toast, claudeDialog as showClaudeDialog, shapeIcon, readFileBase64 } from './director-common';
import type { Connect } from './director-common';
import { createDirectorScene } from './director-scene';
import { captureShotVideo as captureVideo } from './director-capture';
import type { CaptureOptions } from './director-capture';
import { initOperate, operateBlock, fly } from './director-operate'; // [operate]
import type { FlyDevice } from './director-operate';
import { installPhoneDemo, openPhonePairing, phoneConnected } from './director-phone'; // [director-phone]
import { createSequence } from './director-sequence';
import { promptBlock, cameraStyleBlock } from './director-prompt';
import { objectColors, KIND_COLORS } from '../shared/prompt.mjs';
import { shotPrompt } from '../shared/prompt.mjs';
import { describeFrame, stillPrompt, stillReferences, STRONG_GUIDE_MODEL } from '../shared/still-match.mjs';
import { openLooksBoard, aspectFor } from './director-looks';
import { prepareShotVideo, videoChoices, referenceCapacity, plannedReferences } from './director-videogen';
import type { TransformChange } from './director-scene';
import { Selection, UndoStack, targetConsumesKey, recreateOps, snap } from '../shared/editor-controls.mjs';
import type { UndoEntry, ModalMode } from '../shared/editor-controls.mjs';
import { openJourney } from './director-guide';
import { initSheets, sheetSection } from './director-sheet'; // [designsheet]
import { moveHelp } from './director-camhelp'; // [camhelp]
import { mountJobsPip } from './director-jobs'; // [jobs]
import { progressSlot } from './director-progress'; // [live-progress]
import { mountExplainer, modelInputsDiagram, keyboardDiagram, gamepadDiagram, phoneDiagram } from './director-explain';
import { initMobile } from './director-mobile'; // [mobile]

const params = new URLSearchParams(location.search);
const projectId = params.get('project') || '';
const app = document.getElementById('app')!;
let project: DirectorProject;
let shotId = params.get('shot') || '';
let selected: string | null = null;
type Preset = { id: string; title: string; backend: 'cloud' | 'local'; note: string; maxRefs?: number; followsGuide?: 'strong' | 'weak'; pricing: { status: string; usdPerImage: number | null; creditsPerImage: number | null; rate?: string; source: string | null } };
let refgen: { presets: Preset[]; jobs: any[]; paidExecutionEnabled: boolean; cloudCredential: boolean } = { presets: [], jobs: [], paidExecutionEnabled: false, cloudCredential: false };
// Storyboard stills: cloud models that take the blockout guide, the ones that follow it best first.
let stillPresets: Preset[] = [];
const genForm: Record<string, { prompt: string; presetId: string; aspect: string; count: number; seed: number; checkpoint: string; view: string; edited: boolean; open?: boolean }> = {};
let connect: Connect = null;
let playhead = 0, playing = false, lastTick = 0;
const shot = (): Shot => project.shots.find(s => s.id === shotId) || project.shots[0];
const entity = (id: string | null) => project.scene.entities.find(e => e.id === id) || null;
const refUrl = (r: Reference) => `/director-refs/${project.id}/${r.file}`;
const assetUrl = (a: Asset) => `/director-assets/${project.id}/${a.file.replace(/^assets\//, '')}`;
const allRefs = () => project.shots.flatMap(s => s.references);
const fmt = (t: number) => `${t.toFixed(2)}s`;
const signature = (p: DirectorProject, s: Shot) => { const text = JSON.stringify([cameraKeys(s, p.scene.entities), s.duration, s.start || 0, p.scene.entities.filter(e => e.shape !== 'group').map(({ look, notes, name, styleNotes, lookFrom, parent, sheets, ...e }) => e), p.scene.environment.preset]); let x = 5381; for (let i = 0; i < text.length; i++) x = ((x << 5) + x + text.charCodeAt(i)) | 0; return (x >>> 0).toString(16); };

async function edit(ops: unknown[], quiet = false) {
  try { const r = await api('director/edit', { projectId, ops }); apply(r.project); return r; }
  catch (e) { if (!quiet) toast((e as Error).message, true); throw e; }
}

// ---------- Layout ----------
const titleInput = h('input', { 'aria-label': 'Project name', maxlength: 120 });
const pillSlot = h('span');
const claudeBtn = h('button', { class: 'btn ghost sm claude-btn', type: 'button', title: 'Direct this scene from Claude', onclick: () => claudeDialog() }, h('span', { class: 'claude-mark', 'aria-hidden': 'true' }, '✳'), 'Claude');
const claudeDialog = () => showClaudeDialog(connect, project);
const svgIcon = (paths: string) => { const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); el.setAttribute('viewBox', '0 0 20 20'); el.setAttribute('fill', 'none'); el.setAttribute('aria-hidden', 'true'); el.innerHTML = paths; return el; };
const ICON = {
  undo: '<path d="M7.5 5.5 4 9l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 9h7a4.5 4.5 0 0 1 0 9H9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  redo: '<path d="M12.5 5.5 16 9l-3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 9h-7a4.5 4.5 0 0 0 0 9H11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  library: '<rect x="3" y="3.5" width="5.5" height="5.5" rx="1.6" stroke="currentColor" stroke-width="1.5"/><rect x="11.5" y="3.5" width="5.5" height="5.5" rx="1.6" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="11.5" width="5.5" height="5.5" rx="1.6" stroke="currentColor" stroke-width="1.5"/><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1.6" stroke="currentColor" stroke-width="1.5"/>',
  eye: '<path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5Z" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="10" r="2.3" stroke="currentColor" stroke-width="1.5"/>',
  eyeOff: '<path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5Z" stroke="currentColor" stroke-width="1.5" opacity=".5"/><path d="M4 16 16 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};
// Preview and Generate live in the action bar pinned to the bottom of the right panel (Build and Shoot).
const previewBtn = h('button', { class: 'btn act-preview', type: 'button', title: 'Play the shot through the camera (Space)' }, '▶ Preview');
const renderBtn = h('button', { class: 'btn cta act-go', type: 'button', title: 'Make the blockout and generate this shot’s video' }, 'Generate video ▸');
const libraryBtn = h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Library', title: 'Library: every image, blockout, video and film in this project', onclick: () => void openAssets() }, svgIcon(ICON.library), h('span', { class: 'hide-md' }, 'Library'));
const undoBtn = h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Undo', onclick: () => void undo() }, svgIcon(ICON.undo));
const redoBtn = h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Redo', onclick: () => void redo() }, svgIcon(ICON.redo));
type Step = 'build' | 'shoot' | 'cut';
const stepBtn = (k: Step, label: string, tip: string) => h('button', { type: 'button', role: 'tab', class: 'step-btn', 'data-step': k, 'aria-selected': 'false', title: tip, onclick: () => setStep(k) }, h('span', { class: 'st-label' }, label), h('span', { class: 'st-count' }));
const stepBtns: Record<Step, HTMLElement> = {
  build: stepBtn('build', 'Build', 'Build the scene: arrange objects and give your cast images'),
  shoot: stepBtn('shoot', 'Shoot', 'Shoot the selected shot: frame the camera, fly it, generate its video'),
  cut: stepBtn('cut', 'Cut', 'Cut the film: every shot in order, choose videos, play and export'),
};
const modeSwitch = h('nav', { class: 'steps', role: 'tablist', 'aria-label': 'Step' }, stepBtns.build, h('i', { class: 'st-sep', 'aria-hidden': 'true' }), stepBtns.shoot, h('i', { class: 'st-sep', 'aria-hidden': 'true' }), stepBtns.cut);
function menuState(menu: HTMLElement, open: boolean, opener?: HTMLElement, focus = false) {
  menu.hidden = !open;
  opener?.setAttribute('aria-expanded', String(open));
  if (open && focus) menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}
function menuKeys(menu: HTMLElement, opener: HTMLElement) {
  opener.setAttribute('aria-haspopup', 'menu'); opener.setAttribute('aria-expanded', 'false');
  new MutationObserver(() => opener.setAttribute('aria-expanded', String(!menu.hidden))).observe(menu, { attributes: true, attributeFilter: ['hidden'] });
  opener.addEventListener('keydown', ev => { if (['ArrowDown', 'ArrowUp'].includes(ev.key)) { ev.preventDefault(); if (menu.hidden) opener.click(); const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')); (ev.key === 'ArrowUp' ? items.at(-1) : items[0])?.focus(); } });
  menu.addEventListener('keydown', ev => {
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')).filter(el => el.getClientRects().length);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); menuState(menu, false, opener); opener.focus(); return; }
    if (ev.key === 'Tab') { menuState(menu, false, opener); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) return;
    ev.preventDefault(); ev.stopPropagation();
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? items.length - 1 : (index + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items[next]?.focus();
  });
}
const helpMenu = h('div', { class: 'menu help-menu', hidden: true, role: 'menu' });
const helpMenuBtn = h('button', { class: 'btn ghost sm icon help-menu-btn', type: 'button', 'aria-label': 'Help', title: 'Guide and shortcuts', onclick: () => { menuState(helpMenu, helpMenu.hidden, helpMenuBtn, true); } }, '?');
helpMenu.append(
  h('button', { type: 'button', role: 'menuitem', onclick: () => { helpMenu.hidden = true; showJourney(); } }, h('strong', {}, 'Guide'), h('span', {}, 'The whole journey, scene to film')),
  h('button', { type: 'button', role: 'menuitem', onclick: () => { helpMenu.hidden = true; renderHelp(); helpCard.hidden = false; } }, h('strong', {}, 'Controls & shortcuts'), h('span', {}, 'Viewport, keys and grid · ?')),
  h('button', { type: 'button', role: 'menuitem', onclick: () => { helpMenu.hidden = true; localStorage.removeItem('previs.coach.viewport'); coach.hidden = false; } }, h('strong', {}, 'Show tips again'), h('span', {}, 'The first-run hints')));
const top = h('header', { class: 'ws-top' },
  h('div', { class: 'top-left' },
    h('a', { class: 'brand', href: '/', title: 'Comfy Three Previs · all projects', 'aria-label': 'Comfy Three Previs · all projects' }, h('span', { class: 'brand-mark' })),
    h('div', { class: 'crumbs' }, h('a', { href: '/', class: 'muted hide-md', style: 'text-decoration:none' }, 'Projects'), h('span', { class: 'sep hide-md' }, '/'), titleInput),
    h('div', { class: 'undo-group' }, undoBtn, redoBtn)),
  modeSwitch,
  h('div', { class: 'right' }, pillSlot, libraryBtn, h('div', { class: 'menu-wrap' }, helpMenuBtn, helpMenu)));
document.addEventListener('pointerdown', ev => { if (!helpMenu.hidden && !(ev.target as HTMLElement).closest?.('.menu-wrap')) helpMenu.hidden = true; });

const shotList = h('div', { class: 'shots', role: 'listbox', 'aria-label': 'Shots' });
const outline = h('div', { class: 'outline', 'aria-label': 'Scene objects' });
const addMenu = h('div', { class: 'add-menu', role: 'menu', hidden: true });
for (const shape of Object.keys(SHAPES).filter(x => x !== 'group')) addMenu.append(h('button', { type: 'button', role: 'menuitem', title: `Add ${shape}`, onclick: () => addObject(shape) }, shapeIcon(shape), shape));
let outlineFilter = '';
const filterInput = h('input', { class: 'tree-filter', type: 'search', placeholder: 'Filter', 'aria-label': 'Filter scene objects' });
filterInput.oninput = () => { outlineFilter = filterInput.value.trim().toLowerCase(); renderOutline(); };
const shotsSection = h('section', { class: 'rail-section rail-shots' },
  h('div', { class: 'rail-head' }, h('span', { class: 'eyebrow' }, 'Shots'), h('button', { class: 'btn ghost sm', type: 'button', title: 'Add a shot after this one', onclick: () => addShot() }, '+ Shot')),
  shotList);
const railSplit = h('div', { class: 'rail-split', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize shots and scene', tabindex: 0, title: 'Drag to resize · double-click to reset' });
const rail = h('aside', { class: 'rail' },
  shotsSection, railSplit,
  h('section', { class: 'rail-section rail-scene', style: 'flex:1' },
    h('div', { class: 'rail-head' }, h('span', { class: 'eyebrow' }, 'Scene'), filterInput, h('button', { class: 'btn ghost sm add-obj', type: 'button', title: 'Add an object (Shift+A)', 'aria-haspopup': 'true', onclick: () => { addMenu.hidden = !addMenu.hidden; } }, '+ Add ▾')),
    addMenu, outline));
{
  const saved = Number(localStorage.getItem('previs.shotsH'));
  if (saved) rail.style.setProperty('--shots-h', `${saved}px`);
  railSplit.onpointerdown = ev => {
    ev.preventDefault(); railSplit.setPointerCapture(ev.pointerId); railSplit.classList.add('active');
    const move = (e: PointerEvent) => { const r = rail.getBoundingClientRect(); const v = Math.round(Math.max(90, Math.min(r.height - 160, e.clientY - r.top - 40))); rail.style.setProperty('--shots-h', `${v}px`); localStorage.setItem('previs.shotsH', String(v)); };
    const end = () => { railSplit.classList.remove('active'); railSplit.removeEventListener('pointermove', move); railSplit.removeEventListener('pointerup', end); };
    railSplit.addEventListener('pointermove', move); railSplit.addEventListener('pointerup', end);
  };
  railSplit.ondblclick = () => { rail.style.removeProperty('--shots-h'); localStorage.removeItem('previs.shotsH'); };
}

const canvas = h('canvas', { class: 'main', 'aria-label': 'Scene viewport. Drag objects to arrange; drag empty space to orbit.' });
const labels = h('div', { class: 'labels' });
const monLabel = h('div', { class: 'mon-label' });
const monitor = h('div', { class: 'monitor', title: 'Click to look through the shot camera (C)', role: 'button', tabindex: 0 }, h('div', { class: 'mon-box' }, h('div', { class: 'thirds' }), h('div', { class: 'rec' }, h('i'), 'SHOT CAM'), monLabel));
monitor.style.background = 'transparent';
const frameLabel = h('div', { class: 'mon-label' });
const camFrame = h('div', { class: 'cam-frame', hidden: true }, h('div', { class: 'thirds' }), frameLabel);
const viewSeg = h('div', { class: 'seg on-stage vp-view', role: 'tablist', 'aria-label': 'View' });
const setBtn = h('button', { type: 'button', class: 'on', title: 'Free view of the whole set (Esc)', onclick: () => setView('set') }, 'Director view');
const camBtn = h('button', { type: 'button', title: 'Look through the shot camera (C)', onclick: () => setView('camera') }, 'Shot camera');
viewSeg.append(setBtn, camBtn);
const inspector = h('div', { class: 'inspector', hidden: true });
const modeSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Transform tool' });
const modeButtons = (['translate', 'rotate', 'scale'] as ModalMode[]).map(m => h('button', { type: 'button', role: 'radio', title: m === 'translate' ? 'Move (gizmo) · G for modal move' : m === 'rotate' ? 'Rotate (gizmo) · R for modal rotate' : 'Resize (gizmo) · S for modal resize', onclick: () => setTransformMode(m) }, m === 'translate' ? 'Move' : m === 'rotate' ? 'Rotate' : 'Resize'));
modeSeg.append(...modeButtons);
const snapBtn = h('button', { class: 'btn sm', type: 'button', 'aria-pressed': 'false', title: 'Snap movement to grid (hold Ctrl to invert)' }, 'Snap');
const hud = h('div', { class: 'modal-hud', hidden: true, role: 'status' });
const helpCard = h('div', { class: 'help-card', hidden: true, role: 'dialog', 'aria-label': 'Viewport controls' });
const addPopup = h('div', { class: 'add-popup', hidden: true, role: 'menu', 'aria-label': 'Add object' });
const dropHint = h('div', { class: 'drop-hint', hidden: true }, 'Drop an image on an object to add it as that object’s look');
const monToggle = h('button', { class: 'mon-toggle', type: 'button', 'aria-pressed': 'true', title: 'Show or hide the shot monitor' });
const coach = h('div', { class: 'coach', role: 'note', hidden: localStorage.getItem('previs.coach.viewport') === '1' },
  h('span', { class: 'coach-dot', 'aria-hidden': 'true' }),
  h('span', {}, h('b', {}, 'Drag'), ' to orbit · ', h('b', {}, 'click'), ' to select · ', h('b', {}, 'right-click'), ' to add', h('span', { class: 'coach-more' }, ' · ', h('b', {}, 'C'), ' for the shot camera')),
  h('button', { class: 'btn sm', type: 'button', onclick: () => { coach.hidden = true; localStorage.setItem('previs.coach.viewport', '1'); } }, 'Got it'));
const firstRun = h('div', { class: 'first-run', hidden: true });
const helpToggle = h('button', { class: 'btn sm help-toggle', type: 'button', title: 'Controls & shortcuts (?)', 'aria-label': 'Controls & shortcuts', 'aria-expanded': 'false', onclick: () => { if (helpCard.hidden) renderHelp(); helpCard.hidden = !helpCard.hidden; } }, '?');
new MutationObserver(() => helpToggle.setAttribute('aria-expanded', String(!helpCard.hidden))).observe(helpCard, { attributes: true, attributeFilter: ['hidden'] });
const viewport = h('div', { class: 'viewport' }, canvas, labels, camFrame, monitor, monToggle, viewSeg,
  h('div', { class: 'vp-tools' }, modeSeg, snapBtn, h('button', { class: 'btn sm', type: 'button', onclick: () => frameSelected(), title: 'Frame selected, or everything (F, . or Numpad .)' }, 'Frame'), helpToggle),
  dropHint, hud, helpCard, addPopup, coach, firstRun);
const playBtn = h('button', { class: 'btn sm icon', type: 'button', 'aria-label': 'Play' }, '▶');
const scrub = h('input', { type: 'range', min: 0, max: 3, step: 0.01, value: 0, 'aria-label': 'Playhead' });
const timeOut = h('span', { class: 'time' });
const moveChip = h('span', { class: 'movechip' });
const keyTrack = h('div', { class: 'keytrack', 'aria-label': 'Keyframes of the selection' });
const scrubWrap = h('div', { class: 'scrubwrap' }, scrub, keyTrack);
const keyBtn = h('button', { class: 'btn ghost sm icon', type: 'button', 'data-tip': 'Insert keyframe', 'data-keys': 'I', 'aria-label': 'Insert keyframe for the selection', onclick: () => insertKeys() }, '◆');
const prevKeyBtn = h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Previous keyframe', title: 'Previous keyframe', onclick: () => jumpKey(-1) }, '‹◆');
const nextKeyBtn = h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Next keyframe', title: 'Next keyframe', onclick: () => jumpKey(1) }, '◆›');
// Hero: fly the shot camera live (keyboard, gamepad or phone) with the Operate flow.
const flyBtn = h('button', { class: 'fly-btn', type: 'button' });
const flyDevice = h('button', { class: 'fly-device', type: 'button', 'aria-haspopup': 'true', title: 'Choose what flies the camera' });
const flyMenu = h('div', { class: 'menu fly-menu', hidden: true, role: 'menu' });
const flyPhoneSlot = h('div', { class: 'fly-phone' });
const flyGroup = h('div', { class: 'fly' }, flyBtn, flyDevice);
const stage = h('section', { class: 'stage' }, viewport, h('div', { class: 'transport' }, playBtn, timeOut, h('div', { class: 'kf-nav' }, prevKeyBtn, keyBtn, nextKeyBtn), scrubWrap, moveChip, flyGroup), flyMenu);

const shotPane = h('div', { class: 'pane shotpane' });
const objectPane = h('div', { class: 'pane shotpane objectpane', hidden: true });
const readiness = h('div', { class: 'ready', role: 'status', 'aria-label': 'Shot readiness' });
const actHint = h('div', { class: 'act-hint', 'aria-live': 'polite' });
const actionBar = h('div', { class: 'side-act', role: 'toolbar', 'aria-label': 'Shot actions' }, actHint, h('div', { class: 'act-btns' }, previewBtn, renderBtn));
const side = h('aside', { class: 'side' }, h('div', { class: 'side-head' }, readiness), h('div', { class: 'side-body', style: 'min-height:0;display:grid' }, shotPane, objectPane), actionBar);
const wsBody = h('div', { class: 'ws-body' }, rail, stage, side);
// Sequence view (src/director-sequence.ts) shares the top bar and replaces the workspace body.
const sequence = createSequence({
  project: () => project, apply: p => apply(p), runEntry: async e => { await runEntry(e); }, signature, assetUrl,
  thumbnail: (s, w, hh) => scene.thumbnail(s, w, hh),
  prompt: s => shotPrompt(project, s, 'video'),
  capture: (s, o) => captureShotVideo(s, { width: 1280, height: 720, prompt: shotPrompt(project, s, 'video'), ...o }),
  openShot: id => { selectShot(id); setStep('shoot'); },
});
let wsMode: 'scene' | 'sequence' = 'scene';
let step: Step = 'build';
function setMode(m: typeof wsMode) {
  wsMode = m; wsBody.hidden = m !== 'scene';
  if (m === 'sequence') togglePlay(false);
  void sequence.show(m === 'sequence');
}
/** Build · Shoot · Cut. Build and Shoot share the scene workspace; Shoot looks through the shot camera and opens Camera/Video. */
function setStep(k: Step) {
  const from = step; step = k;
  setMode(k === 'cut' ? 'sequence' : 'scene');
  mobile?.onStep(k);
  for (const [key, b] of Object.entries(stepBtns)) { b.classList.toggle('on', key === k); b.setAttribute('aria-selected', String(key === k)); }
  wsBody.classList.toggle('shooting', k === 'shoot');
  if (k === 'shoot') {
    setView('camera');
    if (collapsed.side) setCollapsed('side', false);
    openSection('camera'); openSection('video');
    if (!mobile?.active()) requestAnimationFrame(() => shotPane.querySelector('[data-sec="camera"]')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }));
  } else if (k === 'build' && from === 'shoot') setView('set');
  const q = new URLSearchParams(location.search); if (k === 'build') q.delete('view'); else q.set('view', k === 'cut' ? 'sequence' : 'shoot'); history.replaceState(null, '', `?${q}`);
}
app.replaceChildren(top, wsBody, sequence.el);

function showJourney() {
  if (!project) { toast('Wait for the project to finish loading.'); return; }
  openJourney({
    context: `${project.title} · ${project.scene.entities.length} objects · ${project.shots.length} shots · ${project.assets?.length || 0} saved video assets.`,
    actions: {
      build: () => { setStep('build'); if (collapsed.side) setCollapsed('side', false); stepBtns.build.focus(); },
      cast: () => openLooks(),
      shoot: () => { setStep('shoot'); stepBtns.shoot.focus(); },
      generate: () => { setStep('shoot'); openRender(); },
      cut: () => { setStep('cut'); stepBtns.cut.focus(); },
    },
  });
}

// Draggable panel edges. Widths persist; double-click resets; arrows nudge when focused.
const PANEL = { rail: { key: 'previs.railW', min: 168, max: 440, edge: 'right' as const }, side: { key: 'previs.sideW', min: 260, max: 620, edge: 'left' as const } };
function setPanelWidth(which: keyof typeof PANEL, width: number | null) {
  const cfg = PANEL[which], prop = which === 'rail' ? '--rail-w' : '--side-w';
  if (width === null) { wsBody.style.removeProperty(prop); localStorage.removeItem(cfg.key); return; }
  const other = which === 'rail' ? side.getBoundingClientRect().width : rail.getBoundingClientRect().width;
  const room = wsBody.getBoundingClientRect().width - other - 320; // keep the viewport usable
  const w = Math.round(Math.max(cfg.min, Math.min(cfg.max, room, width)));
  wsBody.style.setProperty(prop, `${w}px`); localStorage.setItem(cfg.key, String(w));
}
for (const which of ['rail', 'side'] as const) {
  const panel = which === 'rail' ? rail : side, cfg = PANEL[which];
  const handle = h('div', { class: `resizer ${cfg.edge}`, role: 'separator', 'aria-orientation': 'vertical', 'aria-label': which === 'rail' ? 'Resize shots and scene panel' : 'Resize direction panel', tabindex: 0, title: 'Drag to resize · double-click to reset' });
  handle.onpointerdown = ev => {
    ev.preventDefault(); handle.setPointerCapture(ev.pointerId); handle.classList.add('active'); wsBody.classList.add('resizing');
    const move = (e: PointerEvent) => { const r = panel.getBoundingClientRect(); setPanelWidth(which, cfg.edge === 'right' ? e.clientX - r.left : r.right - e.clientX); };
    const end = () => { handle.classList.remove('active'); wsBody.classList.remove('resizing'); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end);
  };
  handle.ondblclick = () => setPanelWidth(which, null);
  handle.onkeydown = ev => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    const grow = (ev.key === 'ArrowRight') === (cfg.edge === 'right');
    setPanelWidth(which, panel.getBoundingClientRect().width + (grow ? 16 : -16));
  };
  panel.append(handle);
  const saved = Number(localStorage.getItem(cfg.key));
  if (saved) wsBody.style.setProperty(which === 'rail' ? '--rail-w' : '--side-w', `${saved}px`);
}

// Collapsible panels with toolbar toggles (Cmd/Ctrl+B left, Alt+Cmd/Ctrl+B right).
const isMac = /Mac|iPhone|iPad/i.test(navigator.platform);
const chord = (alt: boolean) => isMac ? `${alt ? '⌥' : ''}⌘B` : `Ctrl+${alt ? 'Alt+' : ''}B`;
function panelIcon(which: 'rail' | 'side') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('fill', 'none'); svg.setAttribute('aria-hidden', 'true');
  const x = which === 'rail' ? 3.5 : 12.5;
  svg.innerHTML = `<rect x="2.75" y="3.75" width="14.5" height="12.5" rx="3" stroke="currentColor" stroke-width="1.5"/><rect class="pane-fill" x="${x}" y="4.5" width="4" height="11" rx="1.4" fill="currentColor"/><path d="M${which === 'rail' ? 7.75 : 12.25} 4v12" stroke="currentColor" stroke-width="1.5"/>`;
  return svg;
}
function toggleButton(which: 'rail' | 'side') {
  const label = which === 'rail' ? 'Toggle shots & scene panel' : 'Toggle shot panel';
  return h('button', { class: 'btn ghost sm icon panel-toggle', type: 'button', 'aria-label': label, 'data-tip': label, 'data-keys': chord(which === 'side'), onclick: () => setCollapsed(which, !collapsed[which]) }, panelIcon(which));
}
const collapsed = { rail: localStorage.getItem('previs.railCollapsed') === '1', side: localStorage.getItem('previs.sideCollapsed') === '1' };
const railToggle = toggleButton('rail'), sideToggle = toggleButton('side');
top.querySelector('.brand')!.after(railToggle);
top.querySelector('.right')!.append(sideToggle);
function setCollapsed(which: 'rail' | 'side', on: boolean) {
  collapsed[which] = on;
  localStorage.setItem(which === 'rail' ? 'previs.railCollapsed' : 'previs.sideCollapsed', on ? '1' : '0');
  wsBody.classList.toggle(`${which}-collapsed`, on);
  (which === 'rail' ? rail : side).toggleAttribute('inert', on);
  const btn = which === 'rail' ? railToggle : sideToggle;
  btn.setAttribute('aria-pressed', String(!on)); btn.classList.toggle('off', on);
}
setCollapsed('rail', collapsed.rail); setCollapsed('side', collapsed.side);
document.addEventListener('keydown', ev => {
  if (!(ev.metaKey || ev.ctrlKey) || ev.key.toLowerCase() !== 'b' || ev.shiftKey) return;
  ev.preventDefault();
  const which = ev.altKey ? 'side' : 'rail';
  setCollapsed(which, !collapsed[which]);
}, { capture: true });

const scene = createDirectorScene(canvas, labels, monitor, camFrame, {
  onClickSelect(id, mode) {
    if (!id) { if (mode === 'replace') selection.clear(); return; }
    // Groups: the first click picks the outermost group; clicking again inside it steps one level in.
    const chain: string[] = []; for (let e = entity(id); e && chain.length < 32; e = e.parent ? entity(e.parent) : null) chain.push(e.id);
    const k = chain.findIndex(x => selection.has(x));
    id = k > 0 ? chain[k - 1] : k === 0 ? id : chain.at(-1)!;
    if (mode === 'add') selection.add(id); else if (mode === 'toggle') selection.toggle(id); else selection.set([id], id);
    // Move only the orbit pivot; framing remains an explicit action.
    if (mode === 'replace' && selection.has(id) && scene.view() === 'set') scene.pivotOn(id);
    if (selection.ids.length) openObject();
  },
  onMarquee(ids) { selection.addMany(ids); if (selection.ids.length) openObject(); },
  onContextMenu(x, y) { openAddPopup(x, y); },
  onTransformCommit(changes, label) { void commitTransforms(changes, label); },
  onModal(text) { hud.hidden = !text; hud.textContent = text || ''; },
  onRefImage(id) { const look = objectLooks(project, id)[0]; if (look) return refUrl(look); const own = shot()?.references.find(r => r.entityId === id && r.role !== 'style') || allRefs().find(r => r.entityId === id && r.role !== 'style'); return own ? refUrl(own) : null; },
});
// [operate] Live camera operating (gamepad / keyboard / phone) in the Shot tab.
initOperate({ scene, viewport, project: () => project, shot, setView, runEntry, toast, setPlayhead(t) { playing = false; playhead = t; scene.setPlayhead(t); renderTransport(); } });
const selection = new Selection();
const undoStack = new UndoStack();
initSheets({ projectId, project: () => project, apply: p => apply(p), refgen: () => refgen, loadRefgen: () => loadRefgen() }); // [designsheet]
// [jobs-pip] mount point
mountJobsPip(top.querySelector<HTMLElement>('.right')!, { projectId, api, shots: () => project.shots, onOpenShot: id => { selectShot(id); setStep('shoot'); } }); // [jobs] status-bar pip + panel
const mobile = initMobile({ // [mobile] compact/medium layout; no-op on desktop widths
  app, top, wsBody, stage, viewport, shotList, outline, filterInput, shotPane, objectPane, readiness, actionBar, transport: { playBtn, scrub, timeOut }, modeSeg, snapBtn, coach, labels, titleInput, undoBtn, redoBtn,
  sequence, scene, selection, project: () => project, shot, step: () => step, setStep, selectShot, addShot, setView, setSection, openRender, openAssets, claudeDialog, requestDelete, frameSelected, duplicateSelection, toggleHidden, entity, runEntry, edit, undo, redo,
});
selection.subscribe(sel => { selected = sel.primary; viewport.classList.toggle('has-sel', sel.ids.length > 0); scene.setSelection(sel.ids, sel.primary); scene.setOutlineColor(colorOf(sel.primary)); renderOutline(); renderInspector(); renderObjectPane(); placeObjectPane(); highlightPrompt(selected); renderKeyTrack(); });

// ---------- Rendering ----------
function apply(next: DirectorProject) {
  project = next;
  if (!project.shots.some(s => s.id === shotId)) shotId = project.shots[0].id;
  selection.retain(new Set(project.scene.entities.map(e => e.id)));
  if (document.activeElement !== titleInput) titleInput.value = project.title;
  titleInput.title = project.title;
  document.title = `${project.title} · Comfy Three Previs`;
  scrub.max = String(shot().duration);
  if (playhead > shot().duration) playhead = shot().duration;
  scene.sync(project, shot());
  renderShots(); renderOutline(); renderInspector(); renderShotPane(); renderObjectPane(); renderTransport(); renderSteps(); renderReadiness(); renderFirstRun();
  history.replaceState(null, '', `?project=${project.id}&shot=${shotId}${step === 'cut' ? '&view=sequence' : step === 'shoot' ? '&view=shoot' : ''}`);
  placeObjectPane(); sequence.refresh(); looksBoard?.refresh();
}

const shotVideos = (id: string) => (project.assets || []).filter(a => a.kind === 'workflow-result' && a.shotId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
/** grey = blockout only, amber = scene changed since the blockout, green = a generated video exists. */
function shotState(s: Shot): { pip: 'none' | 'changed' | 'video'; label: string } {
  const stale = !!(s.render && s.render.signature && s.render.signature !== signature(project, s));
  const vids = shotVideos(s.id).length;
  if (stale) return { pip: 'changed', label: vids ? 'Scene changed since this shot’s video' : 'Scene changed since the blockout' };
  if (vids) return { pip: 'video', label: `${vids} video${vids === 1 ? '' : 's'} generated` };
  return { pip: 'none', label: s.render ? 'Blockout ready · no video yet' : 'Blockout only · no video yet' };
}
function renderShots() {
  shotList.replaceChildren(...project.shots.map((s, i) => {
    const st = shotState(s), video = shotVideos(s.id)[0];
    const c = h('canvas', { width: 176, height: 99 });
    const thumb = video ? (video.mime.startsWith('video/') ? h('video', { class: 'thumb', src: `${assetUrl(video)}#t=0.4`, muted: true, playsinline: true, preload: 'metadata', 'aria-hidden': 'true' }) : h('img', { class: 'thumb', src: assetUrl(video), alt: '' })) : c;
    const b = h('button', { class: 'shot' + (s.id === shotId ? ' active' : ''), type: 'button', role: 'option', 'aria-selected': String(s.id === shotId), title: `${s.title} · ${st.label}`, onclick: () => selectShot(s.id) },
      h('span', { class: 'shot-frame' }, thumb, h('span', { class: 'shot-dur' }, `${s.duration}s`), video ? h('span', { class: 'shot-vid', 'aria-hidden': 'true' }, '▶') : null),
      h('span', { class: 'info' },
        h('span', { class: 'num' }, h('i', { class: `pip ${st.pip}`, 'aria-label': st.label }), String(i + 1).padStart(2, '0')),
        h('span', { class: 'title' }, s.title),
        h('span', { class: 'sub' }, MOVES[s.camera.move])));
    if (!video) requestAnimationFrame(() => { try { c.getContext('2d')!.drawImage(scene.thumbnail(s, 176, 99, signature(project, s)), 0, 0); } catch {} });
    return b;
  }));
}

const openGroups = new Set<string>(JSON.parse(localStorage.getItem(`previs.open.${projectId}`) || '[]'));
const hiddenObjs = new Set<string>(JSON.parse(localStorage.getItem(`previs.hidden.${projectId}`) || '[]'));
function applyHidden() { scene.setHidden(withDescendants(project.scene.entities, [...hiddenObjs].filter(id => entity(id)))); }
function toggleHidden(id: string) { if (hiddenObjs.has(id)) hiddenObjs.delete(id); else hiddenObjs.add(id); localStorage.setItem(`previs.hidden.${projectId}`, JSON.stringify([...hiddenObjs])); applyHidden(); renderOutline(); }
function toggleGroup(id: string) { if (openGroups.has(id)) openGroups.delete(id); else openGroups.add(id); localStorage.setItem(`previs.open.${projectId}`, JSON.stringify([...openGroups])); renderOutline(); }
function renderOutline() {
  const all = project.scene.entities, ids = new Set(all.map(e => e.id));
  const kids = (pid: string) => all.filter(e => e.parent === pid);
  const roots = all.filter(e => !e.parent || !ids.has(e.parent));
  // Filter: matching objects plus the groups that hold them.
  const match = (e: Entity) => !outlineFilter || e.name.toLowerCase().includes(outlineFilter) || e.kind.includes(outlineFilter);
  const visible = new Set<string>();
  for (const e of all) if (match(e)) for (let x: Entity | null = e; x && !visible.has(x.id); x = x.parent ? entity(x.parent) : null) visible.add(x.id);
  // Selected objects inside a closed group open their path, so the selection is always visible.
  for (const sid of selection.ids) for (let e = entity(sid); e?.parent; e = entity(e.parent)) openGroups.add(e.parent);
  const groups: Record<string, Entity[]> = { character: [], vehicle: [], prop: [], environment: [] };
  for (const e of roots) (groups[e.kind] ||= []).push(e);
  outline.replaceChildren();
  if (!all.length) outline.append(h('p', { class: 'note', style: 'padding:6px' }, 'Empty stage. Use + Add, or ask Claude to build the scene.'));
  else if (!visible.size) outline.append(h('p', { class: 'note', style: 'padding:6px' }, `Nothing matches “${outlineFilter}”.`));
  const row = (e: Entity, depth: number): Node[] => {
    if (!visible.has(e.id)) return [];
    const children = kids(e.id), open = openGroups.has(e.id) || (!!outlineFilter && children.some(c => visible.has(c.id)));
    const off = hiddenObjs.has(e.id);
    const ref = objectLooks(project, e.id)[0] || allRefs().find(r => r.entityId === e.id && r.role !== 'style');
    const btn = h('button', { class: 'obj' + (selection.has(e.id) ? ' active' : '') + (children.length ? ' parent' : '') + (off ? ' off' : ''), 'data-id': e.id, title: e.name, type: 'button', style: `--depth:${depth};--k:${KIND_COLORS[e.kind]}`, onclick: (ev: MouseEvent) => { if (ev.shiftKey || ev.ctrlKey || ev.metaKey) selection.toggle(e.id); else { selection.set([e.id], e.id); if (scene.view() === 'set') scene.pivotOn(e.id); } if (selection.ids.length) openObject(); }, ondblclick: () => scene.focusOn(e) },
      children.length ? h('span', { class: 'twisty' + (open ? ' open' : ''), role: 'button', 'aria-label': open ? 'Collapse' : 'Expand', onclick: (ev: MouseEvent) => { ev.stopPropagation(); toggleGroup(e.id); } }, '›') : h('span', { class: 'twisty none' }),
      e.shape === 'group' ? h('span', { class: 'sw grp' }) : h('span', { class: 'sw', style: `background:${e.color}` }),
      h('span', { class: 'name' }, e.name),
      children.length ? h('span', { class: 'count' }, String(withDescendants(all, [e.id]).length - 1)) : null,
      e.id === shot().camera.target ? h('span', { class: 'tgt', title: 'Camera target' }, '◎') : null,
      ref ? h('img', { class: 'refdot', src: refUrl(ref), alt: '', title: `Image: ${ref.name}` }) : null,
      h('span', { class: 'eye', role: 'button', tabindex: -1, 'aria-label': off ? `Show ${e.name}` : `Hide ${e.name}`, title: off ? 'Show in the viewport' : 'Hide in the viewport (the blockout still includes it)', onclick: (ev: MouseEvent) => { ev.stopPropagation(); toggleHidden(e.id); } }, svgIcon(off ? ICON.eyeOff : ICON.eye)));
    return [btn, ...(open ? children.flatMap(c => row(c, depth + 1)) : [])];
  };
  for (const [kind, list] of Object.entries(groups)) {
    if (!list.some(e => visible.has(e.id))) continue;
    outline.append(h('div', { class: 'group', style: `--k:${KIND_COLORS[kind]}` }, kind === 'character' ? 'Characters' : kind === 'vehicle' ? 'Vehicles' : kind === 'prop' ? 'Props' : 'Environment'));
    for (const e of list) outline.append(...row(e, 0));
  }
}
/** Group the selection under a new empty (Ctrl/Cmd+G); ungroup a selected group (Shift+Ctrl/Cmd+G). */
async function groupSelection() {
  const list = selection.ids.map(id => entity(id)).filter(Boolean) as Entity[];
  if (list.length < 1) return;
  const id = crypto.randomUUID(), name = list.length === 1 ? `${list[0].name} group` : 'Group';
  const ok = await runEntry({ label: `Group ${list.length} objects`, redo: [{ op: 'group', id, ids: list.map(e => e.id), name }], undo: [{ op: 'ungroup', id }] });
  if (ok) { openGroups.delete(id); selection.set([id], id); toast('Grouped. Click the group name to rename it.'); }
}
async function ungroupSelection() {
  const g = entity(selected); if (!g || g.shape !== 'group') return;
  const members = project.scene.entities.filter(e => e.parent === g.id).map(e => e.id);
  const ok = await runEntry({ label: `Ungroup ${g.name}`, redo: [{ op: 'ungroup', id: g.id }], undo: [{ op: 'group', id: g.id, ids: members, name: g.name }] });
  if (ok) selection.set(members, members[0] ?? null);
}

pillSlot.append(claudeBtn);
const textIfChanged = (el: HTMLElement, value: string) => { if (el.textContent !== value) el.textContent = value; };
monLabel.append(h('span'), h('span')); frameLabel.append(h('span'), h('span'));
function renderTransport() {
  const s = shot();
  scrub.value = String(playhead);
  textIfChanged(timeOut, `${fmt(playhead)} / ${fmt(s.duration)}${s.start ? ` · scene ${fmt((s.start || 0) + playhead)}` : ''}`);
  textIfChanged(moveChip, describeCamera(s, project.scene.entities));
  textIfChanged(playBtn, playing ? '❚❚' : '▶');
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play'); playBtn.title = playing ? 'Pause' : 'Play';
  const pv = playing ? '❚❚ Pause' : '▶ Preview'; if (previewBtn.textContent !== pv) previewBtn.textContent = pv;
  renderKeyTrack();
  const label = `SHOT ${String(project.shots.indexOf(s) + 1).padStart(2, '0')} · ${MOVES[s.camera.move]} · ${Math.round(scene.pose().mm)}mm`;
  textIfChanged(monLabel.children[0] as HTMLElement, label); textIfChanged(monLabel.children[1] as HTMLElement, fmt(playhead));
  textIfChanged(frameLabel.children[0] as HTMLElement, label); textIfChanged(frameLabel.children[1] as HTMLElement, `${fmt(playhead)} / ${fmt(s.duration)}`);
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** Number field: type to preview, Enter/blur commits, Esc reverts; drag up/down to scrub (Shift fine, Ctrl snaps). */
function numberField(label: string, value: number, opts: { rate: number; snapTo: number; min?: number; max?: number; unit?: string; onPreview(v: number): void; onCommit(v: number, from: number): void }) {
  const clamp = (v: number) => Math.min(opts.max ?? Infinity, Math.max(opts.min ?? -Infinity, v));
  const input = h('input', { class: 'num', value: String(r3(value)), 'aria-label': label, inputmode: 'decimal', title: `${label}: drag up/down to scrub · Shift fine · Ctrl snap` });
  let origin = value;
  input.onfocus = () => { origin = Number(input.value); input.select(); };
  input.oninput = () => { const v = Number(input.value); if (Number.isFinite(v)) opts.onPreview(clamp(v)); };
  input.onkeydown = ev => { if (ev.key === 'Enter') input.blur(); else if (ev.key === 'Escape') { input.value = String(r3(origin)); opts.onPreview(origin); input.blur(); } };
  input.onblur = () => { const v = clamp(Number(input.value)); if (Number.isFinite(v) && v !== origin) opts.onCommit(v, origin); else input.value = String(r3(origin)); };
  input.onpointerdown = ev => {
    if (document.activeElement === input) return;
    ev.preventDefault();
    const y0 = ev.clientY, from = Number(input.value); let moved = false, current = from;
    const move = (e: PointerEvent) => {
      const dy = y0 - e.clientY; if (!moved && Math.abs(dy) < 3) return; moved = true;
      let v = from + dy * opts.rate * (e.shiftKey ? 0.1 : 1); if (e.ctrlKey || e.metaKey) v = snap(v, opts.snapTo);
      current = clamp(r3(v)); input.value = String(current); opts.onPreview(current);
    };
    const upH = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', upH); if (moved) { if (current !== from) opts.onCommit(current, from); } else input.focus(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', upH);
  };
  return h('label', { class: 'numfield' }, h('span', {}, label), input, opts.unit ? h('small', {}, opts.unit) : null);
}
function renderInspector() {
  const ids = selection.ids;
  const e = entity(selection.primary);
  inspector.hidden = !e;
  if (!e) return;
  const key = ids.join(',') + '|' + project.revision;
  if (inspector.contains(document.activeElement) && inspector.dataset.key?.split('|')[0] === ids.join(',')) return;
  inspector.dataset.key = key;
  if (ids.length > 1) {
    inspector.replaceChildren(
      h('div', { class: 'head' }, h('strong', { style: 'flex:1' }, `${ids.length} objects selected`), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Deselect', onclick: () => selection.clear() }, '✕')),
      h('p', { class: 'note', style: 'margin:0' }, `Primary: ${e.name}. G/R/S or the gizmo move them together.`),
      h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => frameSelected() }, 'Frame'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => void duplicateSelection() }, 'Duplicate'),
        h('span', { style: 'flex:1' }),
        h('button', { class: 'btn sm', type: 'button', onclick: () => requestDelete() }, 'Delete…')));
    return;
  }
  const patchUndo = (patch: Partial<Entity>, before: Partial<Entity>, label: string) => void runEntry({ label, redo: [{ op: 'update_entity', id: e.id, patch }], undo: [{ op: 'update_entity', id: e.id, patch: before }] });
  const name = h('input', { class: 'field', value: e.name, 'aria-label': 'Object name', maxlength: 60 });
  name.onchange = () => patchUndo({ name: name.value }, { name: e.name }, 'Rename');
  const kind = h('select', { class: 'field', 'aria-label': 'Type' }, ...['character', 'vehicle', 'prop', 'environment'].map(k => h('option', { value: k, selected: k === e.kind }, k)));
  kind.onchange = () => patchUndo({ kind: kind.value as Entity['kind'] }, { kind: e.kind }, 'Change type');
  const color = h('input', { type: 'color', value: e.color, 'aria-label': 'Colour' });
  color.onchange = () => patchUndo({ color: color.value }, { color: e.color }, 'Change colour');
  const live = () => scene.sync(project, shot());
  const now = scene.sceneTime(), animated = Boolean(e.path?.length), shown = animated ? entityAt(e, now).position : e.position;
  const pos = (i: number, l: string) => numberField(l, shown[i], { rate: 0.01, snapTo: 1, unit: 'm',
    onPreview: v => { if (animated) return; const p = [...e.position] as Vec3; p[i] = v; e.position = p; live(); },
    onCommit: (v, from) => {
      const p = [...shown] as Vec3; p[i] = v;
      if (animated) return patchUndo({ path: upsertKey(e.path, now, p) }, { path: structuredClone(e.path) }, 'Move waypoint');
      const b = [...e.position] as Vec3; b[i] = from; patchUndo({ position: p }, { position: b }, 'Move');
    } });
  const keysLabel = animated ? `${e.path!.length} key${e.path!.length === 1 ? '' : 's'} · ${e.path![0].t}–${e.path!.at(-1)!.t}s · ${e.path!.some(k => Number.isFinite(k.r)) ? 'keyed facing' : 'faces travel'}` : 'Not animated';
  const motionRow = h('div', { class: 'motion-row' }, h('span', { class: 'xyz-l' }, 'Motion'), h('span', { class: 'muted', style: 'flex:1;font-size:11.5px' }, keysLabel),
    h('button', { class: 'btn sm', type: 'button', title: `Insert keyframe at scene time ${now.toFixed(2)}s (I)`, onclick: () => insertKeys([e.id]) }, `◆ Key @ ${now.toFixed(1)}s`),
    animated && e.path!.some(k => Math.abs(k.t - now) <= 0.005) ? h('button', { class: 'btn sm ghost', type: 'button', title: 'Delete the keyframe at the playhead (Alt+I)', onclick: () => deleteKeysHere([e.id]) }, 'Delete key') : null,
    animated ? h('button', { class: 'btn sm ghost', type: 'button', title: e.path!.some(k => Number.isFinite(k.r)) ? 'Facing is keyed' : 'Faces its direction of travel', onclick: () => { const a = entityAt(e, now); patchUndo({ path: upsertKey(e.path, now, a.position, a.rotation, e.path!.some(k => Array.isArray(k.s)) ? a.scale : undefined) }, { path: structuredClone(e.path) }, 'Key facing'); } }, 'Key facing') : null,
    animated ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => patchUndo({ path: null, position: [...shown] }, { path: structuredClone(e.path), position: e.position }, 'Clear motion') }, 'Clear') : null);
  const scl = (i: number, l: string) => numberField(l, e.scale[i], { rate: 0.01, snapTo: 0.1, min: 0.05, max: 50, unit: '×',
    onPreview: v => { const sc = [...e.scale] as Vec3; sc[i] = v; e.scale = sc; live(); },
    onCommit: (v, from) => { const sc = [...e.scale] as Vec3; sc[i] = v; const b = [...e.scale] as Vec3; b[i] = from; patchUndo({ scale: sc }, { scale: b }, 'Resize'); } });
  const facing = numberField('Facing', r3(e.path?.length ? entityAt(e, scene.sceneTime()).rotation : e.rotation), { rate: 0.25, snapTo: 5, unit: '°',
    onPreview: v => { if (!e.path?.length) { e.rotation = v; live(); } },
    onCommit: (v, from) => {
      if (!e.path?.length) return patchUndo({ rotation: v }, { rotation: from }, 'Rotate');
      const t = scene.sceneTime(), a = entityAt(e, t);
      patchUndo({ path: upsertKey(e.path, t, a.position, v, e.path.some(k => Array.isArray(k.s)) ? a.scale : undefined) }, { path: structuredClone(e.path) }, 'Key facing');
    } });
  // Pitch and roll: keyed at the playhead on animated objects, otherwise set directly.
  const tilt = (axis: 'pitch' | 'roll', label: string) => numberField(label, r3(e.path?.length ? entityAt(e, scene.sceneTime())[axis] : e[axis] || 0), { rate: 0.5, snapTo: 15, unit: '°',
    onPreview: v => { if (!e.path?.length) { e[axis] = v; live(); } },
    onCommit: (v, from) => {
      if (!e.path?.length) return patchUndo({ [axis]: v }, { [axis]: from }, label);
      const t = scene.sceneTime(), a = entityAt(e, t), keyR = e.path.some(k => Number.isFinite(k.r)), keyS = e.path.some(k => Array.isArray(k.s));
      patchUndo({ path: upsertKey(e.path, t, a.position, keyR ? a.rotation : undefined, keyS ? a.scale : undefined, { [axis]: v }) }, { path: structuredClone(e.path) }, `Key ${label.toLowerCase()}`);
    } });
  const isTarget = shot().camera.target === e.id;
  const transforms = h('details', { class: 'object-transforms', open: !inspectorCollapsed },
    h('summary', {}, 'Transform & motion'),
    h('div', { class: 'object-transform-body' },
      h('div', { class: 'xyz' }, h('span', { class: 'xyz-l' }, 'Position'), pos(0, 'X'), pos(1, 'Y'), pos(2, 'Z')),
      h('div', { class: 'xyz' }, h('span', { class: 'xyz-l' }, 'Scale'), scl(0, 'X'), scl(1, 'Y'), scl(2, 'Z')),
      h('div', { class: 'xyz' }, h('span', { class: 'xyz-l' }, 'Rotation'), facing, tilt('pitch', 'Pitch'), tilt('roll', 'Roll')),
      motionRow,
      h('span', { class: 'note mono', title: 'Blockout object identifier' }, `Object ID · ${e.id}`),
      h('button', { class: 'btn ghost sm', type: 'button', title: 'Delete (X / Delete)', onclick: () => requestDelete() }, 'Delete object…')));
  transforms.ontoggle = () => { inspectorCollapsed = !transforms.open; localStorage.setItem('previs.inspectorCollapsed', inspectorCollapsed ? '1' : '0'); };
  inspector.classList.remove('collapsed');
  inspector.replaceChildren(
    h('div', { class: 'head' }, h('span', { class: 'object-shape' }, shapeIcon(e.shape)), name,
      h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Deselect', onclick: () => selection.clear() }, '✕')),
    h('div', { class: 'object-meta' }, kind, h('label', { class: 'object-color' }, 'Blockout colour', color)),
    h('div', { class: 'object-actions' },
      h('button', { class: 'btn sm', type: 'button', onclick: () => frameSelected() }, 'Frame object'),
      h('button', { class: 'btn sm', type: 'button', disabled: isTarget, onclick: () => void runEntry({ label: 'Aim camera', redo: [{ op: 'update_shot', id: shotId, patch: { camera: { target: e.id } } }], undo: [{ op: 'update_shot', id: shotId, patch: { camera: { target: shot().camera.target } } }] }) }, isTarget ? '◎ Camera target' : 'Aim camera here')),
    transforms);

}

function slider(label: string, min: number, max: number, step: number, value: number, unit: string, onInput: (v: number) => void, onChange: (v: number) => void) {
  const input = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
  const out = h('output', {}, `${value}${unit}`);
  input.oninput = () => { out.textContent = `${input.value}${unit}`; onInput(Number(input.value)); };
  input.onchange = () => onChange(Number(input.value));
  return h('div', { class: 'slider-row' }, label, input, out);
}

// ---------- Shot description: words that name scene objects are underlined in their kind's colour ----------
function objectTerms() {
  const terms: { re: string; kind: string; id: string }[] = [];
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const KIND_ORDER = ['character', 'vehicle', 'prop', 'environment'];
  const ents = [...project.scene.entities].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  for (const e of ents) {
    const parts = new Set<string>([e.name, '@' + handleOf(e.name), ...e.name.split(/\s*·\s*/)]);
    for (const p of [...parts]) { const last = p.trim().split(/\s+/).at(-1) || ''; if (/^[a-z][a-z-]{3,}$/i.test(last)) parts.add(last); }
    for (const p of parts) { const t = p.trim(); if (t.length >= 3 && !/^\d/.test(t)) terms.push({ re: esc(t), kind: e.kind, id: e.id }); }
  }
  terms.sort((a, b) => b.re.length - a.re.length); // longest match wins
  return terms;
}
function semanticText(ta: HTMLTextAreaElement) {
  const back = h('div', { class: 'sem-back', 'aria-hidden': 'true' });
  const wrap = h('div', { class: 'sem-text' }, back, ta);
  const paint = () => {
    const terms = objectTerms(), text = ta.value;
    back.replaceChildren();
    if (!terms.length) { back.append(text + '\n'); return; }
    const re = new RegExp(`(?<![\\w@-])(${terms.map(t => t.re).join('|')})(s|es)?(?![\\w-])`, 'gi');
    let at = 0;
    for (const m of text.matchAll(re)) {
      const hit = terms.find(t => new RegExp(`^${t.re}$`, 'i').test(m[1]))!;
      if (m.index! > at) back.append(text.slice(at, m.index));
      back.append(h('mark', { style: `--k:${KIND_COLORS[hit.kind]}`, 'data-id': hit.id }, m[0]));
      at = m.index! + m[0].length;
    }
    back.append(text.slice(at) + '\n');
    back.scrollTop = ta.scrollTop;
  };
  ta.addEventListener('input', paint);
  ta.addEventListener('scroll', () => { back.scrollTop = ta.scrollTop; });
  requestAnimationFrame(paint); paint();
  return wrap;
}
// ---------- Video model: which model this shot uses, what it accepts, and what goes into each input ----------
let genCache: GenState | null = null, genLoading = false;
function loadGen() { if (genCache || genLoading) return; genLoading = true; api('generation').then(st => { genCache = st; shotPane.dataset.shot = ''; renderShotPane(); renderActionBar(); }).catch(() => {}).finally(() => { genLoading = false; }); }
const modelKey = (s: Shot) => `previs.shot.model.${s.id}`;
function shotModel(s: Shot) {
  const st = genCache!; const choices = videoChoices(st as any);
  const saved = localStorage.getItem(modelKey(s));
  const last = s.render ? st.jobs.filter(j => j.shotId === s.render!.previsShotId).at(-1)?.definition?.id : null;
  return choices.find(d => d.id === saved) || choices.find(d => d.id === last) || choices[0] || null;
}
function modelBlock(s: Shot) {
  if (!genCache) { loadGen(); return h('div', { class: 'block vm' }, h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, 'Video model'), h('span', { class: 'muted' }, 'Loading…'))); }
  const st = genCache, choices = videoChoices(st as any), def: any = shotModel(s);
  if (!def) return h('div', { class: 'block vm' }, h('span', { class: 'eyebrow' }, 'Video model'), h('p', { class: 'note' }, 'No video models are set up.'));
  const pick = h('select', { class: 'field vm-pick', 'aria-label': 'Video model for this shot' }, ...choices.map((d: any) => h('option', { value: d.id, selected: d.id === def.id }, d.title)));
  pick.onchange = () => { localStorage.setItem(modelKey(s), pick.value); shotPane.dataset.shot = ''; renderShotPane(); };
  const cap = referenceCapacity(st as any, def.id), refs = cap ? plannedReferences(project, s, st as any, def.id) : [];
  const usesClip = def.task === 'transform-video' || def.task === 'control-video';
  const usesFrames = def.task === 'first-frame', twoFrames = usesFrames && !!def.inputs?.lastFrame;
  const frames = s.references.filter(r => r.role === 'frame');
  const hasStart = frames.some(r => r.note === 'key frame start' || !r.note), hasEnd = frames.some(r => r.note === 'key frame end');
  const maxLen = def.constraints?.promptMaxLength as number | undefined, promptLen = shotPrompt(project, s, 'video').length;
  const stale = s.render && s.render.signature && s.render.signature !== signature(project, s);
  const rate = def.pricing?.ratePerSecond as number | undefined;
  const cast = castRows(project, s).filter(r => r.inCast && r.entity.kind !== 'environment');
  const sent = new Set(refs.map(r => r.entityId));
  const slot = (ok: boolean | null, label: string, detail: Node | string, k?: string) => h('div', { class: 'vm-slot' + (ok === false ? ' warn' : ok ? ' ok' : ''), style: k ? `--k:${k}` : '' },
    h('span', { class: 'vm-dot' }, ok === false ? '!' : ok ? '✓' : '–'), h('span', { class: 'vm-label' }, label), h('span', { class: 'vm-detail' }, detail));
  return h('div', { class: 'block vm' },
    h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, 'Video model'), h('span', { class: 'muted', style: 'font-size:11.5px' }, rate ? `≈ $${(rate * s.duration).toFixed(2)} for ${s.duration}s` : 'Cost shown at quote')),
    pick,
    def.description ? h('p', { class: 'note vm-desc', title: def.description }, def.description) : null,
    h('div', { class: 'vm-inputs' },
      h('div', { class: 'vm-head' }, 'What this model takes'), modelInputsDiagram(def.task, { twoFrames, castImages: refs.length }),
      slot(!maxLen || promptLen <= maxLen, 'Text prompt', maxLen ? h('span', {}, `${promptLen.toLocaleString()} / ${maxLen.toLocaleString()} characters`, promptLen > maxLen ? h('b', { class: 'vm-over' }, ' · will be cut') : '') : `${promptLen.toLocaleString()} characters`),
      usesClip ? slot(s.render ? !stale : false, 'Blockout video', s.render ? (stale ? 'The scene changed since · a new blockout is made when you generate' : `Your camera move · ${s.render.duration}s, ${s.render.frameCount} frames`) : 'Made from your camera when you generate') : slot(null, 'Blockout video', 'Not used · describe the motion in the prompt'),
      usesFrames ? slot(hasStart, twoFrames ? 'Start frame' : 'First frame', hasStart ? 'Start still ready (Storyboard)' : 'Add a Start still in the Storyboard below') : null,
      twoFrames ? slot(hasEnd, 'End frame', hasEnd ? 'End still ready (Storyboard)' : 'Add an End still in the Storyboard below') : null,
      slot(cap ? refs.length > 0 : null, 'Cast images', cap ? `${refs.length} of up to ${cap}` : 'Not accepted by this model')),
    cap ? h('div', { class: 'vm-map' },
      h('div', { class: 'vm-head' }, 'Shot objects → model inputs'),
      ...refs.map((r, i) => h('div', { class: 'vm-ref', style: `--k:${KIND_COLORS[entity(r.entityId!)?.kind || 'prop']}`, onmouseenter: () => { if (r.entityId) { scene.setHover(r.entityId); highlightPrompt(r.entityId); } }, onmouseleave: () => { scene.setHover(null); highlightPrompt(selected); } },
        h('span', { class: 'vm-n' }, `Image ${i + 1}`), h('img', { src: refUrl(r.ref), alt: '' }), h('span', { class: 'vm-name' }, r.label))),
      ...cast.filter(r => !sent.has(r.entity.id)).map(r => h('div', { class: 'vm-ref missing', style: `--k:${KIND_COLORS[r.entity.kind]}` },
        h('span', { class: 'vm-n' }, objectLooks(project, r.entity.id).length ? 'Over limit' : 'No image'), h('span', { class: 'vm-ph' }), h('span', { class: 'vm-name' }, r.entity.name)))) : null);
}
// ---------- Shot panel sections (Story → Cast → Camera → Video → More), collapsible, state remembered ----------
const secState: Record<string, boolean> = JSON.parse(localStorage.getItem('previs.sections') || '{}');
const secOpen = (key: string) => secState[key] ?? key !== 'more';
function setSection(key: string, open: boolean) {
  secState[key] = open; localStorage.setItem('previs.sections', JSON.stringify(secState));
  const el = shotPane.querySelector<HTMLElement>(`[data-sec="${key}"]`); if (!el) return;
  el.classList.toggle('open', open); el.querySelector('.sec-head')!.setAttribute('aria-expanded', String(open)); (el.querySelector('.sec-body') as HTMLElement).hidden = !open;
}
function openSection(key: string) { if (!secOpen(key)) setSection(key, true); }
function section(key: string, title: string, aside: Node | string | null, ...body: (Node | null)[]) {
  const open = secOpen(key);
  return h('section', { class: 'sec' + (open ? ' open' : ''), 'data-sec': key },
    h('div', { class: 'sec-headrow' },
      h('button', { type: 'button', class: 'sec-head', 'aria-expanded': String(open), onclick: () => setSection(key, !secOpen(key)) }, h('span', { class: 'sec-chev', 'aria-hidden': 'true' }, '›'), h('span', { class: 'sec-title' }, title)),
      aside ? h('span', { class: 'sec-aside', title: typeof aside === 'string' ? aside : aside.textContent || '' }, aside) : null),
    h('div', { class: 'sec-body', hidden: !open }, ...body));
}
function goSection(key: string) { if (collapsed.side) setCollapsed('side', false); openSection(key); shotPane.querySelector(`[data-sec="${key}"]`)?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }
/** Readiness strip: Blockout · Cast · Prompt · Video for the current shot. */
function renderReadiness() {
  const s = shot(); if (!s) return;
  const stale = !!(s.render && s.render.signature && s.render.signature !== signature(project, s));
  const cast = castRows(project, s).filter(r => r.inCast && r.entity.kind !== 'environment');
  const need = cast.filter(r => !objectLooks(project, r.entity.id).length).length;
  const edited = !!(s.prompts?.video?.edited && s.prompts.video.text);
  const vids = shotVideos(s.id).length;
  const item = (key: string, state: 'ok' | 'warn' | 'none', label: string, value: Node | string, tip: string) => h('button', { type: 'button', class: `rd ${state}`, title: tip, onclick: () => goSection(key) }, h('span', { class: 'rd-label' }, label), h('span', { class: 'rd-val' }, value));
  readiness.replaceChildren(
    item('camera', s.render ? (stale ? 'warn' : 'ok') : 'none', 'Blockout', s.render ? (stale ? 'changed' : '✓') : '–', s.render ? (stale ? 'The scene or camera changed since the blockout' : 'Blockout is up to date') : 'No blockout yet: the grey camera clip is made when you generate'),
    item('cast', need ? 'warn' : cast.length ? 'ok' : 'none', 'Cast', h('span', { class: 'rd-cast' }, ...cast.slice(0, 5).map(r => h('i', { style: `background:${KIND_COLORS[r.entity.kind]}`, title: r.entity.name })), `${cast.length}${need ? ` · ${need} need image${need === 1 ? '' : 's'}` : ''}`), need ? `${need} of ${cast.length} cast members have no image yet` : 'Every cast member has an image'),
    item('video', edited ? 'warn' : 'ok', 'Prompt', edited ? 'edited' : 'auto', edited ? 'You edited this shot’s prompt; your text is used' : 'The prompt is composed from the cast, camera and story'),
    item('video', vids ? 'ok' : 'none', 'Video', vids ? `✓${vids > 1 ? ` ${vids}` : ''}` : '–', vids ? `${vids} generated video${vids === 1 ? '' : 's'}` : 'No video yet: Generate video (bottom of this panel)'));
  renderActionBar();
}
/** Action bar: shot number, blockout state and cost on the left; Preview and Generate on the right. */
function renderActionBar() {
  const s = shot(); if (!s) return;
  const idx = project.shots.indexOf(s), stale = !!(s.render && s.render.signature && s.render.signature !== signature(project, s));
  if (!genCache) loadGen();
  const rate = genCache ? (shotModel(s) as any)?.pricing?.ratePerSecond as number | undefined : undefined;
  const state = s.render ? (stale ? 'blockout changed' : 'blockout ready') : 'no blockout yet';
  actHint.replaceChildren(h('strong', {}, `Shot ${String(idx + 1).padStart(2, '0')}`), h('span', { class: `act-state ${s.render ? (stale ? 'warn' : 'ok') : 'none'}` }, state), ...(rate ? [h('span', { class: 'act-cost' }, `≈ $${(rate * s.duration).toFixed(2)}`)] : []));
  actHint.title = `${s.title} · ${s.duration}s · ${state}${rate ? ` · about $${(rate * s.duration).toFixed(2)} to generate` : ''}`;
  const ready = !!s.render && !stale;
  renderBtn.textContent = ready ? 'Generate video ▸' : 'Make blockout…';
  renderBtn.title = ready ? 'Generate this shot’s video from its blockout' : 'Make the camera blockout, then generate this shot’s video';
}
function renderSteps() {
  const n = project.scene.entities.filter(e => e.shape !== 'group').length, shots = project.shots.length, vids = (project.assets || []).filter(a => a.kind === 'workflow-result').length;
  stepBtns.build.querySelector('.st-count')!.textContent = `${n} object${n === 1 ? '' : 's'}`;
  stepBtns.shoot.querySelector('.st-count')!.textContent = `${shots} shot${shots === 1 ? '' : 's'}`;
  stepBtns.cut.querySelector('.st-count')!.textContent = `${vids} video${vids === 1 ? '' : 's'}`;
}
let rigExplainer: { dispose(): void } | undefined;
function renderShotPane() {
  const key = `${shotId}|${project.revision}`;
  if (shotPane.dataset.shot === key) return;
  shotPane.dataset.shot = key;
  rigExplainer?.dispose();
  // The rebuild detaches the object pane (re-placed below); keep typing there intact, e.g. during a refgen poll.
  const held = objectPane.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const caret = held instanceof HTMLInputElement || held instanceof HTMLTextAreaElement ? [held.selectionStart, held.selectionEnd] : null;
  const s = shot(), idx = project.shots.indexOf(s);
  const title = h('input', { class: 'field', value: s.title, maxlength: 120, 'aria-label': 'Shot title' });
  title.onchange = () => void edit([{ op: 'update_shot', id: s.id, patch: { title: title.value } }]);
  const desc = h('textarea', { class: 'field', rows: 4, spellcheck: false, placeholder: 'What happens in this shot? Mention objects with @handle, e.g. @runner sprints past @car.', 'aria-label': 'Shot description' }, s.description);
  desc.onchange = () => void edit([{ op: 'update_shot', id: s.id, patch: { description: desc.value } }]);
  const descBox = semanticText(desc);
  const handles = h('div', { class: 'chips', style: 'padding:0' }, ...project.scene.entities.filter(e => e.kind !== 'environment').slice(0, 8).map(e => h('button', { type: 'button', onclick: () => { desc.setRangeText('@' + handleOf(e.name) + ' ', desc.selectionStart, desc.selectionEnd, 'end'); desc.focus(); } }, '@' + handleOf(e.name))));
  const local = (patch: Partial<Shot['camera']>) => { Object.assign(s.camera, patch); scene.sync(project, s); renderTransport(); };
  const commit = (patch: Partial<Shot['camera']>) => void edit([{ op: 'update_shot', id: s.id, patch: { camera: patch } }]);
  const move = h('select', { class: 'field', 'aria-label': 'Camera move' }, ...Object.entries(MOVES).filter(([k]) => k !== 'custom' || s.camera.move === 'custom').map(([k, v]) => h('option', { value: k, selected: k === s.camera.move }, v)));
  move.onchange = () => commit({ move: move.value });
  const target = h('select', { class: 'field', 'aria-label': 'Camera target' }, h('option', { value: '' }, 'Scene centre'), ...project.scene.entities.map(e => h('option', { value: e.id, selected: e.id === s.camera.target }, e.name)));
  target.onchange = () => commit({ target: target.value || null });
  const custom = s.camera.move === 'custom';
  const keyFromView = (which: 'start' | 'end') => {
    const keys = cameraKeys(s, project.scene.entities);
    const view = scene.worldView();
    const k = { t: which === 'start' ? 0 : 1, p: view.p, look: view.look, mm: s.camera.mm };
    const next = which === 'start' ? [k, { ...keys.at(-1)!, t: 1 }] : [{ ...keys[0], t: 0 }, k];
    void edit([{ op: 'update_shot', id: s.id, patch: { camera: { move: 'custom', keys: next, timing: 'ease' } } }]).then(() => toast(`Camera ${which} set from the set view`));
  };
  const rendered = s.render;
  const stale = rendered && rendered.signature && rendered.signature !== signature(project, s);
  const refsGrid = h('div', { class: 'refs' }, ...s.references.map(r => refCard(s, r)));
  const drop = h('label', { class: 'dropzone' }, h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true, onchange: (ev: Event) => { const files = Array.from((ev.target as HTMLInputElement).files || []); void uploadRefs(files, null); } }), 'Drop images here or click to add references for this shot');
  dropTarget(drop, files => uploadRefs(files, null));
  const ctx = { project: () => project, runEntry: (e: any) => runEntry(e as any), select: (id: string) => { select(id); openObject(); }, refresh: () => { shotPane.dataset.shot = ''; renderShotPane(); } };
  const rows = castRows(project, s).filter(r => r.inCast && r.entity.kind !== 'environment');
  const blockoutInfo = rendered ? h('details', { class: 'facts-more' },
    h('summary', {}, h('span', { class: 'info-i', 'aria-hidden': 'true' }, 'i'), 'Blockout clip', stale ? h('span', { class: 'fm-warn' }, ' · scene changed since') : h('span', { class: 'fm-ok' }, ' · up to date')),
    h('video', { src: `/assets/${rendered.assetId}.mp4`, controls: true, muted: true, loop: true, playsinline: true, preload: 'metadata', style: 'width:100%;border-radius:8px;border:1px solid var(--line)' }),
    h('div', { class: 'facts' }, 'Frames', h('b', {}, `${rendered.frameCount} @ 24 fps`), 'Duration', h('b', {}, `${Number(rendered.duration).toFixed(2)}s`), 'Size', h('b', {}, `${rendered.width}×${rendered.height}`))) : null;
  shotPane.replaceChildren(
    section('story', 'Story', h('span', { class: 'sec-meta' }, `Shot ${String(idx + 1).padStart(2, '0')}`, h('button', { class: 'btn ghost sm', type: 'button', disabled: project.shots.length < 2, title: 'Delete this shot', onclick: () => { requestDeleteShot(s); } }, 'Delete')),
      h('div', { class: 'block' }, title, descBox)),
    section('cast', 'Cast', h('span', { class: 'sec-dots' }, ...rows.slice(0, 6).map(r => h('i', { style: `background:${KIND_COLORS[r.entity.kind]}` })), `${rows.length}`), castBlock(s)),
    section('camera', 'Camera', describeCamera(s, project.scene.entities),
      h('div', { class: 'block' },
      h('div', { class: 'grid2' }, h('label', {}, h('span', { class: 'ch-labrow' }, 'Move', moveHelp(move)), move), h('label', {}, 'Target', target)),
      h('div', { class: 'slider-row' }, 'Starts at', numberField('Start', s.start || 0, { rate: 0.05, snapTo: 0.5, min: 0, max: MAX_SCENE_TIME, unit: 's', onPreview: v => { s.start = v; scene.sync(project, s); renderTransport(); }, onCommit: (v, from) => void runEntry({ label: 'Shot start', redo: [{ op: 'update_shot', id: s.id, patch: { start: v } }], undo: [{ op: 'update_shot', id: s.id, patch: { start: from } }] }) }), h('output', {}, `/ ${sceneLength(project).toFixed(1)} s`)),
      slider('Duration', 0.5, MAX_DURATION, 0.25, s.duration, 's', v => { s.duration = v; scrub.max = String(v); scene.sync(project, s); renderTransport(); }, v => void edit([{ op: 'update_shot', id: s.id, patch: { duration: v } }])),
      slider('Lens', 12, 135, 1, Math.round(s.camera.mm), 'mm', v => local({ mm: v, ...(custom ? { keys: s.camera.keys!.map(k => ({ ...k, mm: v })) } : {}) }), v => commit({ mm: v, ...(custom ? { keys: s.camera.keys!.map(k => ({ ...k, mm: v })) } : {}) })),
      custom ? h('p', { class: 'note', style: 'margin:0' }, 'Custom keys from the set view or a flown take. Pick a move above to go back to a preset.') : h('div', { class: 'block', style: 'gap:6px' },
        slider('Distance', 0.5, 30, 0.1, s.camera.distance, 'm', v => local({ distance: v }), v => commit({ distance: v })),
        slider('Height', 0.1, 15, 0.1, s.camera.height, 'm', v => local({ height: v }), v => commit({ height: v })),
        slider('Angle', -180, 180, 1, s.camera.angle, '°', v => local({ angle: v }), v => commit({ angle: v }))),
      h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => keyFromView('start'), title: 'Use the current director view as the first camera position' }, 'Set start from view'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => keyFromView('end'), title: 'Use the current director view as the last camera position' }, 'Set end from view'),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => scene.lookThrough() }, 'Go to camera'))),
      h('details', { class: 'facts-more' }, h('summary', {}, 'Camera controls explained'), h('div', { class: 'help-explain', 'data-explain': 'camera-rig' })),
      cameraStyleBlock(s, ctx),
      operateBlock(s)), // [operate]
    section('video', 'Video', shotVideos(s.id).length ? h('span', { class: 'fm-ok' }, `${shotVideos(s.id).length} ready`) : null,
      ...resultsBlock(s),
      modelBlock(s),
      promptBlock(s, ctx),
      keyFrameBlock(s),
      blockoutInfo),
    section('more', 'More', h('span', { class: 'sec-meta' }, `${s.references.length} shot image${s.references.length === 1 ? '' : 's'}`),
      h('div', { class: 'block' },
        h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, `Shot images · ${s.references.length}`), h('span', { class: 'muted', style: 'font-size:11.5px' }, 'Extra images for this shot; link each to an object')),
        refsGrid, drop)));
  const rigHost = shotPane.querySelector<HTMLElement>('[data-explain="camera-rig"]')!;
  rigExplainer = mountExplainer(rigHost, 'camera-rig');
  const rigPlay = rigHost.querySelector<HTMLElement>('.ex-play'); if (rigPlay) { rigPlay.style.width = '44px'; rigPlay.style.height = '44px'; }
  renderReadiness();
  placeObjectPane();
  if (held?.isConnected && document.activeElement !== held) { held.focus({ preventScroll: true }); if (caret) try { (held as HTMLInputElement).setSelectionRange(caret[0], caret[1]); } catch {} }
  shotPane.addEventListener('focusout', () => setTimeout(() => { if (!shotPane.contains(document.activeElement) && !objectPane.contains(document.activeElement)) renderShotPane(); }, 0), { once: true });
}

function refCard(s: Shot, r: Reference) {
  const link = h('select', { class: 'field', 'aria-label': `Link ${r.name} to` }, h('option', { value: '' }, 'Not linked'), ...project.scene.entities.map(e => h('option', { value: e.id, selected: e.id === r.entityId }, `→ ${e.name}`)));
  link.onchange = () => { const e = entity(link.value); void edit([{ op: 'update_reference', shotId: s.id, referenceId: r.id, patch: { entityId: link.value || null, ...(e && r.role !== 'style' ? { role: e.kind === 'character' ? 'character' : e.kind === 'environment' ? 'environment' : 'prop' } : {}) } }]); };
  const role = h('select', { class: 'field', 'aria-label': `${r.name} role` }, ...ROLES.map(x => h('option', { value: x, selected: x === r.role }, x)));
  role.onchange = () => void edit([{ op: 'update_reference', shotId: s.id, referenceId: r.id, patch: { role: role.value } }]);
  const linked = entity(r.entityId);
  return h('div', { class: 'ref' },
    h('img', { src: refUrl(r), alt: r.name, loading: 'lazy' }),
    h('div', { class: 'ref-body' },
      h('div', { class: 'ref-name' }, h('span', { title: r.name }, r.name), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': `Remove ${r.name} from shot`, title: 'Remove from shot (file is kept)', onclick: () => void edit([{ op: 'remove_reference', shotId: s.id, referenceId: r.id }]) }, '✕')),
      h('span', { class: 'link' + (linked ? '' : ' none') }, linked ? `@${handleOf(linked.name)} · ${r.role}` : r.role === 'style' ? 'Style · whole shot' : 'Not linked'),
      link, role));
}

// ---------- Shot key frames (image generation guided by the blockout frame) ----------
const frameForm: Record<string, { open: boolean; presetId: string; count: number; seed: number; prompt: string | null; guide: boolean; checkpoint: string }> = {};
/** When in the shot a still belongs (seconds), from its note: start, end or @t. */
function stillTime(s: Shot, r: Reference): number | null {
  const n = r.note || '';
  if (n === 'key frame start') return 0;
  if (n === 'key frame end') return s.duration;
  const m = /^key frame @([\d.]+)s$/.exec(n); return m ? Math.min(s.duration, Number(m[1])) : null;
}
const fmtT = (t: number) => `${t.toFixed(t % 1 ? 2 : 0)}s`;
function seekShot(t: number) { playing = false; playhead = Math.max(0, Math.min(shot().duration, t)); scene.setPlayhead(playhead); renderTransport(); renderInspector(); }
// ---------- Storyboard: cheap, perfected stills of the shot at chosen moments, before any video ----------
function keyFrameBlock(s: Shot) {
  const f = frameForm[s.id] ||= { open: false, presetId: STRONG_GUIDE_MODEL, count: 1, seed: Math.floor(Math.random() * 1e6), prompt: null, guide: true, checkpoint: '' };
  const frames = s.references.filter(r => r.role === 'frame');
  const jobs = refgen.jobs.filter(j => j.target === 'shot' && j.shotId === s.id);
  const running = jobs.filter(j => j.status === 'submitted' || j.status === 'submitting');
  // Group takes by moment; the newest take at a moment is the one used.
  const moments = new Map<string, { t: number | null; takes: Reference[] }>();
  for (const r of frames) { const t = stillTime(s, r), k = t === null ? 'x' : t.toFixed(2); (moments.get(k) || moments.set(k, { t, takes: [] }).get(k)!).takes.push(r); }
  const ordered = [...moments.values()].sort((a, b) => (a.t ?? 1e9) - (b.t ?? 1e9));
  const at = Math.round(playhead * 100) / 100;
  const label = (t: number | null) => t === null ? 'Unpinned' : t === 0 ? 'Start' : Math.abs(t - s.duration) < 0.01 ? 'End' : fmtT(t);
  const open = (t: number) => { f.open = true; f.prompt = null; seekShot(t); if (!refgen.presets.length) void loadRefgen(); shotPane.dataset.shot = ''; renderShotPane(); };

  // Shot timing: the shot's length with a pin per moment and the playhead.
  const track = h('div', { class: 'sb-track', title: 'Click to move the playhead; add a still at that moment', onclick: (ev: MouseEvent) => { const r = (ev.currentTarget as HTMLElement).getBoundingClientRect(); seekShot(((ev.clientX - r.left) / r.width) * s.duration); shotPane.dataset.shot = ''; renderShotPane(); } },
    h('div', { class: 'sb-rail' }),
    h('div', { class: 'sb-head', style: `left:${(playhead / s.duration) * 100}%` }),
    ...ordered.filter(m => m.t !== null).map(m => h('button', { type: 'button', class: 'sb-pin', style: `left:${(m.t! / s.duration) * 100}%`, title: `${label(m.t)} · ${m.takes.length} take${m.takes.length === 1 ? '' : 's'}`, onclick: (ev: MouseEvent) => { ev.stopPropagation(); seekShot(m.t!); shotPane.dataset.shot = ''; renderShotPane(); } }, h('img', { src: refUrl(m.takes.at(-1)!), alt: '' }))),
    h('span', { class: 'sb-t0' }, '0s'), h('span', { class: 'sb-t1' }, fmtT(s.duration)));
  const adds = h('div', { class: 'sb-adds' },
    h('button', { class: 'btn sm', type: 'button', onclick: () => open(0) }, '+ Start'),
    h('button', { class: 'btn sm camera', type: 'button', onclick: () => open(at) }, `+ Still at ${fmtT(at)}`),
    h('button', { class: 'btn sm', type: 'button', onclick: () => open(s.duration) }, '+ End'));
  const strip = ordered.length ? h('div', { class: 'sb-strip' }, ...ordered.map(m => {
    const used = m.takes.at(-1)!;
    return h('div', { class: 'sb-moment' + (m.t !== null && Math.abs(m.t - playhead) < 0.02 ? ' here' : '') },
      h('button', { type: 'button', class: 'sb-hero', title: 'Jump here', onclick: () => { if (m.t !== null) { seekShot(m.t); shotPane.dataset.shot = ''; renderShotPane(); } } }, h('img', { src: refUrl(used), alt: used.name, loading: 'lazy' }), h('span', { class: 'sb-when' }, label(m.t))),
      m.takes.length > 1 ? h('div', { class: 'sb-takes' }, ...m.takes.slice(0, -1).reverse().slice(0, 4).map(r => h('img', { src: refUrl(r), alt: '', title: `Earlier take · ${r.generated?.model || ''}` }))) : null,
      h('div', { class: 'sb-meta' }, `${m.takes.length} take${m.takes.length === 1 ? '' : 's'}`, matchBadge(used), m.t !== null ? h('button', { class: 'linklike', type: 'button', onclick: () => open(m.t!) }, 'New take') : null));
  })) : h('div', { class: 'sb-empty' }, h('strong', {}, 'Picture the shot before you film it.'), h('span', {}, 'A still costs a few cents. Pin one at the start, the end, or any moment: it uses the blockout frame there, your cast’s images and this shot’s prompt. Start→end video models use the start and end stills.'));
  const head = h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, `Storyboard · ${frames.length}`), h('span', { class: 'muted', style: 'font-size:11.5px' }, running.length ? `Generating ${running.length}…` : 'Stills of the shot, moment by moment'));
  if (!f.open) return h('div', { class: 'block sb' }, head, track, adds, strip, ...jobs.filter(j => j.status === 'failed').slice(0, 1).map(jobRow));

  // Composer for a still at the playhead.
  const t = at, guidePng = scene.capture(t, 1280, 720, 'image/png', undefined, { guide: true });
  const chosen = stillPresets.find(p => p.id === f.presetId), cap = chosen?.maxRefs ?? 0;
  const words = describeFrame(project, s, t);
  const looks = stillReferences(project, s, t, cap).looks; // objects in frame, one environment image
  const prev = project.shots[project.shots.indexOf(s) - 1]?.references.filter(r => r.role === 'frame').at(-1);
  const refIds = [...looks.map(r => r.ref.id), ...(prev ? [prev.id] : [])].slice(0, Math.max(0, cap - 1));
  const moment = h('input', { class: 'field', placeholder: 'At this moment… (optional) e.g. “the car is just leaving the ground”', 'aria-label': 'What happens at this moment' });
  const prompt = h('textarea', { class: 'field sb-prompt', rows: 5, 'aria-label': 'Still prompt' }, f.prompt ?? shotPrompt(project, s, 'image'));
  prompt.oninput = () => { f.prompt = prompt.value; };
  const model = h('select', { class: 'field', 'aria-label': 'Image model' }, ...stillPresets.map(p => h('option', { value: p.id, selected: p.id === f.presetId }, `${p.title}${p.id === STRONG_GUIDE_MODEL ? ' · matches the blockout best' : p.followsGuide === 'strong' ? ' · follows the blockout' : ''}`)));
  model.onchange = () => { f.presetId = model.value; shotPane.dataset.shot = ''; renderShotPane(); };
  const count = h('select', { class: 'field', 'aria-label': 'Takes' }, ...[1, 2, 3, 4].map(n => h('option', { value: n, selected: n === f.count }, `${n} take${n > 1 ? 's' : ''}`)));
  count.onchange = () => { f.count = Number(count.value); go.textContent = `Generate${estLabel(f.presetId, f.count)}`; };
  const status = h('div', { class: 'status-line' });
  const go = h('button', { class: 'btn camera', type: 'button' }, `Generate${estLabel(f.presetId, f.count)}`);
  go.onclick = async () => {
    go.disabled = true; status.className = 'status-line'; status.textContent = 'Sending…';
    try {
      const text = [prompt.value.trim(), moment.value.trim() ? `At this moment: ${moment.value.trim()}.` : ''].filter(Boolean).join(' ');
      const frameAt = t === 0 ? 'start' : Math.abs(t - s.duration) < 0.01 ? 'end' : t;
      const full = stillPrompt({ project, shot: s, t, text, presetId: f.presetId, looks: looks.slice(0, refIds.length), prevImage: prev && refIds.includes(prev.id) ? refIds.indexOf(prev.id) + 2 : null, frame: words });
      const { job } = await api('director/refgen/prepare', { projectId, target: 'shot', shotId: s.id, frameAt, presetId: f.presetId, prompt: full, aspect: '16:9', count: f.count, seed: f.seed, referenceIds: refIds, guide: guidePng.split(',')[1] });
      await generateNow(job); f.open = false; f.seed = Math.floor(Math.random() * 1e6);
      toast(`Generating ${f.count > 1 ? `${f.count} takes` : 'a still'} at ${label(t)} · it pins to the storyboard when ready`);
      shotPane.dataset.shot = ''; renderShotPane();
    } catch (e) { status.className = 'status-line err'; status.textContent = (e as Error).message; }
    finally { go.disabled = false; }
  };
  const inputs = h('div', { class: 'sb-inputs' },
    h('div', { class: 'vm-head' }, `Still at ${label(t)} · what the image model gets`),
    h('div', { class: 'sb-in' }, h('figure', {}, h('img', { src: guidePng, alt: 'Blockout frame' }), h('figcaption', {}, h('b', {}, 'Image 1'), ' blockout frame · composition')),
      ...looks.slice(0, refIds.length).map((r, i) => h('figure', { style: `--k:${KIND_COLORS[entity(r.entityId!)?.kind || 'prop']}` }, h('img', { src: refUrl(r.ref), alt: '' }), h('figcaption', {}, h('b', {}, `Image ${i + 2}`), ' ', r.label))),
      prev && refIds.includes(prev.id) ? h('figure', {}, h('img', { src: refUrl(prev), alt: '' }), h('figcaption', {}, h('b', {}, `Image ${refIds.indexOf(prev.id) + 2}`), ' previous shot · continuity')) : null),
    !cap ? h('p', { class: 'note', style: 'margin:0' }, 'This model takes no cast images; only the prompt and blockout frame guide it.') : null,
    h('p', { class: 'note sb-camera', style: 'margin:0', title: 'Added to the prompt: the shot camera and blocking in words, measured from the blockout' }, h('b', {}, 'Camera in words · '), words.text),
    chosen && chosen.followsGuide !== 'strong' ? h('p', { class: 'note', style: 'margin:0' }, `To match the blockout closely, ${stillPresets.find(p => p.id === STRONG_GUIDE_MODEL)?.title || 'FLUX 3'} follows the camera and blocking best.`) : null);
  return h('div', { class: 'block sb' }, head, track, adds,
    h('div', { class: 'sb-composer' }, inputs, moment, prompt,
      h('div', { class: 'grid2' }, h('label', {}, 'Image model', model), h('label', {}, 'Takes', count)),
      h('div', { class: 'sb-actions' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { f.open = false; shotPane.dataset.shot = ''; renderShotPane(); } }, 'Cancel'), go), status),
    strip);
}

/** "Matches blockout 8/10" for a key frame that was checked against its guide frame. */
function matchBadge(r: Reference) {
  // Only graded scores are shown; the free local score is too rough to call a match (it stays in the data).
  const g = r.generated?.guideMatch; if (!g || g.rough) return null;
  return h('span', { class: `sb-match${g.score < 5 ? ' weak' : ''}`, title: `Camera and blocking graded against the blockout frame by ${g.method.split(':')[1] || g.method}${g.why ? `: ${g.why}` : ''}` }, `matches blockout ${Math.round(g.score)}/10`);
}

// ---------- Results & assets ----------
function resultsBlock(s: Shot): Node[] {
  const results = (project.assets || []).filter(a => a.kind === 'workflow-result' && a.shotId === s.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!results.length) return [];
  return [h('div', { class: 'block videos' },
    h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, `Videos · ${results.length}`), results.length > 3 ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => void openAssets('result') }, 'All in Library') : null),
    ...results.slice(0, 3).map(a => h('div', { style: 'display:flex;flex-direction:column;gap:4px' },
      a.mime.startsWith('video/') ? h('video', { src: assetUrl(a), controls: true, muted: true, loop: true, playsinline: true, preload: 'metadata', style: 'width:100%;border-radius:8px;border:1px solid var(--line)' }) : h('img', { src: assetUrl(a), alt: '', style: 'width:100%;border-radius:8px' }),
      h('div', { class: 'vid-meta' }, h('span', {}, (a.source.workflow || 'Video').split(' ·')[0]), h('span', { class: 'muted' }, `${a.duration != null ? Number(a.duration).toFixed(1) : '—'}s · ${a.width}×${a.height} · ${new Date(a.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`),
        h('button', { class: 'linklike', type: 'button', title: 'Compare the video with its blockout', onclick: () => { setStep('cut'); sequence.open(s.id, 'compare'); } }, 'Compare')))))];
}
async function openAssets(initial: 'all' | 'cut' | 'render' | 'result' | 'look' | 'ref' = 'all') {
  document.getElementById('assets-dialog')?.remove();
  let assets: Asset[] = [];
  try { assets = (await api(`director/assets?id=${projectId}`)).assets; } catch (e) { toast((e as Error).message, true); }
  const shotLabel = (id: string) => { const i = project.shots.findIndex(x => x.id === id); return i < 0 ? 'Removed shot' : `Shot ${String(i + 1).padStart(2, '0')} · ${project.shots[i].title}`; };
  type Item = { kind: 'cut' | 'render' | 'result' | 'look' | 'ref'; title: string; sub: string; url: string; video: boolean; created: string; meta: string; actions: Node[] };
  const items: Item[] = [
    ...assets.map(a => ({
      kind: a.kind === 'camera-render' ? 'render' as const : a.kind === 'edit' ? 'cut' as const : 'result' as const,
      title: a.kind === 'camera-render' ? `Blockout v${a.version ?? 1}` : a.kind === 'edit' ? `Film v${a.version ?? 1} · ${a.source.clips?.length ?? 0} clips` : (a.source.workflow || 'Video').split(' ·')[0],
      sub: (a.kind === 'edit' ? 'Whole film' : shotLabel(a.shotId!)) + (a.imported ? ' · imported' : ''), url: assetUrl(a), video: a.mime.startsWith('video/'), created: a.createdAt,
      meta: `${a.frameCount ?? '—'}f · ${a.duration != null ? Number(a.duration).toFixed(2) : '—'}s · ${a.width}×${a.height}`,
      actions: [h('a', { class: 'btn sm', href: assetUrl(a), download: `${a.id}.${a.file.split('.').pop()}` }, 'Download'),
        a.kind === 'workflow-result' && a.shotId ? h('button', { class: 'btn sm', type: 'button', onclick: () => { document.getElementById('assets-dialog')?.remove(); setStep('cut'); sequence.open(a.shotId!, 'compare'); } }, 'Compare') : null].filter(Boolean) as Node[],
    })),
    ...(project.scene.references || []).filter(r => entity(r.entityId)).map(r => ({ kind: 'look' as const, title: r.name, sub: `Cast image · ${entity(r.entityId)?.name || 'object'}${entity(r.entityId)?.look === r.id ? ' · primary' : ''}`, url: refUrl(r), video: false, created: r.createdAt, meta: r.generated ? `✦ ${r.generated.model.split(' (')[0]} · seed ${r.generated.seed}` : 'uploaded', actions: [h('a', { class: 'btn sm', href: refUrl(r), download: r.file }, 'Download')] })),
    ...project.shots.flatMap(s => s.references.map(r => ({ kind: 'ref' as const, title: r.name, sub: `${shotLabel(s.id)} · ${r.role}`, url: refUrl(r), video: false, created: r.createdAt, meta: entity(r.entityId) ? `→ ${entity(r.entityId)!.name}` : 'not linked', actions: [h('a', { class: 'btn sm', href: refUrl(r), download: r.file }, 'Download')] }))),
  ].sort((a, b) => b.created.localeCompare(a.created));
  const labels = { all: 'All', result: 'Videos', cut: 'Films', look: 'Cast images', render: 'Blockouts', ref: 'Shot images' } as const;
  let filter: keyof typeof labels = initial;
  const grid = h('div', { class: 'asset-grid' });
  const seg = h('div', { class: 'seg' });
  const draw = () => {
    seg.replaceChildren(...(Object.keys(labels) as (keyof typeof labels)[]).map(k => h('button', { type: 'button', class: k === filter ? 'on' : '', onclick: () => { filter = k; draw(); } }, `${labels[k]} · ${k === 'all' ? items.length : items.filter(i => i.kind === k).length}`)));
    const shown = items.filter(i => filter === 'all' || i.kind === filter);
    grid.replaceChildren(...(shown.length ? shown.map(i => h('div', { class: 'asset' },
      i.video ? h('video', { src: i.url, muted: true, loop: true, playsinline: true, preload: 'metadata', controls: true }) : h('img', { src: i.url, alt: i.title, loading: 'lazy' }),
      h('div', { class: 'a-body' },
        h('div', { class: 'a-title' }, h('span', { class: `badge ${i.kind === 'render' || i.kind === 'cut' ? 'render' : i.kind === 'result' ? 'result' : 'look'}` }, labels[i.kind].replace(/s$/, '')), h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, i.title)),
        h('span', { class: 'muted' }, i.sub),
        h('span', { class: 'a-meta' }, `${i.meta} · ${new Date(i.created).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`),
        h('div', { class: 'a-actions' }, ...i.actions)))) : [h('div', { class: 'empty-state', style: 'grid-column:1/-1' }, 'Nothing here yet.')]));
  };
  draw();
  const dlg = h('dialog', { class: 'assets', id: 'assets-dialog', 'aria-labelledby': 'assets-title' },
    h('div', { class: 'dialog-head' }, h('h2', { id: 'assets-title' }, `Library · ${project.title}`), h('button', { class: 'btn sm', type: 'button', title: 'Design every cast member’s look and the project style in one board', onclick: () => { dlg.close(); openLooks(); } }, 'Cast images'), h('a', { class: 'btn sm', href: `/api/director/export?id=${project.id}`, download: '' }, 'Export project (.zip)'), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'assets-body' }, seg, h('p', { class: 'note', style: 'margin:0' }, 'Everything here lives in this project’s own folder, so exporting it carries videos, films, blockouts and images together.'), grid));
  document.body.append(dlg); dlg.showModal();
}

// ---------- Object looks & generation ----------
let looksBoard: { refresh(): void } | null = null;
function openLooks() {
  looksBoard = openLooksBoard({ project: () => project, edit: ops => edit(ops), refgen: () => refgen as any, reloadRefgen: () => loadRefgen(), openObject: id => { if (step === 'cut') setStep('build'); select(id); openObject(); } });
}
async function loadRefgen() {
  try {
    refgen = await api(`director/refgen?projectId=${projectId}`);
    stillPresets = refgen.presets.filter(p => p.backend === 'cloud' && (p.maxRefs ?? 0) > 0).sort((a, b) => (a.id === STRONG_GUIDE_MODEL ? -1 : b.id === STRONG_GUIDE_MODEL ? 1 : 0) || (a.followsGuide === 'strong' ? 0 : 1) - (b.followsGuide === 'strong' ? 0 : 1));
    // BFL image models only for now (FLUX 3 first).
    refgen.presets = refgen.presets.filter(p => /^flux/.test(p.id)).sort((a, b) => (a.id === 'flux-3' ? -1 : b.id === 'flux-3' ? 1 : 0));
    renderObjectPane(); shotPane.dataset.shot = ''; renderShotPane(); } catch (e) { toast((e as Error).message, true); }
}
function lookCard(e: Entity, r: Reference) {
  const primary = e.look === r.id;
  return h('div', { class: 'ref' + (primary ? ' primary' : '') },
    h('img', { src: refUrl(r), alt: r.name, loading: 'lazy', title: r.generated ? `${r.generated.model} · seed ${r.generated.seed}\n${r.generated.prompt}` : r.name }),
    h('div', { class: 'ref-body' },
      h('div', { class: 'ref-name' }, h('span', { title: r.name }, r.name), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': `Remove image ${r.name}`, title: 'Remove image (file is kept)', onclick: () => void edit([{ op: 'remove_reference', referenceId: r.id }]) }, '✕')),
      h('span', { class: 'link' + (r.generated ? '' : ' none') }, r.generated ? `✦ ${r.generated.model.split(' (')[0]}` : 'Uploaded'),
      h('button', { class: 'btn sm' + (primary ? ' camera' : ''), type: 'button', disabled: primary, onclick: () => void edit([{ op: 'set_look', entityId: e.id, referenceId: r.id }]) }, primary ? '★ Primary image' : 'Make primary')));
}
let checkpoints: string[] | null = null, checkpointError = '';
async function loadCheckpoints() {
  try { const r = await api('director/refgen/checkpoints'); checkpoints = r.checkpoints; checkpointError = r.error || ''; }
  catch (e) { checkpoints = []; checkpointError = (e as Error).message; }
  objectPane.dataset.id = ''; renderObjectPane();
}
// ---------- Cast (Shot tab) and Cast Card helpers ----------
/** Every object, ticked when it's in this shot. The camera decides by default; ticks override it. */
function castBlock(s: Shot) {
  const rows = castRows(project, s);
  const inCast = rows.filter(r => r.inCast), out = rows.filter(r => !r.inCast);
  const toggle = (r: (typeof rows)[number]) => {
    const before = normalizeCast(s.cast), next = normalizeCast(s.cast), id = r.entity.id;
    next.include = next.include.filter(x => x !== id); next.exclude = next.exclude.filter(x => x !== id);
    if (r.inCast && r.auto) next.exclude.push(id);       // camera sees it, but leave it out
    else if (!r.inCast && !r.auto) next.include.push(id); // camera doesn't see it, but put it in
    void runEntry({ label: r.inCast ? 'Remove from cast' : 'Add to cast', redo: [{ op: 'update_shot', id: s.id, patch: { cast: next } }], undo: [{ op: 'update_shot', id: s.id, patch: { cast: before } }] });
  };
  const colors = objectColors(project, s);
  // Lead with what the prompt is about: characters, vehicles, props, then described scenery. Bare set pieces fold away.
  const ORDER = ['character', 'vehicle', 'prop', 'environment'];
  const described = (r: (typeof rows)[number]) => r.entity.kind !== 'environment' || !!castCard(project, r.entity.id)?.description || objectLooks(project, r.entity.id).length > 0;
  const featured = inCast.filter(described).sort((a, b) => ORDER.indexOf(a.entity.kind) - ORDER.indexOf(b.entity.kind));
  const pieces = inCast.filter(r => !described(r));
  const row = (r: (typeof rows)[number]) => {
    const card = castCard(project, r.entity.id)!, looks = objectLooks(project, r.entity.id), look = looks[0];
    const open = selected === r.entity.id, c = colors.get(r.entity.id);
    const why = r.override === 'added' ? 'Added by you' : r.override === 'removed' ? 'Left out by you' : r.auto ? `${Math.round(r.coverage * 100)}% of frame${r.lead ? ' · subject' : ''}` : 'Not in frame';
    const box = h('input', { type: 'checkbox', checked: r.inCast, 'aria-label': `${r.entity.name} in this shot`, title: r.inCast ? 'In the video prompt · untick to leave it out' : 'Add to this shot' });
    box.onchange = () => toggle(r);
    box.onclick = (ev: Event) => ev.stopPropagation();
    const id = r.entity.id;
    return h('div', { class: 'cast-row' + (r.inCast ? ' in' : '') + (open ? ' open' : '') + (c ? ' colored' : ''), 'data-cast': id, style: c ? `--c:${c}` : '',
      onmouseenter: () => { scene.setHover(id); highlightPrompt(id); }, onmouseleave: () => { scene.setHover(null); highlightPrompt(selected); } },
      h('div', { class: 'cast-head', role: 'button', tabindex: 0, 'aria-expanded': String(open), title: open ? 'Close' : 'Open: Cast Card, images and generation',
        onkeydown: (ev: KeyboardEvent) => { if (ev.target === ev.currentTarget && ['Enter', ' '].includes(ev.key)) { ev.preventDefault(); ev.stopPropagation(); (ev.currentTarget as HTMLElement).click(); } },
        onclick: () => { if (selected === id) selection.clear(); else { selection.set([id], id); if (scene.view() === 'set') scene.pivotOn(id); openObject(); } } },
        box,
        look ? h('img', { class: 'cast-thumb', src: refUrl(look), alt: '' }) : h('span', { class: 'cast-ph' }, shapeIcon(r.entity.shape)),
        h('div', { class: 'cast-main' },
          h('span', { class: 'cast-name' }, r.entity.name),
          h('span', { class: 'cast-why' }, why, looks.length ? ` · ${looks.length} image${looks.length === 1 ? '' : 's'}` : '', card.sharedFrom ? ` · shares ${entity(card.sharedFrom)?.name}` : ''),
          r.inCast && card.description ? h('span', { class: 'cast-desc', hidden: open }, card.description) : null),
        h('span', { class: 'cast-chev', 'aria-hidden': 'true' }, '›')),
      h('div', { class: 'cast-slot', 'data-cast-slot': id }));
  };
  return h('div', { class: 'block' },
    h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, `In this shot · ${featured.length}`), h('button', { class: 'btn ghost sm', type: 'button', hidden: !rows.length, title: 'Every cast member’s image and the project style in one board', onclick: () => openLooks() }, 'Cast images')),
    ...featured.map(row),
    pieces.length ? h('details', { class: 'cast-out', open: pieces.some(r => r.entity.id === selected) }, h('summary', {}, `${pieces.length} set piece${pieces.length === 1 ? '' : 's'} in frame · no Cast Card`), ...pieces.map(row)) : null,
    out.length ? h('details', { class: 'cast-out', open: out.some(r => r.entity.id === selected) }, h('summary', {}, `${out.length} not in this shot`), ...out.map(row)) : null);
}
/** Add any image already in the project as this object's reference. */
function linkPicker(e: Entity) {
  const mine = new Set(objectLooks(project, e.id).map(r => r.file));
  const pool = [...(project.scene.references || []).filter(r => entity(r.entityId)), ...project.shots.flatMap(s => s.references)].filter(r => !mine.has(r.file));
  const seen = new Set<string>(), list = pool.filter(r => !seen.has(r.file) && seen.add(r.file));
  if (!list.length) return null;
  return h('details', { class: 'cc-link' }, h('summary', {}, 'Add from project images'),
    h('div', { class: 'cc-grid' }, ...list.slice(0, 40).map(r => h('button', { type: 'button', title: `${r.name}${r.entityId ? ` · ${entity(r.entityId)?.name}` : ''}`, onclick: () => void edit([{ op: 'link_look', entityId: e.id, referenceId: r.id }]).then(() => toast(`Added to ${e.name}’s Cast Card`)).catch(() => {}) }, h('img', { src: refUrl(r), alt: r.name, loading: 'lazy' })))));
}
function renderObjectPane() {
  if (objectPane.contains(document.activeElement) && objectPane.dataset.id === (selected || '')) return;
  objectPane.dataset.id = selected || '';
  const e = entity(selected);
  if (!e) { objectPane.replaceChildren(h('div', { class: 'empty-state', style: 'margin:8px' }, 'Select an object to design its image. ', h('button', { class: 'btn sm', type: 'button', onclick: () => openLooks() }, 'Open cast images'))); return; }
  if (selection.ids.length > 1) { objectPane.replaceChildren(h('div', { class: 'group-bar' }, h('span', {}, `${selection.ids.length} objects selected`), h('button', { class: 'btn sm', type: 'button', onclick: () => void groupSelection() }, 'Group', h('kbd', {}, '⌘G'))), inspector, h('p', { class: 'note' }, 'Select one object to design or generate its image.')); return; }
  if (e.shape === 'group') { const n = withDescendants(project.scene.entities, [e.id]).length - 1; objectPane.replaceChildren(h('div', { class: 'group-bar' }, h('span', {}, `Group · ${n} object${n === 1 ? '' : 's'} inside`), h('button', { class: 'btn sm ghost', type: 'button', onclick: () => void ungroupSelection() }, 'Ungroup', h('kbd', {}, '⇧⌘G'))), inspector, h('p', { class: 'note' }, 'Move, rotate or resize the group and everything inside follows. Click an object inside it in the viewport to edit just that part.')); return; }
  const looks = objectLooks(project, e.id), primary = looks[0];
  const source = lookSource(project, e.id), shared = source && source.id !== e.id ? source : null;
  const views = lookViews(e);
  const form = genForm[e.id] ||= { prompt: '', presetId: [localStorage.getItem('previs.looks.model'), 'flux-3'].find(id => id && refgen.presets.some(p => p.id === id)) || refgen.presets[0]?.id || 'flux-3', aspect: '', count: 2, seed: Math.floor(Math.random() * 1e6), checkpoint: '', view: Object.keys(views)[0], edited: false };
  if (!views[form.view]) form.view = Object.keys(views)[0];
  if (!form.edited) form.prompt = lookPrompt(project, e, form.view);
  if (!form.aspect || !form.edited) form.aspect = aspectFor(e, form.view);
  const rerender = () => { objectPane.dataset.id = ''; renderObjectPane(); };
  const preset = refgen.presets.find(p => p.id === form.presetId) || refgen.presets[0];
  const inShots = project.shots.map((s, i) => ({ s, i })).filter(x => shotCast(project, x.s).some(c => c.entity.id === e.id));

  // Description and style feed every look and every shot prompt.
  const styleNotes = h('textarea', { class: 'field', rows: 2, maxlength: 300, 'aria-label': 'Style notes', placeholder: 'How it should look on screen: “weathered, dusty, warm rim light”, “clean showroom chrome”…' }, e.styleNotes || '');
  styleNotes.onchange = () => void edit([{ op: 'update_entity', id: e.id, patch: { styleNotes: styleNotes.value } }]).then(rerender).catch(() => {});
  const notes = h('textarea', { class: 'field', rows: 3, maxlength: 500, 'aria-label': 'Description', placeholder: e.kind === 'character' ? 'Age, build, wardrobe, hair, materials…' : e.kind === 'vehicle' ? 'Make, era, paint, damage, details…' : 'Materials, colour, condition, details…' }, e.notes || '');
  notes.onchange = () => void runEntry({ label: 'Edit description', redo: [{ op: 'update_entity', id: e.id, patch: { notes: notes.value } }], undo: [{ op: 'update_entity', id: e.id, patch: { notes: e.notes } }] }).then(rerender).catch(() => {});
  const styleText = project.scene.environment.style;

  const prompt = h('textarea', { class: 'field', rows: 5, 'aria-label': 'Look prompt' }, form.prompt);
  prompt.oninput = () => { form.prompt = prompt.value; form.edited = true; editedTag.hidden = false; };
  const editedTag = h('span', { class: 'ob-edited', hidden: !form.edited }, 'edited');
  const viewChips = h('div', { class: 'ob-views', role: 'radiogroup', 'aria-label': 'View' }, ...Object.entries(views).map(([k, label]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(k === form.view), class: k === form.view ? 'on' : '', onclick: () => { form.view = k; form.edited = false; rerender(); } }, label)));
  const presetSel = h('select', { class: 'field', 'aria-label': 'Model' }, ...refgen.presets.map(p => h('option', { value: p.id, selected: p.id === form.presetId }, `${p.title}${p.backend === 'cloud' ? ' · Cloud' : ''}`)));
  presetSel.onchange = () => { form.presetId = presetSel.value; localStorage.setItem('previs.looks.model', presetSel.value); rerender(); };
  const aspect = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Aspect' }, ...['1:1', '3:4', '4:3', '16:9'].map(a => h('button', { type: 'button', class: a === form.aspect ? 'on' : '', onclick: () => { form.aspect = a; form.edited = true; rerender(); } }, a)));
  const count = h('select', { class: 'field', 'aria-label': 'Images' }, ...[1, 2, 3, 4].map(n => h('option', { value: n, selected: n === form.count }, `${n} image${n > 1 ? 's' : ''}`)));
  count.onchange = () => { form.count = Number(count.value); quoteBtn.textContent = `Generate image${form.count > 1 ? 's' : ''}${estLabel(form.presetId, form.count)}`; };
  const seed = h('input', { class: 'field', type: 'number', min: 0, value: form.seed, 'aria-label': 'Seed' });
  seed.onchange = () => { form.seed = Math.max(0, Math.floor(Number(seed.value) || 0)); };
  const ckpt = h('select', { class: 'field', 'aria-label': 'Checkpoint' }, ...(checkpoints === null ? [h('option', { value: '' }, 'Loading installed checkpoints…')] : checkpoints.length ? checkpoints.map(c => h('option', { value: c, selected: c === form.checkpoint }, c)) : [h('option', { value: '' }, checkpointError || 'No checkpoints installed')]));
  if (preset?.backend === 'local' && checkpoints === null) void loadCheckpoints();
  if (checkpoints?.length && !checkpoints.includes(form.checkpoint)) form.checkpoint = checkpoints.find(c => /v1-5|sd|xl/i.test(c)) || checkpoints[0];
  ckpt.onchange = () => { form.checkpoint = ckpt.value; };
  const quoteBtn = h('button', { class: 'btn camera', type: 'button' }, `Generate image${form.count > 1 ? 's' : ''}${estLabel(form.presetId, form.count)}`);
  const quoteStatus = h('div', { class: 'status-line' });
  quoteBtn.onclick = async () => {
    quoteBtn.disabled = true; quoteStatus.className = 'status-line'; quoteStatus.textContent = 'Sending…';
    try {
      const { job } = await api('director/refgen/prepare', { projectId, entityId: e.id, presetId: form.presetId, prompt: form.prompt, aspect: form.aspect, count: form.count, seed: form.seed, ...(form.checkpoint ? { checkpoint: form.checkpoint } : {}) });
      await generateNow(job); objectPane.dataset.id = ''; renderObjectPane();
    }
    catch (err) { quoteStatus.className = 'status-line err'; quoteStatus.textContent = (err as Error).message; }
    finally { quoteBtn.disabled = false; }
  };
  const jobs = refgen.jobs.filter(j => j.entityId === e.id);
  const quoted = jobs.find(j => j.status === 'quoted');
  const upload = h('label', { class: 'ob-add', title: `Upload images for ${e.name}` }, h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true, onchange: (ev: Event) => void uploadRefs(Array.from((ev.target as HTMLInputElement).files || []), e.id) }), '＋', h('small', {}, 'Upload'));
  dropTarget(upload, files => uploadRefs(files, e.id));
  const hero = h('div', { class: 'ob-hero' + (primary ? '' : ' empty') },
    primary ? h('img', { src: refUrl(primary), alt: `${e.name} image`, title: primary.generated ? `${primary.generated.model} · seed ${primary.generated.seed}\n${primary.generated.prompt}` : primary.name }) : h('div', { class: 'ob-ph' }, shapeIcon(e.shape), h('span', {}, 'No image yet — generate one below or drop an image here')),
    primary ? h('span', { class: 'ob-badge' }, '★ Primary · ', primary.generated ? primary.generated.model.split(' (')[0] : 'uploaded') : null);
  dropTarget(hero, files => uploadRefs(files, e.id));
  const strip = h('div', { class: 'ob-strip' }, ...looks.map(r => h('div', { class: 'ob-thumb' + (r.id === e.look ? ' on' : ''), title: r.id === e.look ? 'Primary image' : 'Make primary' },
    h('button', { type: 'button', class: 'ob-thumb-img', 'aria-label': r.id === e.look ? `${r.name} (primary)` : `Make ${r.name} primary`, onclick: () => void edit([{ op: 'set_look', entityId: e.id, referenceId: r.id }]) }, h('img', { src: refUrl(r), alt: '', loading: 'lazy' })),
    h('button', { type: 'button', class: 'ob-x', 'aria-label': `Remove image ${r.name}`, title: 'Remove image (file is kept)', onclick: () => void edit([{ op: 'remove_reference', referenceId: r.id }]) }, '✕'))), upload);
  // Share another object's look and description (e.g. every police car uses Police 1).
  const others = project.scene.entities.filter(x => x.id !== e.id && lookSource(project, x.id)?.id !== e.id).sort((a, b) => (b.kind === e.kind ? 1 : 0) - (a.kind === e.kind ? 1 : 0) || a.name.localeCompare(b.name));
  const shareSel = h('select', { class: 'field', 'aria-label': 'Image' }, h('option', { value: '' }, 'Its own image'), ...others.map(x => h('option', { value: x.id, selected: e.lookFrom === x.id }, `Same as ${x.name}${objectLooks(project, x.id).length ? '' : ' (no image yet)'}`)));
  shareSel.onchange = () => { const before = e.lookFrom || null, after = shareSel.value || null; void runEntry({ label: after ? 'Share image' : 'Own image', redo: [{ op: 'update_entity', id: e.id, patch: { lookFrom: after } }], undo: [{ op: 'update_entity', id: e.id, patch: { lookFrom: before } }] }).then(rerender); };
  const sameKind = project.scene.entities.filter(x => x.id !== e.id && x.kind === e.kind && x.shape === e.shape && !x.lookFrom && !objectLooks(project, x.id).length && (x.lookFrom !== e.id));
  const shareAll = !shared && looks.length && sameKind.length ? h('button', { class: 'btn sm', type: 'button', title: sameKind.map(x => x.name).join(', '), onclick: () => void runEntry({ label: 'Share image', redo: sameKind.map(x => ({ op: 'update_entity', id: x.id, patch: { lookFrom: e.id } })), undo: sameKind.map(x => ({ op: 'update_entity', id: x.id, patch: { lookFrom: null } })) }).then(() => toast(`${sameKind.length} object${sameKind.length === 1 ? '' : 's'} now use ${e.name}’s image`)) }, `Use for ${sameKind.length} similar ${e.shape}${sameKind.length === 1 ? '' : 's'} without an image`) : null;
  const usedBy = project.scene.entities.filter(x => x.lookFrom === e.id);
  objectPane.replaceChildren(...([
    inspector,
    h('div', { class: 'block object-visual' },
      h('div', { class: 'block-head' }, h('strong', { style: 'flex:1' }, 'Image'), h('button', { class: 'btn primary sm', type: 'button', onclick: () => { if (shared) { select(shared.id); return; } const form = objectPane.querySelector<HTMLDetailsElement>('.object-generate'); if (form) { form.open = true; form.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); form.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true }); } } }, shared ? 'Edit shared image…' : 'Generate image…')),
      h('div', { class: 'ob-shots' }, ...(inShots.length ? [h('span', { class: 'muted' }, 'In shot'), ...inShots.map(x => h('button', { type: 'button', class: 'chip', title: x.s.title, onclick: () => selectShot(x.s.id) }, String(x.i + 1).padStart(2, '0')))] : [h('span', { class: 'muted' }, 'No shot camera sees this object yet.')])),
      hero, shared ? null : strip,
      h('details', { class: 'object-reference-options' }, h('summary', {}, 'Share an image from another object'), h('label', { class: 'ob-share' }, h('span', { class: 'muted' }, 'Image'), shareSel), shared ? null : linkPicker(e), shareAll),
      shared ? h('p', { class: 'note', style: 'margin:0' }, `Uses ${shared.name}’s images and description. Change them on `, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => select(shared.id) }, shared.name), '.') : null,
      usedBy.length ? h('p', { class: 'note', style: 'margin:0' }, `Shared with ${usedBy.map(x => x.name).join(', ')}.`) : null,
      h('p', { class: 'note', style: 'margin:0' }, 'Sent with every shot that includes ', h('strong', {}, e.name), '; each video model takes a limited number of images.')),
    h('div', { class: 'block cast-card' },
      h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, 'Appearance')),
      h('label', { class: 'cc-field' }, h('span', {}, shared ? 'Description · extra notes for this one' : 'Description'), shared ? h('p', { class: 'note', style: 'margin:0' }, `From ${shared.name}’s Cast Card: ${shared.notes || '—'}`) : null, notes),
      h('label', { class: 'cc-field' }, h('span', {}, 'Style notes'), styleNotes),
      h('div', { class: 'ob-style' }, h('span', { class: 'muted' }, 'Project style: '), styleText ? h('span', {}, styleText) : h('span', { class: 'muted' }, 'not set'), h('button', { class: 'btn ghost sm', type: 'button', onclick: () => openLooks() }, styleText ? 'Edit' : 'Set style')),
      h('p', { class: 'note', style: 'margin:0' }, 'Description and style go into this object’s images and every shot it appears in. Its primary image is sent with those shots’ videos.')),
    shared ? null : sheetSection(e), // [designsheet]
    shared ? null : h('details', { class: 'block object-generate', open: form.open, ontoggle: (ev: Event) => { form.open = (ev.currentTarget as HTMLDetailsElement).open; } },
      h('summary', {}, 'Generate an image for ', e.name),
      h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, 'Image request'), editedTag, h('button', { class: 'btn ghost sm', type: 'button', disabled: !form.edited, onclick: () => { form.edited = false; rerender(); } }, 'Reset')),
      viewChips, prompt,
      h('div', { class: 'grid2' }, h('label', {}, 'Model', presetSel), h('label', {}, 'Images', count)),
      preset ? h('p', { class: 'note', style: 'margin:0' }, preset.note, preset.backend === 'cloud' && !refgen.cloudCredential ? ' Cloud key not configured on this server — quoting will fail.' : '') : null,
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--muted)' }, 'Aspect', aspect),
      h('details', { class: 'ob-more' }, h('summary', {}, 'Seed', preset?.backend === 'local' ? ' & checkpoint' : ''), h('div', { class: 'grid2' }, h('label', {}, 'Seed', seed), preset?.backend === 'local' ? h('label', {}, 'Checkpoint', ckpt) : h('span'))),
      h('div', { style: 'display:flex;gap:8px;align-items:center' }, quoteBtn),
      quoteStatus),
    jobs.filter(j => j.status !== 'quoted').length ? h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, 'Requests')), ...jobs.filter(j => j.status !== 'quoted').slice(0, 6).map(jobRow)) : null].filter(Boolean) as Node[]));
}
/** Estimated cost shown on Generate buttons. */
function estLabel(presetId: string, count: number) {
  const p: any = refgen.presets.find(x => x.id === presetId);
  if (p?.backend === 'local') return ' · free (local)';
  const usd = p?.pricing?.usdPerImage; return usd != null ? ` · ≈ $${(usd * count).toFixed(2)}` : '';
}
/** One click: the prepared request is sent once (the click is the approval). Never retried. */
async function generateNow(job: any) {
  const free = job.quote?.status === 'known' && job.quote.amount === 0;
  const est = job.quote?.estimate ?? 0.5;
  await api('director/refgen/submit', { projectId, requestId: job.id, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: free ? 0 : Math.max(0.5, Math.ceil(est * 200) / 100), ...(free ? {} : { allowUnknownCharges: true }) } } });
  await loadRefgen(); pollJobs();
}
function quoteCard(job: any) {
  const free = job.quote.status === 'known' && job.quote.amount === 0;
  const blocked = !free && !refgen.paidExecutionEnabled;
  const approve = h('input', { type: 'checkbox' });
  const unknown = h('input', { type: 'checkbox' });
  const max = h('input', { class: 'field', type: 'number', min: 0, step: 0.01, value: free ? 0 : Math.max(0.5, Math.ceil(((job.quote.estimate ?? 0.5) * 1.5) * 100) / 100), 'aria-label': 'Maximum USD', style: 'width:96px' });
  const go = h('button', { class: 'btn camera', type: 'button', disabled: true }, free ? 'Generate' : 'Approve & generate');
  const sync = () => { go.disabled = blocked || !approve.checked || (!free && !unknown.checked); };
  approve.onchange = unknown.onchange = sync;
  const status = h('div', { class: 'status-line' });
  go.onclick = async () => {
    go.disabled = true;
    try {
      await api('director/refgen/submit', { projectId, requestId: job.id, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: Number(max.value) || 0, ...(free ? {} : { allowUnknownCharges: true }) } } });
      objectPane.dataset.id = ''; shotPane.dataset.shot = ''; await loadRefgen(); pollJobs();
    } catch (err) { status.className = 'status-line err'; status.textContent = (err as Error).message; sync(); }
  };
  return h('div', { class: 'prompt-box', style: 'display:flex;flex-direction:column;gap:8px;white-space:normal' },
    h('div', { class: 'facts' }, 'Model', h('b', {}, job.model), 'Runs on', h('b', {}, job.backend.kind === 'cloud' ? 'Comfy Cloud' : job.backend.url), 'Images', h('b', {}, `${job.count} · ${job.aspect} · seed ${job.seed}`), 'Estimated cost', h('b', { style: `color:${free ? 'var(--ok)' : 'var(--warn)'}` }, job.quote.label), 'Quote', h('b', {}, job.fingerprint.slice(0, 12))),
    h('label', { style: 'display:flex;gap:8px;align-items:center' }, approve, 'I approve this exact request'),
    free ? null : h('label', { style: 'display:flex;gap:8px;align-items:center' }, unknown, 'I accept the Cloud total is unknown, up to', max, 'USD'),
    h('div', { style: 'display:flex;gap:8px;align-items:center' }, go, blocked ? h('span', { class: 'note' }, 'Paid generation is off on this server (PREVIS_ALLOW_PAID≠1). Nothing will be sent.') : null),
    status);
}
function jobRow(job: any) {
  const color = job.status === 'completed' ? 'var(--ok)' : job.status === 'failed' || job.status === 'uncertain' || job.status === 'invalidated' ? 'var(--bad)' : 'var(--warn)';
  return h('div', { style: 'display:flex;flex-direction:column;gap:2px;font-size:12px;border-top:1px solid var(--line);padding-top:6px' },
    h('div', { style: 'display:flex;gap:8px' }, h('b', { style: `color:${color};font-weight:600` }, job.status), h('span', { class: 'muted', style: 'flex:1' }, `${job.model.split(' (')[0]} · ${job.count} img`), job.status === 'submitted' ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => void trackJob(job.id) }, 'Check') : null),
    h('span', { class: 'note' }, job.message),
    ['uploading', 'submitting', 'submitted', 'uncertain'].includes(job.status) ? progressSlot(projectId, 'refgen', job.id, job.entityName || 'Image', 'requests') : null); // [live-progress]
}
async function trackJob(id: string) {
  try { await api('director/refgen/track', { projectId, requestId: id }); } catch (e) { toast((e as Error).message, true); }
  await loadRefgen();
}
let pollingJobs = false;
function pollJobs() {
  if (pollingJobs) return; pollingJobs = true;
  const step = async () => {
    const live = refgen.jobs.filter(j => j.status === 'submitted');
    if (!live.length) { pollingJobs = false; return; }
    for (const j of live) await api('director/refgen/track', { projectId, requestId: j.id }).catch(() => {});
    await loadRefgen(); setTimeout(step, 4000);
  };
  setTimeout(step, 3000);
}

// ---------- Actions ----------
function selectShot(id: string) { shotId = id; playhead = 0; playing = false; apply(project); }
function select(id: string | null) { if (id) selection.set([id], id); else selection.clear(); }
// One panel: the shot, its cast, and the selected object opened in place inside its cast row.
function openObject() {
  if (collapsed.side) setCollapsed('side', false);
  placeObjectPane(true);
}
const colorOf = (id: string | null) => (id ? objectColors(project, shot()).get(id) ?? null : null);
/** Put the selected object's editor inside its cast row (or at the top when it isn't in the cast). */
function placeObjectPane(scroll = false) {
  for (const row of Array.from(shotPane.querySelectorAll<HTMLElement>('[data-cast]'))) {
    const open = row.dataset.cast === selected; row.classList.toggle('open', open);
    row.querySelector('.cast-head')?.setAttribute('aria-expanded', String(open));
    const desc = row.querySelector<HTMLElement>('.cast-desc'); if (desc) desc.hidden = open;
  }
  if (mobile?.active()) { mobile.placeObject(objectPane, selected); return; }
  if (!selected) { objectPane.remove(); highlightPrompt(null); return; }
  objectPane.hidden = false;
  const slot = shotPane.querySelector(`[data-cast-slot="${selected}"]`);
  if (slot) { if (objectPane.parentElement !== slot) slot.append(objectPane); }
  else { objectPane.classList.add('loose'); const castBody = shotPane.querySelector('[data-sec="cast"] .sec-body'); if (castBody) { if (castBody.firstElementChild !== objectPane) castBody.prepend(objectPane); } else shotPane.prepend(objectPane); }
  openSection('cast');
  const group = slot?.closest('details'); if (group) group.open = true;
  if (slot) objectPane.classList.remove('loose');
  highlightPrompt(selected);
  if (scroll) requestAnimationFrame(() => (slot?.closest('.cast-row') || objectPane).scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }));
}
/** Light up an object's words in the prompt (and its chip); everything else steps back. */
function highlightPrompt(id: string | null) {
  shotPane.classList.toggle('hl-on', !!id && !!shotPane.querySelector(`[data-ids~="${id}"]`));
  shotPane.querySelectorAll<HTMLElement>('[data-ids]').forEach(el => el.classList.toggle('hl', !!id && el.dataset.ids!.split(' ').includes(id)));
}
function setView(v: 'set' | 'camera') {
  scene.setView(v); setBtn.classList.toggle('on', v === 'set'); camBtn.classList.toggle('on', v === 'camera');
  viewport.classList.toggle('camview', v === 'camera');
  if (v === 'camera' && !coach.hidden) { coach.hidden = true; localStorage.setItem('previs.coach.viewport', '1'); }
}
async function addShot() {
  const s = shot();
  const r = await edit([{ op: 'add_shot', index: project.shots.indexOf(s) + 1, shot: { duration: s.duration, camera: { ...s.camera, keys: s.camera.move === 'custom' ? s.camera.keys : null } } }]);
  selectShot(r.results[0].id);
}
async function addObject(shape: string) {
  addMenu.hidden = true; addPopup.hidden = true;
  const t = scene.orbitTarget(), id = crypto.randomUUID();
  // Blockout assets land at the orbit target on the ground, like Otter.
  const ok = await runEntry({ label: `Add ${shape}`, redo: [{ op: 'add_entity', entity: { id, name: shape[0].toUpperCase() + shape.slice(1), shape, position: [snap(t[0], 0.1), 0, snap(t[2], 0.1)] } }], undo: [{ op: 'remove_entity', id }] });
  if (ok) selection.set([id], id);
}
async function uploadRefs(files: File[], entityId: string | null) {
  const images = files.filter(f => /^image\/(png|jpeg|webp)$/.test(f.type));
  if (!images.length) { toast('Drop PNG, JPEG or WebP images', true); return; }
  for (const f of images) {
    if (f.size > 10 * 1024 * 1024) { toast(`${f.name} is over 10 MB`, true); continue; }
    try {
      const r = await api('director/reference', { projectId, shotId, name: f.name, data: await readFileBase64(f), entityId, ...(entityId ? { scope: 'object' } : {}) });
      apply(r.project);
      if (entityId) toast(`${f.name} added as a look for ${entity(entityId)?.name}`);
    } catch (e) { toast((e as Error).message, true); }
  }
}
function dropTarget(el: HTMLElement, onFiles: (files: File[]) => void, onState?: (on: boolean) => void) {
  let depth = 0;
  el.addEventListener('dragenter', ev => { if (!ev.dataTransfer?.types.includes('Files')) return; ev.preventDefault(); depth++; el.classList.add('drag'); onState?.(true); });
  el.addEventListener('dragover', ev => { if (ev.dataTransfer?.types.includes('Files')) ev.preventDefault(); });
  el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.classList.remove('drag'); onState?.(false); } });
  el.addEventListener('drop', ev => { ev.preventDefault(); depth = 0; el.classList.remove('drag'); onState?.(false); onFiles(Array.from(ev.dataTransfer?.files || [])); });
}

// Drop an image straight onto an object in the viewport to link it.
viewport.addEventListener('dragover', ev => { if (ev.dataTransfer?.types.includes('Files')) { ev.preventDefault(); dropHint.hidden = false; const id = scene.pick(ev.clientX, ev.clientY); dropHint.textContent = id ? `Add as a look for ${entity(id)?.name}` : 'Drop on an object to link it — or anywhere to add a shot reference'; } });
viewport.addEventListener('dragleave', ev => { if (!viewport.contains(ev.relatedTarget as Node)) dropHint.hidden = true; });
viewport.addEventListener('drop', ev => { ev.preventDefault(); dropHint.hidden = true; const id = scene.pick(ev.clientX, ev.clientY); void uploadRefs(Array.from(ev.dataTransfer?.files || []), id).then(() => { if (id) select(id); }); });

// ---------- Playback ----------
function togglePlay(force?: boolean) {
  playing = force ?? !playing;
  if (playing && playhead >= shot().duration - 0.001) playhead = 0;
  lastTick = performance.now(); renderTransport();
}
function tick(now: number) {
  if (playing) {
    playhead = Math.min(shot().duration, playhead + (now - lastTick) / 1000);
    if (playhead >= shot().duration) playing = false;
    scene.setPlayhead(playhead); renderTransport();
  }
  lastTick = now; requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
playBtn.onclick = () => togglePlay();
previewBtn.onclick = () => { if (playing) { togglePlay(false); return; } setView('camera'); playhead = 0; togglePlay(true); };
for (const k of Object.keys(stepBtns) as Step[]) stepBtns[k].onkeydown = (ev: KeyboardEvent) => { const order: Step[] = ['build', 'shoot', 'cut']; if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return; const n = order[(order.indexOf(k) + (ev.key === 'ArrowRight' ? 1 : 2)) % 3]; setStep(n); stepBtns[n].focus(); };
scrub.oninput = () => { playhead = Number(scrub.value); playing = false; scene.setPlayhead(playhead); renderTransport(); renderInspector(); };
monitor.onclick = () => setView('camera');
monitor.onkeydown = ev => { if (ev.key === 'Enter') setView('camera'); };
titleInput.onchange = () => void edit([{ op: 'set_project', patch: { title: titleInput.value } }]);

// ---------- Keyframes ----------
const KEY_EPS = 0.005;
function insertKeys(ids = selection.ids) {
  const t = scene.sceneTime(), list = ids.map(id => entity(id)).filter(Boolean) as Entity[];
  if (!list.length) return toast('Select an object to keyframe');
  void runEntry({ label: `Keyframe ${list.length > 1 ? `${list.length} objects` : list[0].name} @ ${t.toFixed(2)}s`,
    redo: list.map(e => { const a = entityAt(e, t); const keyR = e.path?.some(k => Number.isFinite(k.r)); const keyS = e.path?.some(k => Array.isArray(k.s));
      return { op: 'update_entity', id: e.id, patch: { path: upsertKey(e.path, t, a.position, keyR ? a.rotation : undefined, keyS ? a.scale : undefined) } }; }),
    undo: list.map(e => ({ op: 'update_entity', id: e.id, patch: { path: e.path ? structuredClone(e.path) : null } })) });
}
function deleteKeysHere(ids = selection.ids) {
  const t = scene.sceneTime(), list = (ids.map(id => entity(id)).filter(Boolean) as Entity[]).filter(e => e.path?.some(k => Math.abs(k.t - t) <= KEY_EPS));
  if (!list.length) return toast(`No keyframe at ${t.toFixed(2)}s on the selection`);
  void runEntry({ label: `Delete keyframe @ ${t.toFixed(2)}s`, redo: list.map(e => ({ op: 'update_entity', id: e.id, patch: { path: removeKeys(e.path, [t]), position: entityAt(e, t).position } })), undo: list.map(e => ({ op: 'update_entity', id: e.id, patch: { path: structuredClone(e.path), position: e.position } })) });
}
function selectionKeyTimes() {
  const times = new Set<number>();
  for (const id of selection.ids) for (const k of entity(id)?.path || []) times.add(k.t);
  return [...times].sort((a, b) => a - b);
}
function jumpKey(dir: 1 | -1) {
  const s = shot(), start = s.start || 0, now = scene.sceneTime();
  const inShot = selectionKeyTimes().filter(t => t >= start - KEY_EPS && t <= start + s.duration + KEY_EPS);
  const next = dir > 0 ? inShot.find(t => t > now + KEY_EPS) : [...inShot].reverse().find(t => t < now - KEY_EPS);
  if (next === undefined) return toast(dir > 0 ? 'No later keyframe in this shot' : 'No earlier keyframe in this shot');
  playing = false; playhead = Math.max(0, Math.min(s.duration, next - start)); scene.setPlayhead(playhead); renderTransport(); renderInspector();
}
function renderKeyTrack() {
  const s = shot(), start = s.start || 0, times = selectionKeyTimes();
  const sig = JSON.stringify([s.id, start, s.duration, selection.ids, times]);
  if (keyTrack.dataset.sig === sig) {
    keyTrack.querySelectorAll<HTMLElement>('[data-time]').forEach(el => el.classList.toggle('on', Math.abs(start + playhead - Number(el.dataset.time)) <= KEY_EPS));
    return;
  }
  keyTrack.dataset.sig = sig;
  keyTrack.replaceChildren(...times.filter(t => t >= start - KEY_EPS && t <= start + s.duration + KEY_EPS).map(t => {
    const on = Math.abs(start + playhead - t) <= KEY_EPS;
    return h('button', { class: 'kf' + (on ? ' on' : ''), 'data-time': t, type: 'button', title: `Keyframe @ ${t.toFixed(2)}s (scene) · click to jump`, style: `left:calc(8px + (100% - 16px) * ${s.duration ? (t - start) / s.duration : 0})`, onclick: () => { playing = false; playhead = Math.max(0, Math.min(s.duration, t - start)); scene.setPlayhead(playhead); renderTransport(); renderInspector(); } });
  }));
}

// ---------- Editing: undo, transforms, duplicate, delete, add menu ----------
async function runEntry(entry: UndoEntry, record = true) {
  try { await edit(entry.redo, true); if (record) undoStack.push(entry); renderUndo(); return true; }
  catch (e) { toast((e as Error).message, true); scene.sync(project, shot()); renderInspector(); return false; }
}
async function undo() {
  const e = undoStack.takeUndo(); if (!e) return toast('Nothing to undo');
  try { await edit(e.undo, true); toast(`Undid ${e.label}`); } catch (err) { undoStack.restore(e, true); toast(`Can't undo ${e.label}: ${(err as Error).message}`, true); }
  renderUndo();
}
async function redo() {
  const e = undoStack.takeRedo(); if (!e) return toast('Nothing to redo');
  try { await edit(e.redo, true); toast(`Redid ${e.label}`); } catch (err) { undoStack.restore(e, false); toast(`Can't redo ${e.label}: ${(err as Error).message}`, true); }
  renderUndo();
}
function renderUndo() {
  undoBtn.disabled = !undoStack.canUndo; redoBtn.disabled = !undoStack.canRedo;
  undoBtn.title = undoStack.canUndo ? `Undo ${undoStack.peekUndo()!.label} (Ctrl/Cmd+Z)` : 'Nothing to undo';
  redoBtn.title = undoStack.canRedo ? `Redo ${undoStack.peekRedo()!.label} (Shift+Ctrl/Cmd+Z)` : 'Nothing to redo';
}
async function commitTransforms(changes: TransformChange[], label: string) {
  const t = scene.sceneTime();
  const patch = (id: string, x: TransformChange['after']) => {
    const e = entity(id);
    // Animated objects: moving sets a waypoint at the current scene time.
    if (e?.path?.length) {
      // Key only what changed (plus channels already keyed), so moving a car keeps it facing its travel.
      const before = changes.find(c => c.id === id)!.before;
      const keyR = e.path.some(k => Number.isFinite(k.r)) || Math.abs(before.rotation - x.rotation) > 0.01;
      const keyS = e.path.some(k => Array.isArray(k.s)) || before.scale.some((v, i) => Math.abs(v - x.scale[i]) > 1e-4);
      return { path: upsertKey(e.path, t, x.position.map(r3), keyR ? r3(x.rotation) : undefined, keyS ? x.scale.map(r3) : undefined) };
    }
    return { position: x.position.map(r3), rotation: r3(x.rotation), scale: x.scale.map(r3) };
  };
  const undoPatch = (id: string, x: TransformChange['before']) => { const e = entity(id); return e?.path?.length ? { path: structuredClone(e.path) } : { position: x.position.map(r3), rotation: r3(x.rotation), scale: x.scale.map(r3) }; };
  await runEntry({ label, redo: changes.map(c => ({ op: 'update_entity', id: c.id, patch: patch(c.id, c.after) })), undo: changes.map(c => ({ op: 'update_entity', id: c.id, patch: undoPatch(c.id, c.before) })) });
}
function setTransformMode(m: ModalMode) {
  scene.setTransformMode(m);
  modeButtons.forEach((b, i) => { const on = (['translate', 'rotate', 'scale'] as ModalMode[])[i] === m; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
}
let snapPref = localStorage.getItem('previs.snap') === '1';
let inspectorCollapsed = localStorage.getItem('previs.inspectorCollapsed') !== '0';
function setSnap(on: boolean) { snapPref = on; localStorage.setItem('previs.snap', on ? '1' : '0'); scene.setSnap(on); snapBtn.setAttribute('aria-pressed', String(on)); snapBtn.classList.toggle('on', on); renderHelp(); }
snapBtn.onclick = () => setSnap(!snapPref);
let gridVisible = localStorage.getItem('previs.grid.v2') === '1'; // hidden by default
/** Subjects to frame on open: characters/vehicles, minus stragglers far from the rest (a bird high overhead). */
function openingSubjects(entities: typeof project.scene.entities) {
  const subs = entities.filter(e => e.kind !== 'environment' && e.shape !== 'group' && e.shape !== 'terrain');
  if (subs.length < 3) return subs.map(e => e.id);
  const med = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return a[a.length >> 1]; };
  const c = [0, 1, 2].map(i => med(subs.map(e => e.position[i])));
  const d = subs.map(e => Math.hypot(e.position[0] - c[0], e.position[1] - c[1], e.position[2] - c[2]));
  const lim = Math.max(3 * med(d), 6);
  return subs.filter((_, i) => d[i] <= lim).map(e => e.id);
}
function frameSelected() { scene.frame(selection.ids); }
async function duplicateSelection() {
  const src = selection.ids.map(id => entity(id)).filter(Boolean) as Entity[];
  if (!src.length) return;
  const copies = src.map(e => ({ ...structuredClone(e), id: crypto.randomUUID(), look: null }));
  // Copies are made in place; use G to move them.
  const ok = await runEntry({ label: `Duplicate ${src.length > 1 ? `${src.length} objects` : src[0].name}`, redo: copies.map(entity => ({ op: 'add_entity', entity })), undo: copies.map(c => ({ op: 'remove_entity', id: c.id })) });
  if (ok) selection.set(copies.map(c => c.id), copies.at(-1)!.id);
}
const deleteDialog = h('dialog', { class: 'confirm', 'aria-labelledby': 'del-title' });
document.body.append(deleteDialog);
function requestDeleteShot(s: Shot) {
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => deleteDialog.close() }, 'Cancel');
  deleteDialog.replaceChildren(h('div', { class: 'dialog-body' }, h('h2', { id: 'del-title' }, `Delete “${s.title}”?`), h('p', {}, 'The shot is removed from the cut. Its saved images stay on disk.'), h('div', { class: 'bar' }, cancel, h('button', { class: 'btn primary', type: 'button', onclick: () => { deleteDialog.close(); void edit([{ op: 'remove_shot', id: s.id }]); } }, 'Delete'))));
  deleteDialog.showModal(); cancel.focus();
}
function requestDelete() {
  const list = withDescendants(project.scene.entities, selection.ids).map(id => entity(id)).filter(Boolean) as Entity[];
  if (!list.length) return;
  const confirmBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => { deleteDialog.close(); void deleteNow(list); } }, 'Delete');
  deleteDialog.replaceChildren(h('div', { class: 'dialog-body' },
    h('h2', { id: 'del-title', style: 'margin:0;font-size:15px' }, list.length > 1 ? `Delete ${list.length} objects?` : `Delete ${list[0].name}?`),
    h('p', { class: 'muted', style: 'margin:0' }, list.length > 1 ? list.map(e => e.name).join(', ') : 'It is removed from every shot. Undo (Ctrl/Cmd+Z) brings it back.'),
    h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' }, h('button', { class: 'btn', type: 'button', onclick: () => deleteDialog.close() }, 'Cancel'), confirmBtn),
    h('p', { class: 'note', style: 'margin:0' }, 'Enter confirms · Esc cancels')));
  deleteDialog.showModal(); confirmBtn.focus();
}
async function deleteNow(list: Entity[]) {
  const ok = await runEntry({ label: list.length > 1 ? `Delete ${list.length} objects` : `Delete ${list[0].name}`, redo: [...list].reverse().map(e => ({ op: 'remove_entity', id: e.id })), undo: list.flatMap(e => recreateOps(e, project)) });
  if (ok) selection.clear();
}
function openAddPopup(x: number, y: number) {
  const r = viewport.getBoundingClientRect();
  addPopup.replaceChildren(h('div', { class: 'eyebrow', style: 'padding:4px 8px' }, 'Add'), ...Object.keys(SHAPES).filter(x => x !== 'group').map(shape => h('button', { type: 'button', role: 'menuitem', onclick: () => void addObject(shape) }, shapeIcon(shape), shape)));
  addPopup.hidden = false;
  addPopup.style.left = `${Math.min(x - r.left, r.width - 190)}px`; addPopup.style.top = `${Math.min(y - r.top, r.height - 330)}px`;
  (addPopup.querySelector('button') as HTMLButtonElement | null)?.focus();
}
document.addEventListener('pointerdown', ev => { if (!addPopup.hidden && !addPopup.contains(ev.target as Node)) addPopup.hidden = true; if (!helpCard.hidden && !helpCard.contains(ev.target as Node) && !(ev.target as HTMLElement).closest('.help-toggle')) helpCard.hidden = true; });
const HELP: [string, [string, string][]][] = [
  ['Navigate', [['Orbit', 'Left-drag'], ['Pan', 'Right-drag'], ['Zoom', 'Scroll or pinch'], ['Front / side / top', 'Numpad 1 / 3 / 7'], ['Opposite view', 'Ctrl + Numpad view'], ['Perspective / ortho', 'Numpad 5'], ['Look through shot camera', 'Numpad 0 or C'], ['Frame selected', 'F, . or Numpad .']]],
  ['Select', [['Select', 'Click an object'], ['Add to selection', 'Shift + click'], ['Toggle in/out', 'Ctrl/Cmd + click'], ['Box add', 'Shift + drag'], ['Deselect all', 'Click empty space']]],
  ['Transform', [['Move / Rotate / Resize', 'G / R / S'], ['Constrain axis', 'X / Y / Z'], ['Exact amount', 'Type a number (− for negative)'], ['Edit amount', 'Backspace'], ['Confirm / Cancel', 'Click or Enter / Esc or right-click'], ['Snap movement', 'Hold Ctrl (inverts Snap)'], ['Scrub a field', 'Drag up/down · Shift fine · Ctrl snap']]],
  ['Animate', [['Insert keyframe', 'I'], ['Delete keyframe at playhead', 'Alt + I'], ['Previous / next keyframe', '‹◆ / ◆› on the timeline'], ['Move an animated object', 'Keys it at the playhead']]],
  ['Edit', [['Add object', 'Right-click or Shift + A'], ['Duplicate in place', 'Shift + D or Ctrl/Cmd + D'], ['Delete', 'X, Delete or Backspace (asks first)'], ['Group / Ungroup', 'Ctrl/Cmd + G / Shift + Ctrl/Cmd + G'], ['Undo / Redo', 'Ctrl/Cmd + Z / Shift + Ctrl/Cmd + Z'], ['Play shot', 'Space']]],
];
let helpExplainers: { dispose(): void }[] = [];
function renderHelp() {
  helpExplainers.forEach(x => x.dispose()); helpExplainers = [];
  const grid = h('input', { type: 'checkbox', checked: gridVisible }); grid.onchange = () => { gridVisible = grid.checked; localStorage.setItem('previs.grid.v2', gridVisible ? '1' : '0'); scene.setGridVisible(gridVisible); };
  const snapBox = h('input', { type: 'checkbox', checked: snapPref }); snapBox.onchange = () => setSnap(snapBox.checked);
  const labelMode = h('select', { 'aria-label': 'Object labels' }, ...['auto', 'all', 'none'].map(value => h('option', { value, selected: value === (localStorage.getItem('previs.labels') || 'auto') }, value === 'auto' ? 'Automatic' : value === 'all' ? 'All' : 'None')));
  labelMode.onchange = () => { localStorage.setItem('previs.labels', labelMode.value); scene.setLabelMode(labelMode.value as 'auto' | 'all' | 'none'); };
  helpCard.replaceChildren(
    h('div', { class: 'help-head' }, h('strong', {}, 'Controls'), h('span', { class: 'muted' }, 'Viewport and shortcuts'), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close', onclick: () => { helpCard.hidden = true; } }, '✕')),
    h('div', { class: 'help-cols' }, ...HELP.map(([title, rows]) => h('section', { 'data-explain': title === 'Edit' ? 'groups' : title.toLowerCase() }, h('strong', {}, title), h('div', { class: 'help-explain' }), ...rows.map(([a, b]) => h('div', { class: 'help-row' }, h('span', {}, a), h('kbd', {}, b)))))),
    h('section', { class: 'help-settings' }, h('strong', {}, 'Viewport'), h('label', {}, 'Object labels', labelMode), h('label', {}, h('span', {}, 'Show grid'), grid), h('label', {}, h('span', {}, 'Snap movement to grid'), snapBox), h('div', { class: 'help-row' }, h('span', {}, 'Grid step'), h('kbd', {}, `${scene.gridStep()} m`))));
  helpCard.querySelectorAll<HTMLElement>('section[data-explain]').forEach(section => helpExplainers.push(mountExplainer(section.querySelector<HTMLElement>('.help-explain')!, section.dataset.explain!)));
}
// [director-phone] pair a phone and preview its aim in the shot camera (live only, not recorded). Lives in the Fly menu; its live chip sits in the transport.
installPhoneDemo(flyPhoneSlot, scene, () => setView('camera'));
{ const chip = flyPhoneSlot.querySelector('.phone-chip'); if (chip) flyGroup.before(chip); const [pair, look] = Array.from(flyPhoneSlot.querySelectorAll<HTMLButtonElement>('.phone-group .btn')); if (pair) pair.textContent = 'Pair phone…'; if (look) look.textContent = 'Live look with phone'; }
// ---------- Fly camera (hero): Operate with keyboard, gamepad or phone ----------
const FLY_DEVICES: [FlyDevice, string][] = [['keyboard', 'Keyboard'], ['gamepad', 'Gamepad'], ['phone', 'Phone']];
let flyPick = (localStorage.getItem('previs.fly.device') as FlyDevice | null) || null;
const flyDeviceNow = (): FlyDevice => flyPick || (fly.state().pad ? 'gamepad' : 'keyboard');
const deviceLive = (d: FlyDevice) => d === 'keyboard' ? true : d === 'gamepad' ? fly.state().pad : phoneConnected();
function renderFly() {
  const st = fly.state(), d = flyDeviceNow(), live = st.phase === 'live';
  const label = !live ? 'Fly camera' : st.rec === 'recording' ? 'Stop' : st.rec === 'armed' ? 'Record' : 'Fly camera';
  const sig = `${live}|${st.rec}|${d}|${deviceLive(d)}`;
  if (flyBtn.dataset.sig === sig) return;
  flyBtn.dataset.sig = sig;
  flyBtn.replaceChildren(...[h('i', { class: 'fly-dot', 'aria-hidden': 'true' }), h('span', {}, label), live ? h('kbd', {}, d === 'gamepad' ? 'A' : 'R') : null].filter(Boolean) as Node[]);
  flyBtn.className = 'fly-btn' + (live ? ' live' : '') + (st.rec === 'recording' ? ' rec' : '');
  flyBtn.title = !live ? `Fly the shot camera live with the ${d} and record a take` : st.rec === 'recording' ? 'Stop recording (R)' : 'Start recording (R) · Esc releases';
  flyDevice.replaceChildren(...[h('span', {}, FLY_DEVICES.find(x => x[0] === d)![1]), d !== 'keyboard' ? h('i', { class: 'dev-dot' + (deviceLive(d) ? ' on' : '') }) : null, h('span', { class: 'chev', 'aria-hidden': 'true' }, '▾')].filter(Boolean) as Node[]);
}
function renderFlyMenu() {
  const d = flyDeviceNow();
  flyMenu.replaceChildren(
    h('div', { class: 'menu-title' }, 'Fly the camera with'),
    ...FLY_DEVICES.map(([k, label]) => h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(k === d), class: k === d ? 'on' : '', onclick: () => { flyPick = k; localStorage.setItem('previs.fly.device', k); flyMenu.hidden = true; fly.setDevice(k); renderFly(); if (k === 'phone' && !phoneConnected()) openPhonePairing(); } },
      h('strong', {}, label, k !== 'keyboard' ? h('i', { class: 'dev-dot' + (deviceLive(k) ? ' on' : '') }) : null),
      h('span', {}, k === 'keyboard' ? 'W A S D to fly · Q E turn · R records' : k === 'gamepad' ? (fly.state().pad ? 'Connected · A arms and records' : 'Connect a controller and press any button') : (phoneConnected() ? 'Paired · aim along the shot’s path' : 'Pair by scanning a QR code')))),
    h('div', { class: 'menu-sep' }),
    flyPhoneSlot,
    h('details', {}, h('summary', {}, 'Device controls'), d === 'keyboard' ? keyboardDiagram() : d === 'gamepad' ? gamepadDiagram() : phoneDiagram()),
    h('button', { type: 'button', class: 'menu-link', onclick: () => { flyMenu.hidden = true; goSection('camera'); requestAnimationFrame(() => document.querySelector('.op-panel')?.scrollIntoView({ block: 'center' })); } }, 'Fly settings, passes and takes →'));
}
flyBtn.onclick = () => {
  (flyBtn as HTMLButtonElement).blur();
  const st = fly.state(), d = flyDeviceNow();
  if (st.phase === 'live') { fly.cycle(); renderFly(); return; }
  if (d === 'phone' && !phoneConnected()) { openPhonePairing(); toast('Pair your phone, then press Fly camera'); return; }
  if (step === 'build') setStep('shoot');
  fly.start(d); renderFly();
  toast(fly.state().help);
};
flyDevice.onclick = () => { renderFlyMenu(); menuState(flyMenu, flyMenu.hidden, flyDevice, true); };
document.addEventListener('pointerdown', ev => { if (!flyMenu.hidden && !(ev.target as HTMLElement).closest?.('.fly, .fly-menu')) flyMenu.hidden = true; });
menuKeys(helpMenu, helpMenuBtn); menuKeys(flyMenu, flyDevice);
menuKeys(addMenu, rail.querySelector<HTMLElement>('.add-obj')!); menuKeys(addPopup, canvas);
canvas.tabIndex = 0;
fly.onChange(renderFly);
window.addEventListener('gamepadconnected', () => renderFly());
renderFly();
// Shot monitor (picture in picture) can fold away.
let monOpen = localStorage.getItem('previs.monitor') !== '0';
function setMonitor(open: boolean) {
  monOpen = open; localStorage.setItem('previs.monitor', open ? '1' : '0');
  monitor.hidden = !open; viewport.classList.toggle('mon-closed', !open);
  monToggle.setAttribute('aria-pressed', String(open));
  monToggle.replaceChildren(open ? h('span', { 'aria-hidden': 'true' }, '–') : h('span', {}, h('i', { class: 'rec-dot' }), 'Shot monitor'));
  monToggle.title = open ? 'Hide the shot monitor' : 'Show the shot monitor';
  scene.markDirty();
}
monToggle.onclick = ev => { ev.stopPropagation(); setMonitor(!monOpen); };
setMonitor(monOpen);
setTransformMode('translate'); setSnap(snapPref); scene.setGridVisible(gridVisible); scene.setLabelMode((localStorage.getItem('previs.labels') || 'auto') as 'auto' | 'all' | 'none'); renderUndo();

// Keyboard: scene shortcuts never fire while a field, menu or dialog is using the key.
window.addEventListener('keydown', ev => { if (ev.key === 'Control') scene.setCtrl(true); });
window.addEventListener('keyup', ev => { if (ev.key === 'Control') scene.setCtrl(false); });
window.addEventListener('blur', () => scene.setCtrl(false));
document.addEventListener('keydown', ev => {
  const mod = ev.ctrlKey || ev.metaKey, k = ev.key.toLowerCase(), target = ev.target as HTMLElement;
  if (mod && k === 's') { ev.preventDefault(); toast('Saved — every change is saved automatically'); return; }
  const typing = Boolean(target.closest?.('input, textarea, select, [contenteditable="true"]'));
  if (mod && (k === 'z' || k === 'y') && !typing) { ev.preventDefault(); if (k === 'y' || ev.shiftKey) void redo(); else void undo(); return; }
  if (wsMode === 'sequence') return; // scene shortcuts are off while the Sequence view is showing
  if (scene.modalActive()) {
    if (['g', 'r', 's'].includes(k) && !mod) { ev.preventDefault(); scene.beginModal(k === 'g' ? 'translate' : k === 'r' ? 'rotate' : 'scale'); return; }
    if (scene.modalKey(ev.key)) { ev.preventDefault(); ev.stopPropagation(); }
    return;
  }
  if (targetConsumesKey(ev.target, ev.key)) return;
  if (ev.key === 'Escape') { if (!flyMenu.hidden) flyMenu.hidden = true; else if (!helpMenu.hidden) helpMenu.hidden = true; else if (!addPopup.hidden) addPopup.hidden = true; else if (!helpCard.hidden) helpCard.hidden = true; else if (scene.view() === 'camera') setView('set'); return; }
  if (ev.key === '?') { renderHelp(); helpCard.hidden = !helpCard.hidden; return; }
  if (mod && k === 'd') { ev.preventDefault(); void duplicateSelection(); return; }
  if (ev.altKey && !mod && ev.code === 'KeyI') { ev.preventDefault(); deleteKeysHere(); return; }
  if (mod || ev.altKey) {
    if (ev.code === 'Numpad1' || ev.code === 'Numpad3' || ev.code === 'Numpad7') { ev.preventDefault(); scene.snapView(ev.code === 'Numpad1' ? 'z' : ev.code === 'Numpad3' ? 'x' : 'y', true); }
    return;
  }
  if (ev.code === 'Numpad1') return scene.snapView('z', false);
  if (ev.code === 'Numpad3') return scene.snapView('x', false);
  if (ev.code === 'Numpad7') return scene.snapView('y', false);
  if (ev.code === 'Numpad5') { toast(`${scene.toggleProjection() === 'orthographic' ? 'Orthographic' : 'Perspective'} view`); return; }
  if (ev.code === 'Numpad0') { setView(scene.view() === 'set' ? 'camera' : 'set'); return; }
  if (ev.code === 'NumpadDecimal' || k === 'f' || ev.key === '.') { frameSelected(); return; }
  if (ev.shiftKey && k === 'a') { ev.preventDefault(); const p = scene.pointerInViewport() ? scene.lastPointer() : (() => { const r = viewport.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })(); openAddPopup(p.x, p.y); return; }
  if (ev.shiftKey && k === 'd') { ev.preventDefault(); void duplicateSelection(); return; }
  if (ev.key === ' ') { ev.preventDefault(); togglePlay(); return; }
  if (k === 'c') { setView(scene.view() === 'set' ? 'camera' : 'set'); return; }
  if (k === 'i') { ev.preventDefault(); insertKeys(); return; }
  if ((ev.ctrlKey || ev.metaKey) && k === 'g') { ev.preventDefault(); if (ev.shiftKey) void ungroupSelection(); else void groupSelection(); return; }
  if (['g', 'r', 's'].includes(k)) { if (selection.size && scene.view() === 'set') { ev.preventDefault(); scene.beginModal(k === 'g' ? 'translate' : k === 'r' ? 'rotate' : 'scale'); } return; }
  if (k === 'x' || ev.key === 'Delete' || ev.key === 'Backspace') { if (selection.size) { ev.preventDefault(); requestDelete(); } return; }
});

// ---------- Render hand-off ----------
// Render a shot's camera video at a fixed 24 fps and record it on the shot (the source every workflow receives).
async function captureShotVideo(s: Shot, o: CaptureOptions) {
  return captureVideo({ api, scene, project: () => project, entity, signature, select: x => { if (shotId !== x.id) selectShot(x.id); }, apply }, s, o);
}
renderBtn.onclick = () => openRender();
function openRender() {
  document.getElementById('render-dialog')?.remove();
  playing = false;
  const s = shot(), idx = project.shots.indexOf(s);
  let width = 1280, height = 720;
  const frames = () => Math.min(120, Math.max(2, Math.round(s.duration * 24)));
  const preview = h('img', { alt: 'Shot camera preview', src: scene.capture(s.duration / 2, 1280, 720, 'image/jpeg', 0.85) });
  const media = h('div', { class: 'render-media' }, preview);
  const facts = h('div', { class: 'facts' });
  const showFacts = () => facts.replaceChildren('Frames', h('b', {}, `${frames()} @ 24 fps`), 'Duration', h('b', {}, `${(frames() / 24).toFixed(3)}s (shot ${s.duration}s)`), 'Size', h('b', {}, `${width}×${height} · 16:9`));
  showFacts();
  const res = h('div', { class: 'radio-row' },
    ...[[1280, 720], [640, 360]].map(([w, hh]) => { const input = h('input', { type: 'radio', name: 'res', checked: w === 1280 }); input.onchange = () => { width = w; height = hh; showFacts(); }; return h('label', {}, input, `${w}×${hh}`); }));
  const bar = h('i'); const progress = h('div', { class: 'progress', hidden: true }, bar);
  const status = h('div', { class: 'status-line' });
  const capture = h('button', { class: 'btn camera', type: 'button' }, `Make blockout`);
  const prompt = h('textarea', { class: 'field', rows: 5, 'aria-label': 'Render prompt' }, shotPrompt(project, s, 'video'));
  const step1 = h('div', { class: 'step active' }, h('span', { class: 'n' }, '1'), h('div', {}, h('h3', {}, 'Blockout'), h('p', {}, 'The grey camera clip: every frame through the shot camera at 24 fps, the exact motion the video model follows.'), res, h('div', { style: 'height:8px' }), facts, h('div', { style: 'height:10px' }), capture, h('div', { style: 'height:8px' }), progress, status));
  const refsByFile = new Map<string, { ref: Reference; names: Set<string> }>();
  const addRef = (ref: Reference, name?: string) => { const entry = refsByFile.get(ref.file) || { ref, names: new Set<string>() }; if (name) entry.names.add(name); refsByFile.set(ref.file, entry); };
  for (const e of project.scene.entities) { const ref = objectLooks(project, e.id)[0]; if (ref) addRef(ref, e.name); }
  for (const ref of s.references) addRef(ref, entity(ref.entityId)?.name);
  const refs = [...refsByFile.values()];
  const step2 = h('div', { class: 'step' }, h('span', { class: 'n' }, '2'), h('div', {}, h('h3', {}, 'Prompt & images'), h('p', {}, 'Composed from the story, cast and camera. Edit freely.'), prompt,
    refs.length ? h('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-top:8px' }, ...refs.map(({ ref: r, names }) => h('div', { style: 'display:flex;gap:8px;align-items:center;font-size:12px' }, h('img', { src: refUrl(r), alt: '', style: 'width:34px;height:34px;flex:none;object-fit:cover;border-radius:6px' }), h('div', { style: 'flex:1;min-width:0;overflow-wrap:anywhere' }, h('div', {}, r.name), h('small', { class: 'muted' }, names.size > 1 ? `Shared by ${[...names].join(', ')}` : [...names][0] || (r.role === 'style' ? 'Style' : 'Shot image')))))) : h('p', { class: 'note', style: 'margin-top:8px' }, 'No images for this shot.'),
    h('p', { class: 'note', style: 'margin-top:8px' }, 'Cast images are named in the prompt and sent to models that take images.')));
  const gen = h('div', { class: 'gen-box' }, h('p', { class: 'note', style: 'margin:0' }, 'Make the blockout first.'));
  const step3 = h('div', { class: 'step' }, h('span', { class: 'n' }, '3'), h('div', {}, h('h3', {}, 'Generate the video'), h('p', { style: 'margin:0 0 8px' }, 'Run a Comfy video model on this exact blockout. You see the quote first; nothing runs until you approve it.'), gen));
  const setOpen = (previsShotId: string, assetId: string) => { renderGenerate(gen, s, previsShotId, assetId, () => prompt.value); };
  prompt.oninput = () => { if (s.render && s.render.signature === signature(project, s)) setOpen(s.render.previsShotId, s.render.assetId); };
  const sig = signature(project, s);
  if (s.render && s.render.signature === sig) {
    media.replaceChildren(h('video', { src: `/assets/${s.render.assetId}.mp4`, controls: true, autoplay: true, muted: true, loop: true, playsinline: true }));
    step1.className = 'step done'; status.textContent = `Up to date: ${s.render.frameCount} frames · ${Number(s.render.duration).toFixed(2)}s · ${s.render.width}×${s.render.height}. Make again to replace.`;
    step2.className = 'step active'; setOpen(s.render.previsShotId, s.render.assetId);
  }
  capture.onclick = async () => {
    capture.disabled = true; status.className = 'status-line'; progress.hidden = false; bar.style.width = '0%';
    const started = performance.now();
    try {
      const img = h('img', { alt: 'Captured frame' }); media.replaceChildren(img);
      const { asset, previsShotId, project: saved } = await captureShotVideo(s, { width, height, prompt: prompt.value, onFrame: (url, i, n) => { if (i % 4 === 0) img.src = url; bar.style.width = `${((i + 1) / n) * 100}%`; status.textContent = `Blockout frame ${i + 1} / ${n}`; }, onStatus: t => { status.textContent = t; } });
      const previsShot = { id: previsShotId }; const r = { project: saved };
      apply(r.project);
      media.replaceChildren(h('video', { src: asset.url, controls: true, autoplay: true, muted: true, loop: true, playsinline: true }));
      status.textContent = `Saved: ${asset.frameCount} frames · ${Number(asset.duration).toFixed(2)}s · ${asset.width}×${asset.height} in ${((performance.now() - started) / 1000).toFixed(1)}s.`;
      step1.className = 'step done'; step2.className = 'step done'; step3.className = 'step active';
      setOpen(previsShot.id, asset.id);
    } catch (e) {
      status.className = 'status-line err'; status.textContent = (e as Error).message;
    } finally {
      capture.disabled = false; progress.hidden = true; capture.textContent = 'Make again';
    }
  };
  const dlg = h('dialog', { class: 'render', id: 'render-dialog', 'aria-labelledby': 'render-title' },
    h('div', { class: 'dialog-head' }, h('h2', { id: 'render-title' }, `Generate video · Shot ${String(idx + 1).padStart(2, '0')} · ${s.title}`), h('span', { class: 'muted', style: 'font-size:12px' }, describeCamera(s, project.scene.entities)), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'render-body' }, media, h('div', { class: 'render-steps' }, step1, step2, step3)),
    h('div', { class: 'render-foot' }, h('p', { class: 'note' }, 'Nothing is uploaded or charged without a quote you approve.')));
  document.body.append(dlg); dlg.showModal();
}

// ---------- In-app video generation (uses the workflow engine: preset → bind → quote → approve → submit → track) ----------
type GenState = { presets: any[]; definitions: any[]; jobs: any[]; paidExecutionEnabled: boolean };
async function renderGenerate(box: HTMLElement, s: Shot, previsShotId: string, assetId: string, getPrompt: () => string) {
  let st: GenState;
  try { st = await api('generation'); } catch (e) { box.replaceChildren(h('p', { class: 'status-line err' }, (e as Error).message)); return; }
  const choices = videoChoices(st as any);
  const wf = h('select', { class: 'field', 'aria-label': 'Video model' }, ...choices.map(d => h('option', { value: d.id }, d.title)));
  const previous = st.jobs.filter(j => j.shotId === previsShotId && (j.sources?.sourceVideo?.id === assetId || j.sources?.controlVideo?.id === assetId)).at(-1);
  if (previous && choices.some(d => d.id === previous.definition?.id)) wf.value = previous.definition.id;
  const backendSel = h('select', { class: 'field', 'aria-label': 'Runs on' }, h('option', { value: 'cloud' }, 'Comfy Cloud'), h('option', { value: 'local' }, 'Local ComfyUI'));
  const note = h('p', { class: 'note', style: 'margin:0' });
  const showNote = () => { const d = choices.find(c => c.id === wf.value); note.textContent = d?.description || ''; backendSel.value = d?.id?.startsWith('wan-') ? 'local' : 'cloud'; };
  const useRefs = h('input', { type: 'checkbox', checked: localStorage.getItem('previs.seq.refs') !== '0' });
  const refsBox = h('div', { class: 'gen-refs' });
  const showRefs = () => {
    const cap = referenceCapacity(st as any, wf.value), list = useRefs.checked ? plannedReferences(project, s, st as any, wf.value) : [];
    refsBox.replaceChildren(!cap ? h('span', { class: 'note' }, 'This model takes no images.') : list.length
      ? h('div', { class: 'gen-refs-row' }, ...list.map((r, i) => h('span', { class: 'gen-ref', title: `${r.label} — ${r.ref.name}` }, h('img', { src: refUrl(r.ref), alt: '' }), h('small', {}, `${i + 1} · ${r.label}`))))
      : h('span', { class: 'note' }, useRefs.checked ? 'No images yet for the cast of this shot. Give them one in Cast.' : 'Cast images off.'));
  };
  useRefs.onchange = () => { localStorage.setItem('previs.seq.refs', useRefs.checked ? '1' : '0'); showRefs(); out.replaceChildren(); };
  wf.onchange = () => { showNote(); showRefs(); out.replaceChildren(); timing.checked = false; }; showNote(); showRefs();
  backendSel.onchange = () => out.replaceChildren();
  const timing = h('input', { type: 'checkbox' });
  timing.onchange = () => out.replaceChildren();
  const quoteBtn = h('button', { class: 'btn camera', type: 'button' }, 'Review request & quote');
  const out = h('div', { class: 'gen-out' });
  const jobsBox = h('div', { class: 'gen-jobs' });
  quoteBtn.onclick = async () => {
    const revision = project.revision, prompt = getPrompt();
    for (const input of [quoteBtn, wf, backendSel, useRefs, timing]) input.disabled = true;
    out.replaceChildren(h('p', { class: 'status-line' }, 'Preparing the request; nothing is being submitted…'));
    try {
      const { def, job, request } = await prepareShotVideo({ project, shot: s, st: st as any, definitionId: wf.value, useReferences: useRefs.checked, userPrompt: prompt, backend: backendSel.value === 'local' ? 'local' : 'cloud', acceptTimingChange: timing.checked });
      if (project.revision !== revision || getPrompt() !== prompt) throw Error('Shot or prompt changed while preparing. Review a fresh quote. Nothing submitted.');
      if (!job.validation?.compatible) throw Error((job.validation?.issues || []).map((i: any) => i.message).slice(0, 3).join('; ') || 'This workflow can’t run with these inputs');
      const card = genQuote(job, def, request, s); out.replaceChildren(card);
      out.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (e) {
      let msg = (e as Error).message;
      const d = choices.find(c => c.id === wf.value), lim = d?.constraints?.sourceVideo?.duration || d?.constraints?.controlVideo?.duration;
      if (/constraints: .*duration/.test(msg) && lim) msg = `${d.title.split(' ·')[0]} needs a ${lim.min}–${Math.floor(lim.max)} s source and this shot is ${s.duration} s. Set the shot's duration to at least ${lim.min} s, render again, then quote.`;
      out.replaceChildren(h('p', { class: 'status-line err' }, msg));
    }
    finally { for (const input of [quoteBtn, wf, backendSel, useRefs, timing]) input.disabled = false; }
  };
  const drawJobs = () => {
    const mine = st.jobs.filter(j => j.shotId === previsShotId || (project.assets || []).some(a => a.kind === 'camera-render' && a.shotId === s.id && a.source.engineShotId === j.shotId)).slice(-4).reverse();
    jobsBox.replaceChildren(...mine.map(j => h('div', { class: 'gen-job' }, h('b', { class: `st-${j.status}` }, j.status), h('span', {}, `${j.definition?.title?.split(' ·')[0] || 'Model'} · ${j.backend?.kind}`), h('small', { class: 'muted' }, j.message || ''))));
  };
  drawJobs();
  box.replaceChildren(h('div', { class: 'grid2' }, h('label', {}, 'Video model', wf), h('label', {}, 'Runs on', backendSel)), note,
    h('label', { style: 'display:flex;gap:8px;align-items:center;font-size:12px;color:var(--muted)' }, useRefs, 'Send the cast’s images with the request'), refsBox,
    h('label', { style: 'display:flex;gap:8px;align-items:center;font-size:12px;color:var(--muted)' }, timing, 'I have reviewed that output timing/resolution may differ from the source; originals will not be fitted or replaced.'),
    h('div', {}, quoteBtn), out, jobsBox);
}
function genQuote(job: any, def: any, request: any, s: Shot) {
  const est = def.pricing?.ratePerSecond && job.sources?.sourceVideo?.duration ? def.pricing.ratePerSecond * job.sources.sourceVideo.duration : null;
  const free = job.quote?.status === 'known' && job.quote.amount === 0;
  const issues = job.validation?.issues || [];
  const approve = h('input', { type: 'checkbox' }), unknown = h('input', { type: 'checkbox' });
  const max = h('input', { class: 'field', type: 'number', min: 0, step: 0.01, value: est ? Math.ceil(est * 1.5 * 100) / 100 : 1, style: 'width:90px', 'aria-label': 'Maximum USD' });
  const go = h('button', { class: 'btn camera gen-send', type: 'button', disabled: true }, 'Approve & submit once');
  let dispatched = false;
  const status = h('div', { class: 'status-line' });
  const live = h('div', { class: 'gen-live' }); // [live-progress] separate child; approval controls stay untouched
  const sync = () => { go.disabled = dispatched || !job.validation?.compatible || !approve.checked || (!free && !unknown.checked) || !Number.isFinite(Number(max.value)) || Number(max.value) < 0; };
  approve.onchange = unknown.onchange = sync;
  max.oninput = sync;
  go.onclick = async () => {
    sync(); if (go.disabled) return;
    dispatched = true;
    go.disabled = true; status.className = 'status-line'; status.textContent = 'Submitting once…';
    try {
      const r = await api('generation/submit', { ...request, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: Number(max.value) || 0, allowUnknownCharges: !free } } });
      status.textContent = r.job.message || r.job.status;
      const poll = async () => {
        const t = await api('generation/track', { jobId: r.job.id }).catch(e => ({ job: { status: 'error', message: (e as Error).message } }));
        status.textContent = `${t.job.status}: ${t.job.message || ''}`;
        if (['completed', 'failed', 'uncertain', 'closed', 'error'].includes(t.job.status)) { if (t.job.status === 'completed') toast(`Shot ${String(project.shots.indexOf(s) + 1).padStart(2, '0')} video is ready — see Videos`); return; }
        setTimeout(poll, 5000);
      };
      setTimeout(poll, 4000);
      // Display only, after the authoritative status poll is scheduled; it can never affect dispatch or tracking.
      try { live.replaceChildren(progressSlot(projectId, 'generation', r.job.id, `Shot ${String(project.shots.indexOf(s) + 1).padStart(2, '0')} video`, 'quote')); } catch { /* polling continues */ }
    } catch (e) { status.className = 'status-line err'; status.textContent = `${(e as Error).message} · No retry. Inspect request ${job.id} before preparing anything else.`; }
  };
  return h('div', { class: 'prompt-box', style: 'display:flex;flex-direction:column;gap:8px;white-space:normal' },
    h('div', { class: 'facts' }, 'Model', h('b', {}, def.title), 'Runs on', h('b', {}, request.backend.kind === 'cloud' ? 'Comfy Cloud' : 'Local ComfyUI'),
      'Ready', h('b', { style: `color:${job.validation?.compatible ? 'var(--ok)' : 'var(--bad)'}` }, job.validation?.compatible ? 'Inputs ready' : 'Missing requirements'),
      'Estimated cost', h('b', { style: `color:${free ? 'var(--ok)' : 'var(--warn)'}` }, free ? 'No charge (local)' : est ? `≈ $${est.toFixed(3)} estimate; Cloud total unknown` : 'Unknown — needs approval'),
      'Quote', h('b', {}, String(job.fingerprint || '').slice(0, 12))),
    h('p', { class: 'note' }, `Exact source: ${job.sources?.sourceVideo?.id || job.sources?.controlVideo?.id || job.sources?.firstFrame?.id || 'see request'} · ${job.sources?.sourceVideo?.frameCount ?? 'image'} frames · ${job.sources?.sourceVideo?.duration ?? '—'} s. Preparation does not upload inputs.`),
    def.pricing?.partnerEstimate ? h('p', { class: 'note' }, `Published partner estimate: $${def.pricing.partnerEstimate.min.toFixed(4)}–$${def.pricing.partnerEstimate.max.toFixed(4)} USD. ${def.pricing.partnerEstimate.note}`) : null,
    h('details', {}, h('summary', {}, 'Details'), h('pre', { style: 'max-height:240px;overflow:auto;white-space:pre-wrap' }, JSON.stringify({ prompt: job.binding?.prompt, sources: job.sources, graph: job.preparedGraph }, null, 2))),
    issues.length ? h('ul', { class: 'note', style: 'margin:0;padding-left:16px' }, ...issues.slice(0, 5).map((i: any) => h('li', {}, i.message))) : null,
    h('label', {}, approve, ' I approve this exact request, with an allowance of ', max, ' USD.'),
    !free ? h('label', {}, unknown, ' Cloud bills actual usage, which may be unknown. This is my spending allowance for this run, not a provider-enforced spending cap.') : null,
    h('div', {}, go), status, live);
}

// ---------- Live sync ----------
async function pollNow() {
  try {
    const r = await api(`director/project?id=${projectId}&since=${project.revision}`);
    if (r.project) { const before = project; apply(r.project); announceChanges(before, r.project); }
  } catch {}
}
/** Changes that arrive from outside (Claude over MCP): flash the objects in their kind colour and say what changed. */
function announceChanges(before: DirectorProject, after: DirectorProject) {
  const old = new Map(before.scene.entities.map(e => [e.id, JSON.stringify(e)]));
  const objs = after.scene.entities.filter(e => old.get(e.id) !== JSON.stringify(e));
  const removed = before.scene.entities.filter(e => !after.scene.entities.some(x => x.id === e.id)).length;
  const oldShots = new Map(before.shots.map(x => [x.id, JSON.stringify(x)]));
  const shots = after.shots.filter(x => oldShots.get(x.id) !== JSON.stringify(x)).length + before.shots.filter(x => !after.shots.some(y => y.id === x.id)).length;
  if (!objs.length && !removed && !shots) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const e of objs) for (const el of [labels.querySelector<HTMLElement>(`[data-id="${e.id}"]`), outline.querySelector<HTMLElement>(`[data-id="${e.id}"]`)]) {
    if (!el) continue;
    el.style.setProperty('--flash', KIND_COLORS[e.kind] || 'var(--accent)');
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), reduce ? 900 : 1600);
  }
  const parts = [objs.length || removed ? `${objs.length + removed} object${objs.length + removed === 1 ? '' : 's'}` : '', shots ? `${shots} shot${shots === 1 ? '' : 's'}` : ''].filter(Boolean);
  toast(`✳ Claude updated ${parts.join(' and ')}`);
}
/** Empty project: three steps from nothing to a video. */
function renderFirstRun() {
  const key = `previs.firstrun.${project.id}`;
  const objs = project.scene.entities.filter(e => e.shape !== 'group');
  if (objs.length || localStorage.getItem(key) === '1') { firstRun.hidden = true; return; }
  const hasImages = objs.some(e => objectLooks(project, e.id).length), hasVideo = (project.assets || []).some(a => a.kind === 'workflow-result');
  const stepEl = (n: number, done: boolean, title: string, body: string, action: Node | null) => h('li', { class: done ? 'done' : '' }, h('span', { class: 'fr-n' }, done ? '✓' : String(n)), h('div', {}, h('strong', {}, title), h('p', {}, body), action));
  firstRun.hidden = false;
  firstRun.replaceChildren(h('div', { class: 'fr-card' },
    h('div', { class: 'fr-head' }, h('span', { class: 'eyebrow' }, 'Start here'), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Dismiss', onclick: () => { localStorage.setItem(key, '1'); firstRun.hidden = true; } }, '✕')),
    h('h2', {}, 'From an empty stage to a shot in three steps'),
    h('ol', {},
      stepEl(1, !!objs.length, 'Describe your scene to Claude, or add objects', 'Claude builds it here live. Or place characters, vehicles and props yourself.', h('div', { class: 'fr-actions' }, h('button', { class: 'btn sm primary', type: 'button', onclick: () => claudeDialog() }, '✳ Direct with Claude'), h('button', { class: 'btn sm', type: 'button', onclick: () => { const r = viewport.getBoundingClientRect(); openAddPopup(r.left + r.width / 2 - 90, r.top + 80); } }, '+ Add object'))),
      stepEl(2, hasImages, 'Give your cast an image', 'Open a cast member in the Cast panel and generate or drop an image.', null),
      stepEl(3, hasVideo, 'Frame a shot and generate video', 'Switch to Shoot, frame or fly the camera, then press Generate video in the bar at the bottom of the right panel.', null))));
}
async function poll() { await pollNow(); setTimeout(poll, 1200); }

async function boot() {
  if (!projectId) { location.href = '/'; return; }
  try {
    const [p, a] = await Promise.all([api(`director/project?id=${projectId}`), api('director/agent')]);
    connect = a.connect;
    void loadRefgen().then(pollJobs);
    apply(p.project);
    // Open on the action: frame subjects, not the buildings around them.
    scene.frame(openingSubjects(project.scene.entities), 10);

    applyHidden();
    const v = params.get('view'); setStep(v === 'sequence' ? 'cut' : v === 'shoot' ? 'shoot' : 'build');
    setTimeout(poll, 1200);
  } catch (e) {
    app.replaceChildren(h('div', { class: 'empty-state', style: 'margin:80px auto;max-width:420px' }, (e as Error).message, h('br'), h('a', { href: '/', class: 'btn', style: 'margin-top:12px' }, 'Back to projects')));
  }
}
void boot();
