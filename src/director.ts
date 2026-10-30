import './director.css';
import { SHAPES, MOVES, MAX_DURATION, ROLES, handleOf, cameraKeys, compilePrompt, describeCamera, focusPoint, objectLooks, lookPrompt, lookViews, shotCast, lookSource, videoReferences, castRows, castCard, normalizeCast, entityAt, upsertKey, removeKeys, sceneLength, MAX_SCENE_TIME, withDescendants, rootOf } from '../shared/director.mjs';
import type { DirectorProject, Shot, Entity, Reference, Message, Vec3, Asset, EditClip } from '../shared/director.mjs';
import { api, h, toast, connectDialog, shapeIcon, readFileBase64 } from './director-common';
import type { AgentStatus, Connect } from './director-common';
import { createDirectorScene } from './director-scene';
import { initOperate, operateBlock } from './director-operate'; // [operate]
import { installPhoneDemo } from './director-phone'; // [director-phone]
import { createSequence } from './director-sequence';
import { promptBlock } from './director-prompt';
import { objectColors, KIND_COLORS } from '../shared/prompt.mjs';
import { createAgentUi, agentText, ROUTES } from './director-agent'; // [agent]
import type { Route } from './director-agent';
import { shotPrompt } from '../shared/prompt.mjs';
import { openLooksBoard, aspectFor } from './director-looks';
import { prepareShotVideo, videoChoices, referenceCapacity, plannedReferences } from './director-videogen';
import type { TransformChange } from './director-scene';
import { Selection, UndoStack, targetConsumesKey, recreateOps, snap } from '../shared/editor-controls.mjs';
import type { UndoEntry, ModalMode } from '../shared/editor-controls.mjs';
import { openJourney } from './director-guide';

const params = new URLSearchParams(location.search);
const projectId = params.get('project') || '';
const app = document.getElementById('app')!;
let project: DirectorProject;
let shotId = params.get('shot') || '';
let selected: string | null = null;
let tab: 'direct' | 'shot' | 'object' = 'direct';
type Preset = { id: string; title: string; backend: 'cloud' | 'local'; note: string; pricing: { status: string; usdPerImage: number | null; creditsPerImage: number | null; rate?: string; source: string | null } };
let refgen: { presets: Preset[]; jobs: any[]; paidExecutionEnabled: boolean; cloudCredential: boolean } = { presets: [], jobs: [], paidExecutionEnabled: false, cloudCredential: false };
const genForm: Record<string, { prompt: string; presetId: string; aspect: string; count: number; seed: number; checkpoint: string; view: string; edited: boolean; open?: boolean }> = {};
let agent: AgentStatus | null = null, connect: Connect = null;
let playhead = 0, playing = false, lastTick = 0;
let mode: Route = 'auto'; // [agent]
let pendingAtts: string[] = [];
let seenMessages = 0;

const shot = (): Shot => project.shots.find(s => s.id === shotId) || project.shots[0];
const entity = (id: string | null) => project.scene.entities.find(e => e.id === id) || null;
const refUrl = (r: Reference) => `/director-refs/${project.id}/${r.file}`;
const assetUrl = (a: Asset) => `/director-assets/${project.id}/${a.file.replace(/^assets\//, '')}`;
const allRefs = () => project.shots.flatMap(s => s.references);
const fmt = (t: number) => `${t.toFixed(2)}s`;
const signature = (p: DirectorProject, s: Shot) => { const text = JSON.stringify([cameraKeys(s, p.scene.entities), s.duration, s.start || 0, p.scene.entities.filter(e => e.shape !== 'group').map(({ look, notes, name, styleNotes, lookFrom, parent, ...e }) => e), p.scene.environment.preset]); let x = 5381; for (let i = 0; i < text.length; i++) x = ((x << 5) + x + text.charCodeAt(i)) | 0; return (x >>> 0).toString(16); };

async function edit(ops: unknown[], quiet = false) {
  try { const r = await api('director/edit', { projectId, ops }); apply(r.project); return r; }
  catch (e) { if (!quiet) toast((e as Error).message, true); throw e; }
}

// ---------- Layout ----------
const titleInput = h('input', { 'aria-label': 'Project name', maxlength: 120 });
const sceneLabel = h('span', { class: 'muted' });
const pillSlot = h('span');
const claudeBtn = h('button', { class: 'btn ghost sm', type: 'button', title: 'Direct this scene from Claude', onclick: () => claudeDialog() }, h('span', { class: 'claude-mark', 'aria-hidden': 'true' }, '✳'), h('span', { class: 'hide-md' }, 'Direct with '), 'Claude');
function claudeDialog() {
  const d = h('dialog', { class: 'claude-help' },
    h('h3', {}, 'Direct with Claude'),
    h('p', {}, 'Previs is a connector in Claude Desktop and Claude Code. Ask Claude to build and direct this scene; edits appear here live, and every change can be undone.'),
    h('p', { class: 'muted' }, 'Try:'),
    h('ul', {},
      h('li', {}, `“In Previs, open ${project?.title || 'my project'} and add a second creator watching from the bridge.”`),
      h('li', {}, '“Write a Cast Card for every character, then make shot 1 a slow push-in on the car.”'),
      h('li', {}, '“Add three shots that cover the lift-off from different angles.”')),
    h('p', { class: 'muted' }, 'Setup: add the “comfy-previs” MCP server (node server/previs/agent.mjs, PREVIS_URL=http://127.0.0.1:<port>) to Claude.'),
    h('div', { class: 'bar', style: 'display:flex;justify-content:flex-end;margin-top:12px' }, h('button', { class: 'btn sm', type: 'button', onclick: () => d.close() }, 'Done')));
  d.addEventListener('close', () => d.remove());
  document.body.append(d); (d as HTMLDialogElement).showModal();
}
const previewBtn = h('button', { class: 'btn', type: 'button', title: 'Play the shot through the camera (Space)' }, '▶ Preview');
const looksBtn = h('button', { class: 'btn ghost', type: 'button', title: 'Design every object’s look and the project style; generate reference images in one batch' }, 'Looks');
const assetsBtn = h('button', { class: 'btn ghost', type: 'button', title: 'Every render, result, look and reference in this project' }, 'Assets');
const editBtn = h('button', { class: 'btn ghost', type: 'button', title: 'Cut the shots together and export one video' }, 'Edit');
const renderBtn = h('button', { class: 'btn camera', type: 'button' }, 'Render shot');
const sceneModeBtn = h('button', { type: 'button', role: 'tab', class: 'on', 'aria-selected': 'true', onclick: () => setMode('scene') }, 'Scene');
const seqModeBtn = h('button', { type: 'button', role: 'tab', 'aria-selected': 'false', title: 'Every shot in order: render, generate, choose versions, play and export the final video', onclick: () => setMode('sequence') }, 'Sequence');
const modeSwitch = h('div', { class: 'seg ws-mode', role: 'tablist', 'aria-label': 'Workspace' }, sceneModeBtn, seqModeBtn);
const top = h('header', { class: 'ws-top' },
  h('a', { class: 'brand', href: '/', title: 'All projects' }, h('span', { class: 'brand-mark' })),
  h('div', { class: 'crumbs' }, h('a', { href: '/', class: 'muted hide-md', style: 'text-decoration:none' }, 'Projects'), h('span', { class: 'sep hide-md' }, '/'), titleInput, h('span', { class: 'sep hide-lg' }, '·'), h('span', { class: 'hide-lg scene-name' }, sceneLabel)), modeSwitch,
  h('div', { class: 'right' }, h('button', { class: 'btn ghost sm hide-md', type: 'button', title: 'End-to-end guide and feature map', onclick: () => showJourney() }, 'Guide'), pillSlot, looksBtn, assetsBtn, previewBtn, renderBtn));

const shotList = h('div', { class: 'shots', role: 'listbox', 'aria-label': 'Shots' });
const outline = h('div', { class: 'outline', 'aria-label': 'Scene objects' });
const addMenu = h('div', { class: 'add-menu', hidden: true });
for (const shape of Object.keys(SHAPES).filter(x => x !== 'group')) addMenu.append(h('button', { type: 'button', title: `Add ${shape}`, onclick: () => addObject(shape) }, shapeIcon(shape), shape));
const rail = h('aside', { class: 'rail' },
  h('section', { class: 'rail-section' },
    h('div', { class: 'rail-head' }, h('span', { class: 'eyebrow' }, 'Shots'), h('button', { class: 'btn ghost sm icon', type: 'button', title: 'Add shot', 'aria-label': 'Add shot', onclick: () => addShot() }, '+')),
    shotList),
  h('section', { class: 'rail-section', style: 'flex:1' },
    h('div', { class: 'rail-head' }, h('span', { class: 'eyebrow' }, 'Scene'), h('button', { class: 'btn ghost sm icon', type: 'button', title: 'Add object', 'aria-label': 'Add object', onclick: () => { addMenu.hidden = !addMenu.hidden; } }, '+')),
    addMenu, outline));

const canvas = h('canvas', { class: 'main', 'aria-label': 'Scene viewport. Drag objects to arrange; drag empty space to orbit.' });
const labels = h('div', { class: 'labels' });
const monLabel = h('div', { class: 'mon-label' });
const monitor = h('div', { class: 'monitor', title: 'Click to look through the shot camera (C)', role: 'button', tabindex: 0 }, h('div', { class: 'mon-box' }, h('div', { class: 'thirds' }), h('div', { class: 'rec' }, h('i'), 'SHOT CAM'), monLabel));
monitor.style.background = 'transparent';
const frameLabel = h('div', { class: 'mon-label' });
const camFrame = h('div', { class: 'cam-frame', hidden: true }, h('div', { class: 'thirds' }), frameLabel);
const viewSeg = h('div', { class: 'seg', role: 'tablist' });
const setBtn = h('button', { type: 'button', class: 'on', onclick: () => setView('set') }, 'Set');
const camBtn = h('button', { type: 'button', onclick: () => setView('camera') }, 'Camera');
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
const viewport = h('div', { class: 'viewport' }, canvas, labels, camFrame, monitor,
  h('div', { class: 'vp-tools' }, viewSeg, modeSeg, snapBtn, h('button', { class: 'btn sm', type: 'button', onclick: () => frameSelected(), title: 'Frame selected, or everything (F, . or Numpad .)' }, 'Frame')),
  dropHint, hud, helpCard, addPopup, h('div', { class: 'hint' }, 'Click select · Shift+drag box · G/R/S move/rotate/resize · right-click add · ? controls'));
const playBtn = h('button', { class: 'btn sm icon', type: 'button', 'aria-label': 'Play' }, '▶');
const scrub = h('input', { type: 'range', min: 0, max: 3, step: 0.01, value: 0, 'aria-label': 'Playhead' });
const timeOut = h('span', { class: 'time' });
const moveChip = h('span', { class: 'movechip' });
const keyTrack = h('div', { class: 'keytrack', 'aria-label': 'Keyframes of the selection' });
const scrubWrap = h('div', { class: 'scrubwrap' }, scrub, keyTrack);
const keyBtn = h('button', { class: 'btn ghost sm icon', type: 'button', 'data-tip': 'Insert keyframe', 'data-keys': 'I', 'aria-label': 'Insert keyframe for the selection', onclick: () => insertKeys() }, '◆');
const prevKeyBtn = h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Previous keyframe', title: 'Previous keyframe', onclick: () => jumpKey(-1) }, '‹◆');
const nextKeyBtn = h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Next keyframe', title: 'Next keyframe', onclick: () => jumpKey(1) }, '◆›');
const stage = h('section', { class: 'stage' }, viewport, h('div', { class: 'transport' }, playBtn, timeOut, prevKeyBtn, keyBtn, nextKeyBtn, scrubWrap, moveChip));

const directTab = h('button', { type: 'button', hidden: true, onclick: () => setTab('direct') }, 'Direct');
const shotTab = h('button', { type: 'button', class: 'on', onclick: () => setTab('shot') }, 'Shot');
const objectTab = h('button', { type: 'button', hidden: true, onclick: () => setTab('object') }, 'Object');
const shotChip = h('span', { class: 'shotchip' });
const thread = h('div', { class: 'thread', 'aria-live': 'polite' });
const textarea = h('textarea', { placeholder: 'Ask or direct: “slow dolly in on @runner”, “write the prompt for shot 2”… @ mentions objects · Enter sends · Shift+Enter newline', rows: 3, 'aria-label': 'Direction' });
const attsRow = h('div', { class: 'pending-atts' });
const routeSel = h('select', { 'aria-label': 'Send to' }, ...ROUTES.map(r => h('option', { value: r.value, title: r.title }, r.label))); // [agent]
const routeNote = h('span');
const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true });
const suggest = h('div', { class: 'suggest', hidden: true });
const sendBtn = h('button', { class: 'btn primary sm', type: 'button' }, 'Send');
const composer = h('div', { class: 'composer' }, suggest, attsRow, textarea, h('div', { class: 'bar' }, h('span', { class: 'route' }, routeSel, routeNote), fileInput, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => fileInput.click(), title: 'Attach reference images' }, '＋ Image'), sendBtn));
const chips = h('div', { class: 'chips' });
const directPane = h('div', { class: 'pane' }, thread, chips, composer);
const shotPane = h('div', { class: 'pane shotpane', hidden: true });
const objectPane = h('div', { class: 'pane shotpane objectpane', hidden: true });
const side = h('aside', { class: 'side' }, h('div', { class: 'tabs', role: 'tablist' }, directTab, shotTab, objectTab, shotChip), h('div', { style: 'min-height:0;display:grid' }, directPane, shotPane, objectPane));
const wsBody = h('div', { class: 'ws-body' }, rail, stage, side);
// Sequence view (src/director-sequence.ts) shares the top bar and replaces the workspace body.
const sequence = createSequence({
  project: () => project, apply: p => apply(p), runEntry: async e => { await runEntry(e); }, signature, assetUrl,
  thumbnail: (s, w, hh) => scene.thumbnail(s, w, hh),
  prompt: s => shotPrompt(project, s, 'video'),
  capture: (s, o) => captureShotVideo(s, { width: 1280, height: 720, prompt: shotPrompt(project, s, 'video'), ...o }),
  openShot: id => { setMode('scene'); selectShot(id); }, openEditor: () => openEditor(),
});
let wsMode: 'scene' | 'sequence' = 'scene';
function setMode(m: typeof wsMode) {
  wsMode = m; wsBody.hidden = m !== 'scene';
  for (const [b, on] of [[sceneModeBtn, m === 'scene'], [seqModeBtn, m === 'sequence']] as const) { b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
  for (const b of [previewBtn, renderBtn]) b.hidden = m !== 'scene';
  if (m === 'sequence') togglePlay(false);
  void sequence.show(m === 'sequence');
  const q = new URLSearchParams(location.search); if (m === 'sequence') q.set('view', 'sequence'); else q.delete('view'); history.replaceState(null, '', `?${q}`);
}
app.replaceChildren(top, wsBody, sequence.el);

function showJourney() {
  if (!project) { toast('Wait for the project to finish loading.'); return; }
  const scenePanel = (t: 'direct' | 'shot') => {
    setMode('scene');
    if (collapsed.side) setCollapsed('side', false);
    setTab(t);
    (t === 'direct' ? textarea : shotTab).focus();
  };
  openJourney({
    context: `${project.title} · Browser-owned scene · ${project.scene.entities.length} objects · ${project.shots.length} shots · ${project.assets?.length || 0} saved video assets. Counts describe saved work, not quality acceptance.`,
    actions: {
      scene: () => scenePanel('shot'),
      looks: () => openLooks(),
      shot: () => scenePanel('shot'),
      capture: () => { setMode('scene'); openRender(); },
      workflow: () => { setMode('sequence'); seqModeBtn.focus(); },
      compare: () => { setMode('sequence'); seqModeBtn.focus(); },
      export: () => { void openAssets(); },
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
  const label = which === 'rail' ? 'Toggle shots & scene panel' : 'Toggle direction panel';
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
    // Focus the editor camera on what you clicked (the orbit then pivots around it).
    if (mode === 'replace' && selection.has(id) && scene.view() === 'set') scene.frame([id], 1.2);
    if (selection.ids.length) setTab('object');
  },
  onMarquee(ids) { selection.addMany(ids); if (selection.ids.length) setTab('object'); },
  onContextMenu(x, y) { openAddPopup(x, y); },
  onTransformCommit(changes, label) { void commitTransforms(changes, label); },
  onModal(text) { hud.hidden = !text; hud.textContent = text || ''; },
  onRefImage(id) { const look = objectLooks(project, id)[0]; if (look) return refUrl(look); const own = shot()?.references.find(r => r.entityId === id && r.role !== 'style') || allRefs().find(r => r.entityId === id && r.role !== 'style'); return own ? refUrl(own) : null; },
});
// [operate] Live camera operating (gamepad / keyboard / phone) in the Shot tab.
initOperate({ scene, viewport, project: () => project, shot, setView, runEntry, toast, setPlayhead(t) { playing = false; playhead = t; scene.setPlayhead(t); renderTransport(); } });
const selection = new Selection();
const undoStack = new UndoStack();
// [agent] Built-in agent UI: live stream, proposal cards, prompt actions. Undo entries land on the same stack.
const agentUi = createAgentUi({ projectId, project: () => project, apply: p => apply(p), runEntry: e => runEntry(e), pushUndo: e => { undoStack.push(e); renderUndo(); }, refresh: () => pollNow(), resend: (text, sid) => { textarea.value = text; if (sid) shotId = sid; void send(); }, selectShot: id => { selectShot(id); setTab('shot'); } });
selection.subscribe(sel => { selected = sel.primary; scene.setSelection(sel.ids, sel.primary); scene.setOutlineColor(colorOf(sel.primary)); renderOutline(); renderInspector(); renderObjectPane(); shotPane.dataset.shot = ''; renderShotPane(); renderKeyTrack(); });

// ---------- Rendering ----------
function apply(next: DirectorProject) {
  project = next;
  if (!project.shots.some(s => s.id === shotId)) shotId = project.shots[0].id;
  selection.retain(new Set(project.scene.entities.map(e => e.id)));
  if (document.activeElement !== titleInput) titleInput.value = project.title;
  sceneLabel.textContent = project.scene.name;
  document.title = `${project.title} · Comfy Previs`;
  scrub.max = String(shot().duration);
  if (playhead > shot().duration) playhead = shot().duration;
  scene.sync(project, shot());
  renderShots(); renderOutline(); renderThread(); renderInspector(); renderShotPane(); renderObjectPane(); renderTransport(); renderRoute();
  history.replaceState(null, '', `?project=${project.id}&shot=${shotId}${wsMode === 'sequence' ? '&view=sequence' : ''}`);
  sequence.refresh(); looksBoard?.refresh();
}

function renderShots() {
  shotList.replaceChildren(...project.shots.map((s, i) => {
    const c = h('canvas', { width: 176, height: 99 });
    const stale = s.render && s.render.signature && s.render.signature !== signature(project, s);
    const b = h('button', { class: 'shot' + (s.id === shotId ? ' active' : ''), type: 'button', role: 'option', 'aria-selected': String(s.id === shotId), onclick: () => selectShot(s.id) },
      c,
      h('span', { class: 'info' },
        h('span', { class: 'num' }, String(i + 1).padStart(2, '0'), s.render ? h('span', { class: 'rendered' + (stale ? ' stale' : ''), title: stale ? 'Rendered before the latest changes' : 'Camera video exported' }, stale ? 'Changed' : 'Rendered') : null),
        h('span', { class: 'title' }, s.title),
        h('span', { class: 'sub' }, `${MOVES[s.camera.move]} · ${s.duration}s${s.references.length ? ` · ${s.references.length} ref` : ''}`)));
    requestAnimationFrame(() => { try { c.getContext('2d')!.drawImage(scene.thumbnail(s), 0, 0); } catch {} });
    return b;
  }));
}

const openGroups = new Set<string>(JSON.parse(localStorage.getItem(`previs.open.${projectId}`) || '[]'));
function toggleGroup(id: string) { if (openGroups.has(id)) openGroups.delete(id); else openGroups.add(id); localStorage.setItem(`previs.open.${projectId}`, JSON.stringify([...openGroups])); renderOutline(); }
function renderOutline() {
  const all = project.scene.entities, ids = new Set(all.map(e => e.id));
  const kids = (pid: string) => all.filter(e => e.parent === pid);
  const roots = all.filter(e => !e.parent || !ids.has(e.parent));
  // Selected objects inside a closed group open their path, so the selection is always visible.
  for (const sid of selection.ids) for (let e = entity(sid); e?.parent; e = entity(e.parent)) openGroups.add(e.parent);
  const groups: Record<string, Entity[]> = { character: [], vehicle: [], prop: [], environment: [] };
  for (const e of roots) (groups[e.kind] ||= []).push(e);
  outline.replaceChildren();
  if (!all.length) outline.append(h('p', { class: 'note', style: 'padding:6px' }, 'Empty stage. Add objects with +, or ask Claude to build the scene.'));
  const row = (e: Entity, depth: number): Node[] => {
    const children = kids(e.id), open = openGroups.has(e.id);
    const ref = objectLooks(project, e.id)[0] || allRefs().find(r => r.entityId === e.id && r.role !== 'style');
    const btn = h('button', { class: 'obj' + (selection.has(e.id) ? ' active' : '') + (children.length ? ' parent' : ''), type: 'button', style: `--depth:${depth};--k:${KIND_COLORS[e.kind]}`, onclick: (ev: MouseEvent) => { if (ev.shiftKey || ev.ctrlKey || ev.metaKey) selection.toggle(e.id); else { selection.set([e.id], e.id); if (scene.view() === 'set') scene.frame([e.id], 1.2); } if (selection.ids.length) setTab('object'); }, ondblclick: () => scene.focusOn(e) },
      children.length ? h('span', { class: 'twisty' + (open ? ' open' : ''), role: 'button', 'aria-label': open ? 'Collapse' : 'Expand', onclick: (ev: MouseEvent) => { ev.stopPropagation(); toggleGroup(e.id); } }, '›') : h('span', { class: 'twisty none' }),
      e.shape === 'group' ? h('span', { class: 'sw grp' }) : h('span', { class: 'sw', style: `background:${e.color}` }),
      h('span', { class: 'name' }, e.name),
      children.length ? h('span', { class: 'count' }, String(withDescendants(all, [e.id]).length - 1)) : null,
      e.id === shot().camera.target ? h('span', { class: 'tgt', title: 'Camera target' }, '◎') : null,
      ref ? h('img', { class: 'refdot', src: refUrl(ref), alt: '', title: `Reference: ${ref.name}` }) : null);
    return [btn, ...(open ? children.flatMap(c => row(c, depth + 1)) : [])];
  };
  for (const [kind, list] of Object.entries(groups)) {
    if (!list.length) continue;
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

function richText(text: string) {
  const out = h('div', { class: 'body' });
  const parts = text.split(/(@[a-z0-9-]+)/gi);
  for (const part of parts) {
    const e = part.startsWith('@') ? project.scene.entities.find(x => handleOf(x.name) === part.slice(1).toLowerCase()) : null;
    out.append(e ? h('span', { class: 'mention', title: e.kind }, e.name) : part);
  }
  return out;
}

function renderThread() {
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
  thread.replaceChildren();
  let lastShot: string | null | undefined;
  for (const m of project.messages) {
    if (m.shotId && m.shotId !== lastShot && m.role === 'user') {
      const s = project.shots.find(x => x.id === m.shotId);
      if (s) thread.append(h('button', { class: 'divider', type: 'button', style: 'border:0;background:none;cursor:pointer;width:100%', onclick: () => selectShot(s.id) }, `SHOT ${String(project.shots.indexOf(s) + 1).padStart(2, '0')} · ${s.title}`));
      lastShot = m.shotId;
    }
    thread.append(messageView(m));
  }
  if (project.messages.length !== seenMessages || atBottom) thread.scrollTop = thread.scrollHeight;
  seenMessages = project.messages.length;
  const s = shot(), target = entity(s.camera.target);
  const handle = target ? '@' + handleOf(target.name) : 'the subject';
  chips.replaceChildren(...[`Add a red car on the left`, `Slow dolly in on ${handle}, 50mm, low angle`, `Orbit around ${handle} over 4 seconds`, `New shot: wide establishing crane up`].map(t => h('button', { type: 'button', onclick: () => { textarea.value = t; textarea.focus(); } }, t)));
  chips.hidden = project.messages.filter(m => m.role === 'user').length > 6;
}

function messageView(m: Message) {
  const who = m.role === 'user' ? 'You' : m.role === 'agent' ? (m.via === 'runner' ? 'Agent' : 'Your agent') : m.role === 'builtin' ? 'Parser' : 'Previs';
  const av = m.role === 'user' ? 'Y' : m.role === 'agent' ? 'A' : m.role === 'builtin' ? '⚙' : '◐';
  const refs = m.attachments.map(id => allRefs().find(r => r.id === id)).filter(Boolean) as Reference[];
  return h('div', { class: `msg ${m.role}${m.error ? ' error' : ''}`, dataset: { msg: m.id } },
    h('div', { class: 'av', 'aria-hidden': 'true' }, av),
    h('div', {},
      h('div', { class: 'who' }, h('b', {}, who), new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })),
      m.role === 'agent' ? agentText(m.text, richText) : richText(m.text),
      refs.length ? h('div', { class: 'atts' }, ...refs.map(r => h('img', { src: refUrl(r), alt: r.name, title: `${r.name}${r.entityId ? ' → ' + (entity(r.entityId)?.name || '') : ''}` }))) : null,
      m.handledBy === 'runner' && m.status !== 'handled' ? null : activityView(m),
      ...agentUi.extras(m), // [agent] thinking block, proposal card, prompt actions, retry
      m.role === 'user' && m.status !== 'handled' && m.handledBy !== 'runner' ? h('div', { class: 'pending' }, m.status === 'claimed' ? (m.activity?.length ? h('span', { class: 'working' }, 'Working…') : h('span', { class: 'working' }, 'Agent is working…')) : 'Waiting for agent…', h('button', { type: 'button', onclick: () => void api('director/message/builtin', { projectId, messageId: m.id }).then(r => apply(r.project)).catch(e => toast(e.message, true)) }, 'Use built-in parser')) : null));
}

// Agent steps under the message being worked on: live while working, collapsed when done.
function activityView(m: Message) {
  if (m.role !== 'user' || !m.activity?.length) return null;
  const secs = m.workStartedAt ? Math.max(1, Math.round(((m.workEndedAt ? Date.parse(m.workEndedAt) : Date.now()) - Date.parse(m.workStartedAt)) / 1000)) : 0;
  const rows = m.activity.map((a, i) => h('li', { class: (a.auto ? 'auto' : '') + (m.status !== 'handled' && i === m.activity!.length - 1 ? ' live' : '') }, a.text));
  if (m.status === 'handled') return h('details', { class: 'activity done' }, h('summary', {}, `Worked for ${secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`} · ${m.activity.length} step${m.activity.length === 1 ? '' : 's'}`), h('ol', {}, ...rows));
  return h('ol', { class: 'activity live' }, ...rows.slice(-8));
}

function renderRoute() { // [agent]
  pillSlot.replaceChildren(claudeBtn);
  routeNote.textContent = agentUi.routeNote(mode, agent);
}

function renderTransport() {
  const s = shot();
  scrub.value = String(playhead);
  timeOut.textContent = `${fmt(playhead)} / ${fmt(s.duration)}${s.start ? ` · scene ${fmt((s.start || 0) + playhead)}` : ''}`;
  moveChip.textContent = describeCamera(s, project.scene.entities);
  playBtn.textContent = playing ? '❚❚' : '▶';
  renderKeyTrack();
  const label = `SHOT ${String(project.shots.indexOf(s) + 1).padStart(2, '0')} · ${MOVES[s.camera.move]} · ${Math.round(scene.pose().mm)}mm`;
  monLabel.replaceChildren(h('span', {}, label), h('span', {}, fmt(playhead)));
  frameLabel.replaceChildren(h('span', {}, label), h('span', {}, `${fmt(playhead)} / ${fmt(s.duration)}`));
  shotChip.textContent = `SHOT ${String(project.shots.indexOf(s) + 1).padStart(2, '0')}`;
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
function loadGen() { if (genCache || genLoading) return; genLoading = true; api('generation').then(st => { genCache = st; shotPane.dataset.shot = ''; renderShotPane(); }).catch(() => {}).finally(() => { genLoading = false; }); }
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
  const hasStart = frames.some(r => r.note !== 'key frame end'), hasEnd = frames.some(r => r.note === 'key frame end');
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
    def.description ? h('p', { class: 'note vm-desc' }, def.description) : null,
    h('div', { class: 'vm-inputs' },
      h('div', { class: 'vm-head' }, 'What this model takes'),
      slot(!maxLen || promptLen <= maxLen, 'Text prompt', maxLen ? h('span', {}, `${promptLen.toLocaleString()} / ${maxLen.toLocaleString()} characters`, promptLen > maxLen ? h('b', { class: 'vm-over' }, ' · will be cut') : '') : `${promptLen.toLocaleString()} characters`),
      usesClip ? slot(s.render ? !stale : false, 'Blockout video', s.render ? (stale ? 'Rendered, but the scene changed since · re-render' : `Your camera move · ${s.render.duration}s, ${s.render.frameCount} frames`) : 'Not rendered yet · Render shot first') : slot(null, 'Blockout video', 'Not used · describe the motion in the prompt'),
      usesFrames ? slot(hasStart, twoFrames ? 'Start frame' : 'First frame', hasStart ? 'Key frame ready' : 'Generate a key frame below') : null,
      twoFrames ? slot(hasEnd, 'End frame', hasEnd ? 'Key frame ready' : 'Generate an end key frame below') : null,
      slot(cap ? refs.length > 0 : null, 'Reference images', cap ? `${refs.length} of up to ${cap}` : 'Not accepted by this model')),
    cap ? h('div', { class: 'vm-map' },
      h('div', { class: 'vm-head' }, 'Shot objects → model inputs'),
      ...refs.map((r, i) => h('div', { class: 'vm-ref', style: `--k:${KIND_COLORS[entity(r.entityId!)?.kind || 'prop']}`, onmouseenter: () => { if (r.entityId) { scene.setHover(r.entityId); highlightPrompt(r.entityId); } }, onmouseleave: () => { scene.setHover(null); highlightPrompt(selected); } },
        h('span', { class: 'vm-n' }, `Image ${i + 1}`), h('img', { src: refUrl(r.ref), alt: '' }), h('span', { class: 'vm-name' }, r.label))),
      ...cast.filter(r => !sent.has(r.entity.id)).map(r => h('div', { class: 'vm-ref missing', style: `--k:${KIND_COLORS[r.entity.kind]}` },
        h('span', { class: 'vm-n' }, objectLooks(project, r.entity.id).length ? 'Over limit' : 'No image'), h('span', { class: 'vm-ph' }), h('span', { class: 'vm-name' }, r.entity.name)))) : null,
    h('button', { class: 'btn camera vm-go', type: 'button', onclick: () => openRender() }, s.render && !stale ? 'Generate video…' : 'Render blockout, then generate…'));
}
function renderShotPane() {
  if (shotPane.contains(document.activeElement) && shotPane.dataset.shot === shotId) return;
  shotPane.dataset.shot = shotId;
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
  const drop = h('label', { class: 'dropzone' }, h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true, onchange: (ev: Event) => { const files = Array.from((ev.target as HTMLInputElement).files || []); void uploadRefs(files, null, false); } }), 'Drop images here or click to add references for this shot');
  dropTarget(drop, files => uploadRefs(files, null, false));
  shotPane.replaceChildren(
    h('div', { class: 'block' },
      h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, `Shot ${String(idx + 1).padStart(2, '0')}`), h('button', { class: 'btn ghost sm', type: 'button', disabled: project.shots.length < 2, title: 'Delete this shot', onclick: () => { if (confirm(`Delete “${s.title}”? Its references stay on disk.`)) void edit([{ op: 'remove_shot', id: s.id }]); } }, 'Delete')),
      title, descBox),
    castBlock(s),
    modelBlock(s),
    promptBlock(s, { project: () => project, runEntry: e => runEntry(e as any), select: id => { select(id); setTab('object'); } }),
    h('div', { class: 'block' },
      h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, 'Camera'), h('span', { class: 'muted', style: 'font-size:11.5px' }, describeCamera(s, project.scene.entities))),
      h('div', { class: 'grid2' }, h('label', {}, 'Move', move), h('label', {}, 'Target', target)),
      h('div', { class: 'slider-row' }, 'Starts at', numberField('Start', s.start || 0, { rate: 0.05, snapTo: 0.5, min: 0, max: MAX_SCENE_TIME, unit: 's', onPreview: v => { s.start = v; scene.sync(project, s); renderTransport(); }, onCommit: (v, from) => void runEntry({ label: 'Shot start', redo: [{ op: 'update_shot', id: s.id, patch: { start: v } }], undo: [{ op: 'update_shot', id: s.id, patch: { start: from } }] }) }), h('output', {}, `of ${sceneLength(project).toFixed(1)}s`)),
      slider('Duration', 0.5, MAX_DURATION, 0.25, s.duration, 's', v => { s.duration = v; scrub.max = String(v); scene.sync(project, s); renderTransport(); }, v => void edit([{ op: 'update_shot', id: s.id, patch: { duration: v } }])),
      slider('Lens', 12, 135, 1, Math.round(s.camera.mm), 'mm', v => local({ mm: v, ...(custom ? { keys: s.camera.keys!.map(k => ({ ...k, mm: v })) } : {}) }), v => commit({ mm: v, ...(custom ? { keys: s.camera.keys!.map(k => ({ ...k, mm: v })) } : {}) })),
      custom ? h('p', { class: 'note', style: 'margin:0' }, 'Custom keys from the set view. Pick a move above to go back to a preset.') : h('div', { class: 'block', style: 'gap:6px' },
        slider('Distance', 0.5, 30, 0.1, s.camera.distance, 'm', v => local({ distance: v }), v => commit({ distance: v })),
        slider('Height', 0.1, 15, 0.1, s.camera.height, 'm', v => local({ height: v }), v => commit({ height: v })),
        slider('Angle', -180, 180, 1, s.camera.angle, '°', v => local({ angle: v }), v => commit({ angle: v }))),
      h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => keyFromView('start'), title: 'Use the current set view as the first camera position' }, 'Set start from view'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => keyFromView('end'), title: 'Use the current set view as the last camera position' }, 'Set end from view'),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => scene.lookThrough() }, 'Go to camera'))),
    operateBlock(s), // [operate]
    h('div', { class: 'block' },
      h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, `References · ${s.references.length}`), h('span', { class: 'muted', style: 'font-size:11.5px' }, 'Link each image to an object')),
      refsGrid, drop),
    keyFrameBlock(s),
    ...resultsBlock(s),
    ...(rendered ? [h('div', { class: 'block' },
      h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, 'Last render'), stale ? h('span', { style: 'color:var(--warn);font-size:11.5px' }, 'Scene or camera changed since') : h('span', { style: 'color:var(--ok);font-size:11.5px' }, 'Up to date')),
      h('video', { src: `/assets/${rendered.assetId}.mp4`, controls: true, muted: true, loop: true, playsinline: true, style: 'width:100%;border-radius:8px;border:1px solid var(--line)' }),
      h('div', { class: 'facts' }, 'Frames', h('b', {}, `${rendered.frameCount} @ 24 fps`), 'Duration', h('b', {}, `${Number(rendered.duration).toFixed(2)}s`), 'Size', h('b', {}, `${rendered.width}×${rendered.height}`)),
      h('a', { class: 'btn sm', href: workflowUrl(rendered.previsShotId, rendered.assetId, rendered.prompt), target: '_blank' }, 'Open in Comfy workflow →'))] : []));
  placeObjectPane();
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
function keyFrameBlock(s: Shot) {
  const f = frameForm[s.id] ||= { open: false, presetId: 'flux-3', count: 1, seed: Math.floor(Math.random() * 1e6), prompt: null, guide: true, checkpoint: '' };
  const frames = s.references.filter(r => r.role === 'frame');
  const jobs = refgen.jobs.filter(j => j.target === 'shot' && j.shotId === s.id);
  const quoted = jobs.find(j => j.status === 'quoted');
  const head = h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, `Key frames · ${frames.length}`), h('button', { class: 'btn sm', type: 'button', onclick: () => { f.open = !f.open; if (f.open && !refgen.presets.length) void loadRefgen(); shotPane.dataset.shot = ''; renderShotPane(); } }, f.open ? 'Close' : '✦ Generate key frame'));
  const gallery = frames.length ? h('div', { class: 'refs' }, ...frames.map(r => h('div', { class: 'ref' }, h('img', { src: refUrl(r), alt: r.name, loading: 'lazy', title: r.generated ? `${r.generated.model} · seed ${r.generated.seed}` : r.name }), h('div', { class: 'ref-body' }, h('span', { class: 'ref-name' }, h('span', {}, r.name)), h('span', { class: 'link' }, r.generated ? `✦ ${r.generated.model.split(' (')[0]}` : 'Uploaded'))))) : h('p', { class: 'note', style: 'margin:0' }, 'Generate a styled still of this shot from its blockout frame and prompt. Key frames are named in the render prompt as the look to match.');
  if (!f.open) return h('div', { class: 'block' }, head, gallery, ...jobs.filter(j => j.status !== 'quoted').slice(0, 3).map(jobRow));
  const prompt = h('textarea', { class: 'field', rows: 4, 'aria-label': 'Key frame prompt' }, f.prompt ?? shotPrompt(project, s, 'image'));
  prompt.oninput = () => { f.prompt = prompt.value; };
  const model = h('select', { class: 'field', 'aria-label': 'Model' }, ...refgen.presets.map(p => h('option', { value: p.id, selected: p.id === f.presetId }, `${p.title}${p.backend === 'cloud' ? ' · Cloud' : ''}`)));
  model.onchange = () => { f.presetId = model.value; shotPane.dataset.shot = ''; renderShotPane(); };
  const count = h('select', { class: 'field', 'aria-label': 'Images' }, ...[1, 2, 3, 4].map(n => h('option', { value: n, selected: n === f.count }, `${n} image${n > 1 ? 's' : ''}`)));
  count.onchange = () => { f.count = Number(count.value); };
  const seed = h('input', { class: 'field', type: 'number', min: 0, value: f.seed, 'aria-label': 'Seed' }); seed.onchange = () => { f.seed = Math.max(0, Math.floor(Number(seed.value) || 0)); };
  const guide = h('input', { type: 'checkbox', checked: f.guide }); guide.onchange = () => { f.guide = guide.checked; };
  const local = refgen.presets.find(p => p.id === f.presetId)?.backend === 'local';
  if (local && checkpoints === null) void loadCheckpoints();
  if (checkpoints?.length && !checkpoints.includes(f.checkpoint)) f.checkpoint = checkpoints.find(c => /v1-5|sd|xl/i.test(c)) || checkpoints[0];
  const ckpt = h('select', { class: 'field', 'aria-label': 'Checkpoint' }, ...(checkpoints?.length ? checkpoints.map(c => h('option', { value: c, selected: c === f.checkpoint }, c)) : [h('option', { value: '' }, checkpointError || 'Loading installed checkpoints…')]));
  ckpt.onchange = () => { f.checkpoint = ckpt.value; };
  const status = h('div', { class: 'status-line' });
  const quoteBtn = h('button', { class: 'btn camera', type: 'button' }, `Generate${estLabel(f.presetId, f.count)}`);
  quoteBtn.onclick = async () => {
    quoteBtn.disabled = true; status.className = 'status-line'; status.textContent = 'Rendering the guide frame and sending…';
    try {
      const guidePng = f.guide ? scene.capture(playhead, 1280, 720).split(',')[1] : undefined;
      // Consistency: send the looks of everything in shot plus the previous shot's latest key frame.
      const cap = f.presetId === 'flux-3' ? 9 : f.presetId === 'flux-2-pro' ? 7 : 0;
      const looks = cap ? videoReferences(project, s, cap).filter(r => r.role !== 'frame' && r.role !== 'style') : [];
      const prev = project.shots[project.shots.indexOf(s) - 1]?.references.filter(r => r.role === 'frame').at(-1);
      const refIds = [...looks.map(r => r.ref.id), ...(prev ? [prev.id] : [])].slice(0, cap);
      const first = guidePng ? 2 : 1;
      const legend = refIds.length ? `\n${guidePng ? 'Image 1 is a grey blockout of this frame: match its camera, framing and object positions, not its look. ' : ''}${looks.slice(0, refIds.length).map((r, i) => `The ${r.label} looks exactly like image ${i + first}.`).join(' ')}${prev && refIds.includes(prev.id) ? ` Image ${refIds.length + first - 1} is the previous shot: keep the same designs, lighting and grade.` : ''} No text or lettering.` : '';
      const { job } = await api('director/refgen/prepare', { projectId, target: 'shot', shotId: s.id, presetId: f.presetId, prompt: (prompt.value + legend).slice(0, 2500), aspect: '16:9', count: f.count, seed: f.seed, referenceIds: refIds, ...(guidePng ? { guide: guidePng } : {}), ...(local && f.checkpoint ? { checkpoint: f.checkpoint } : {}) });
      await generateNow(job); status.textContent = 'Generating… results attach to this shot.';
      shotPane.dataset.shot = ''; renderShotPane();
    } catch (e) { status.className = 'status-line err'; status.textContent = (e as Error).message; }
    finally { quoteBtn.disabled = false; }
  };
  return h('div', { class: 'block' }, head, gallery, prompt,
    h('div', { class: 'grid2' }, h('label', {}, 'Model', model), h('label', {}, 'Images', count)),
    h('div', { class: 'grid2' }, h('label', {}, 'Seed', seed), local ? h('label', {}, 'Checkpoint', ckpt) : h('span')),
    h('label', { class: 'check-row', style: 'display:flex;gap:8px;align-items:center;font-size:12px;color:var(--muted)' }, guide, `Use the camera's blockout frame at ${playhead.toFixed(2)}s as the composition`),
    h('div', { style: 'display:flex;gap:8px;align-items:center' }, quoteBtn), status,
    ...jobs.filter(j => j.status !== 'quoted').slice(0, 3).map(jobRow));
}

// ---------- Results & assets ----------
function resultsBlock(s: Shot): Node[] {
  const results = (project.assets || []).filter(a => a.kind === 'workflow-result' && a.shotId === s.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!results.length) return [];
  return [h('div', { class: 'block' },
    h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, `Workflow results · ${results.length}`)),
    ...results.slice(0, 3).map(a => h('div', { style: 'display:flex;flex-direction:column;gap:4px' },
      a.mime.startsWith('video/') ? h('video', { src: assetUrl(a), controls: true, muted: true, loop: true, playsinline: true, preload: 'metadata', style: 'width:100%;border-radius:8px;border:1px solid var(--line)' }) : h('img', { src: assetUrl(a), alt: '', style: 'width:100%;border-radius:8px' }),
      h('div', { class: 'facts' }, 'Workflow', h('b', {}, a.source.workflow || '—'), 'Output', h('b', {}, `${a.frameCount ?? '—'} frames · ${a.duration != null ? Number(a.duration).toFixed(2) : '—'}s · ${a.width}×${a.height}`)),
      a.source.jobId ? h('a', { class: 'btn sm', href: `/generation.html?job=${a.source.jobId}&output=${a.source.resultId}`, target: '_blank' }, 'Compare with source →') : null)))];
}
assetsBtn.onclick = () => void openAssets();
async function openAssets() {
  document.getElementById('assets-dialog')?.remove();
  let assets: Asset[] = [];
  try { assets = (await api(`director/assets?id=${projectId}`)).assets; } catch (e) { toast((e as Error).message, true); }
  const shotLabel = (id: string) => { const i = project.shots.findIndex(x => x.id === id); return i < 0 ? 'Removed shot' : `Shot ${String(i + 1).padStart(2, '0')} · ${project.shots[i].title}`; };
  type Item = { kind: 'cut' | 'render' | 'result' | 'look' | 'ref'; title: string; sub: string; url: string; video: boolean; created: string; meta: string; actions: Node[] };
  const items: Item[] = [
    ...assets.map(a => ({
      kind: a.kind === 'camera-render' ? 'render' as const : a.kind === 'edit' ? 'cut' as const : 'result' as const,
      title: a.kind === 'camera-render' ? `Camera render v${a.version ?? 1}` : a.kind === 'edit' ? `Edit v${a.version ?? 1} · ${a.source.clips?.length ?? 0} clips` : a.source.workflow || 'Workflow result',
      sub: (a.kind === 'edit' ? 'Whole cut' : shotLabel(a.shotId!)) + (a.imported ? ' · imported' : ''), url: assetUrl(a), video: a.mime.startsWith('video/'), created: a.createdAt,
      meta: `${a.frameCount ?? '—'}f · ${a.duration != null ? Number(a.duration).toFixed(2) : '—'}s · ${a.width}×${a.height}`,
      actions: [h('a', { class: 'btn sm', href: assetUrl(a), download: `${a.id}.${a.file.split('.').pop()}` }, 'Download'),
        a.kind === 'camera-render' && !a.imported ? h('a', { class: 'btn sm', href: workflowUrl(a.source.engineShotId!, a.source.engineAssetId || a.id, a.source.prompt || ''), target: '_blank' }, 'Open in workflow') : null,
        a.kind === 'workflow-result' && a.source.jobId ? h('a', { class: 'btn sm', href: `/generation.html?job=${a.source.jobId}&output=${a.source.resultId}`, target: '_blank' }, 'Compare') : null].filter(Boolean) as Node[],
    })),
    ...(project.scene.references || []).filter(r => entity(r.entityId)).map(r => ({ kind: 'look' as const, title: r.name, sub: `Look · ${entity(r.entityId)?.name || 'object'}${entity(r.entityId)?.look === r.id ? ' · primary' : ''}`, url: refUrl(r), video: false, created: r.createdAt, meta: r.generated ? `✦ ${r.generated.model.split(' (')[0]} · seed ${r.generated.seed}` : 'uploaded', actions: [h('a', { class: 'btn sm', href: refUrl(r), download: r.file }, 'Download')] })),
    ...project.shots.flatMap(s => s.references.map(r => ({ kind: 'ref' as const, title: r.name, sub: `${shotLabel(s.id)} · ${r.role}`, url: refUrl(r), video: false, created: r.createdAt, meta: entity(r.entityId) ? `→ ${entity(r.entityId)!.name}` : 'not linked', actions: [h('a', { class: 'btn sm', href: refUrl(r), download: r.file }, 'Download')] }))),
  ].sort((a, b) => b.created.localeCompare(a.created));
  const labels = { all: 'All', cut: 'Edits', render: 'Camera renders', result: 'Workflow results', look: 'Object looks', ref: 'Shot references' } as const;
  let filter: keyof typeof labels = 'all';
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
    h('div', { class: 'dialog-head' }, h('h2', { id: 'assets-title' }, `Assets · ${project.title}`), h('a', { class: 'btn sm', href: `/api/director/export?id=${project.id}`, download: '' }, 'Export project (.zip)'), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'assets-body' }, seg, h('p', { class: 'note', style: 'margin:0' }, 'Everything here lives in this project’s own folder, so exporting it carries renders, results, looks and references together.'), grid));
  document.body.append(dlg); dlg.showModal();
}

// ---------- Edit timeline ----------
editBtn.onclick = () => openEditor();
const shotNo = (id: string) => String(project.shots.findIndex(s => s.id === id) + 1).padStart(2, '0');
function clipsOf(p = project): EditClip[] { return p.edit?.clips?.length ? p.edit.clips : p.shots.map(s => ({ id: s.id, shotId: s.id, assetId: null, in: 0, out: null })); }
function clipMedia(c: EditClip): Asset | null {
  const list = (project.assets || []).filter(a => a.shotId === c.shotId && a.mime?.startsWith('video/'));
  if (c.assetId) return list.find(a => a.id === c.assetId) || null;
  const newest = (k: string) => list.filter(a => a.kind === k).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return newest('workflow-result') || newest('camera-render') || null;
}
const assetLabel = (a: Asset) => a.kind === 'workflow-result' ? `Result · ${(a.source.workflow || 'workflow').split(' ·')[0]}` : `Camera render v${a.version ?? 1}`;
function openEditor() {
  document.getElementById('editor-dialog')?.remove();
  let clips = structuredClone(clipsOf()), sel = 0, playing = false, idx = 0;
  const video = h('video', { playsinline: true, muted: true, preload: 'auto' });
  const empty = h('div', { class: 'ed-empty' });
  const status = h('div', { class: 'status-line' });
  const timecode = h('span', { class: 'mono muted' });
  const track = h('div', { class: 'ed-track', role: 'listbox', 'aria-label': 'Timeline' });
  const panel = h('div', { class: 'ed-panel' });
  const exportBtn = h('button', { class: 'btn camera', type: 'button' }, 'Export video');
  const playBtn2 = h('button', { class: 'btn', type: 'button' }, '▶ Play cut');
  const len = (c: EditClip) => { const a = clipMedia(c); return a?.duration ? Math.max(0, (c.out ?? a.duration) - (c.in || 0)) : 0; };
  const total = () => clips.reduce((t, c) => t + len(c), 0);
  const save = async () => {
    const before = structuredClone(clipsOf());
    await runEntry({ label: 'Edit timeline', redo: [{ op: 'set_edit', clips }], undo: [{ op: 'set_edit', clips: before }] });
    clips = structuredClone(clipsOf()); draw();
  };
  const show = (i: number, t = 0) => {
    const c = clips[i], a = c && clipMedia(c);
    if (!a) { video.removeAttribute('src'); video.hidden = true; empty.hidden = false; empty.textContent = c ? `Shot ${shotNo(c.shotId)} isn't rendered yet. Use Render shot on it first.` : 'The timeline is empty.'; return false; }
    video.hidden = false; empty.hidden = true;
    const url = assetUrl(a);
    if (!video.src.endsWith(url)) video.src = url;
    video.currentTime = (c.in || 0) + t; return true;
  };
  const playFrom = (i: number) => {
    idx = i;
    while (idx < clips.length && !clipMedia(clips[idx])) idx++;
    if (idx >= clips.length) { playing = false; playBtn2.textContent = '▶ Play cut'; return; }
    sel = idx; draw(false); show(idx); void video.play();
  };
  video.ontimeupdate = () => {
    const c = clips[idx], a = c && clipMedia(c);
    let before = 0; for (let i = 0; i < idx; i++) before += len(clips[i]);
    timecode.textContent = `${(before + Math.max(0, video.currentTime - (c?.in || 0))).toFixed(2)}s / ${total().toFixed(2)}s`;
    if (playing && a && video.currentTime >= (c.out ?? a.duration ?? 0) - 0.02) playFrom(idx + 1);
  };
  video.onended = () => { if (playing) playFrom(idx + 1); };
  playBtn2.onclick = () => { if (playing) { playing = false; video.pause(); playBtn2.textContent = '▶ Play cut'; return; } playing = true; playBtn2.textContent = '❚❚ Pause'; playFrom(sel); };
  let dragFrom = -1;
  function draw(refreshPreview = true) {
    const tot = Math.max(1, total());
    track.replaceChildren(...clips.map((c, i) => {
      const a = clipMedia(c), shot = project.shots.find(s => s.id === c.shotId);
      const thumb = h('canvas', { width: 160, height: 90 });
      if (shot) requestAnimationFrame(() => { try { thumb.getContext('2d')!.drawImage(scene.thumbnail(shot, 160, 90), 0, 0); } catch {} });
      const block = h('div', { class: 'ed-clip' + (i === sel ? ' on' : '') + (a ? '' : ' missing'), role: 'option', 'aria-selected': String(i === sel), draggable: true, tabindex: 0, style: `width:${Math.round(Math.max(1.2, len(c) || 1.5) * 64)}px;`, title: 'Drag to reorder' },
        thumb, h('div', { class: 'ed-meta' }, h('strong', {}, `${shotNo(c.shotId)} ${shot?.title || 'Removed shot'}`), h('span', {}, a ? `${assetLabel(a)} · ${len(c).toFixed(2)}s` : 'Not rendered')));
      block.onclick = () => { sel = i; draw(); };
      block.ondragstart = ev => { dragFrom = i; ev.dataTransfer?.setData('text/plain', String(i)); };
      block.ondragover = ev => ev.preventDefault();
      block.ondrop = ev => { ev.preventDefault(); if (dragFrom < 0 || dragFrom === i) return; const [m] = clips.splice(dragFrom, 1); clips.splice(i, 0, m); sel = i; dragFrom = -1; void save(); };
      return block;
    }), h('div', { class: 'ed-total mono' }, `${clips.length} clip${clips.length === 1 ? '' : 's'} · ${total().toFixed(2)}s`));
    track.style.setProperty('--total', String(tot));
    const c = clips[sel];
    panel.replaceChildren();
    if (c) {
      const shot = project.shots.find(s => s.id === c.shotId), a = clipMedia(c);
      const options = (project.assets || []).filter(x => x.shotId === c.shotId && x.mime?.startsWith('video/')).sort((x, y) => y.createdAt.localeCompare(x.createdAt));
      const src = h('select', { class: 'field', 'aria-label': 'Clip source' }, h('option', { value: '' }, 'Newest (result, else camera render)'), ...options.map(o => h('option', { value: o.id, selected: o.id === c.assetId }, `${assetLabel(o)} · ${o.duration != null ? Number(o.duration).toFixed(2) : '—'}s · ${new Date(o.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`)));
      src.onchange = () => { c.assetId = src.value || null; c.in = 0; c.out = null; void save(); };
      const dur = a?.duration || 0;
      const inF = numberField('In', c.in || 0, { rate: 0.01, snapTo: 1 / 24, min: 0, max: dur, unit: 's', onPreview: v => { c.in = v; show(sel); }, onCommit: v => { c.in = v; void save(); } });
      const outF = numberField('Out', c.out ?? dur, { rate: 0.01, snapTo: 1 / 24, min: 0, max: dur, unit: 's', onPreview: v => { c.out = v; show(sel, Math.max(0, v - (c.in || 0) - 0.04)); }, onCommit: v => { c.out = v; void save(); } });
      panel.append(
        h('div', { class: 'ed-row' }, h('strong', {}, `Clip ${sel + 1} · Shot ${shotNo(c.shotId)} ${shot?.title || ''}`), h('span', { style: 'flex:1' }),
          h('button', { class: 'btn sm', type: 'button', disabled: sel === 0, onclick: () => { [clips[sel - 1], clips[sel]] = [clips[sel], clips[sel - 1]]; sel--; void save(); } }, '← Move'),
          h('button', { class: 'btn sm', type: 'button', disabled: sel === clips.length - 1, onclick: () => { [clips[sel + 1], clips[sel]] = [clips[sel], clips[sel + 1]]; sel++; void save(); } }, 'Move →'),
          h('button', { class: 'btn sm', type: 'button', onclick: () => { clips.splice(sel + 1, 0, { ...structuredClone(c), id: crypto.randomUUID() }); sel++; void save(); } }, 'Duplicate'),
          h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { clips.splice(sel, 1); sel = Math.max(0, sel - 1); void save(); } }, 'Remove')),
        h('div', { class: 'ed-row' }, h('label', { class: 'ed-src' }, 'Source', src), a ? h('div', { class: 'xyz', style: 'grid-template-columns: repeat(2, 120px)' }, inF, outF) : h('button', { class: 'btn sm camera', type: 'button', onclick: () => { dlg.close(); selectShot(c.shotId); openRender(); } }, 'Render this shot →')));
    }
    const addSel = h('select', { class: 'field', 'aria-label': 'Add a shot to the timeline' }, h('option', { value: '' }, '+ Add shot…'), ...project.shots.map((s, i) => h('option', { value: s.id }, `${String(i + 1).padStart(2, '0')} ${s.title}`)));
    addSel.onchange = () => { if (!addSel.value) return; clips.push({ id: crypto.randomUUID(), shotId: addSel.value, assetId: null, in: 0, out: null }); sel = clips.length - 1; void save(); };
    panel.append(h('div', { class: 'ed-row' }, addSel, h('button', { class: 'btn sm ghost', type: 'button', title: 'Every shot, in shot order, newest versions', onclick: () => { clips = project.shots.map(s => ({ id: crypto.randomUUID(), shotId: s.id, assetId: null, in: 0, out: null })); sel = 0; void save(); } }, 'Reset to all shots')));
    exportBtn.disabled = !clips.length;
    if (refreshPreview && !playing) show(sel);
  }
  exportBtn.onclick = async () => {
    exportBtn.disabled = true; status.className = 'status-line'; status.textContent = 'Exporting with FFmpeg…';
    try {
      const r = await api('director/edit-export', { projectId });
      apply(r.project);
      status.innerHTML = '';
      status.append(`Exported ${Number(r.asset.duration).toFixed(2)}s · ${r.asset.frameCount} frames · ${r.asset.width}×${r.asset.height}. Saved in Assets. `, h('a', { href: `/director-assets/${project.id}/${r.asset.file.replace(/^assets\//, '')}`, download: `${project.title}-edit-v${r.asset.version}.mp4` }, 'Download'));
    } catch (e) { status.className = 'status-line err'; status.textContent = (e as Error).message; }
    finally { exportBtn.disabled = false; }
  };
  const dlg = h('dialog', { class: 'editor', id: 'editor-dialog', 'aria-labelledby': 'editor-title' },
    h('div', { class: 'dialog-head' }, h('h2', { id: 'editor-title' }, `Edit · ${project.title}`), timecode, playBtn2, exportBtn, h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'ed-body' }, h('div', { class: 'ed-preview' }, video, empty), track, panel, status,
      h('p', { class: 'note', style: 'margin:0' }, 'Each clip uses its shot\'s newest workflow result, else its newest camera render, unless you pick a version. Export conforms every clip to 1280×720 at 24 fps and joins them in order.')));
  dlg.addEventListener('close', () => { video.pause(); dlg.remove(); });
  document.body.append(dlg); dlg.showModal(); draw();
}

// ---------- Object looks & generation ----------
let looksBoard: { refresh(): void } | null = null;
function openLooks() {
  looksBoard = openLooksBoard({ project: () => project, edit: ops => edit(ops), refgen: () => refgen as any, reloadRefgen: () => loadRefgen(), openObject: id => { setMode('scene'); select(id); setTab('object'); } });
}
looksBtn.onclick = () => openLooks();
async function loadRefgen() {
  try {
    refgen = await api(`director/refgen?projectId=${projectId}`);
    // BFL image models only for now (FLUX 3 first).
    refgen.presets = refgen.presets.filter(p => /^flux/.test(p.id)).sort((a, b) => (a.id === 'flux-3' ? -1 : b.id === 'flux-3' ? 1 : 0));
    renderObjectPane(); shotPane.dataset.shot = ''; renderShotPane(); } catch (e) { toast((e as Error).message, true); }
}
function lookCard(e: Entity, r: Reference) {
  const primary = e.look === r.id;
  return h('div', { class: 'ref' + (primary ? ' primary' : '') },
    h('img', { src: refUrl(r), alt: r.name, loading: 'lazy', title: r.generated ? `${r.generated.model} · seed ${r.generated.seed}\n${r.generated.prompt}` : r.name }),
    h('div', { class: 'ref-body' },
      h('div', { class: 'ref-name' }, h('span', { title: r.name }, r.name), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': `Remove look ${r.name}`, title: 'Remove look (file is kept)', onclick: () => void edit([{ op: 'remove_reference', referenceId: r.id }]) }, '✕')),
      h('span', { class: 'link' + (r.generated ? '' : ' none') }, r.generated ? `✦ ${r.generated.model.split(' (')[0]}` : 'Uploaded'),
      h('button', { class: 'btn sm' + (primary ? ' camera' : ''), type: 'button', disabled: primary, onclick: () => void edit([{ op: 'set_look', entityId: e.id, referenceId: r.id }]) }, primary ? '★ Primary look' : 'Make primary')));
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
        onclick: () => { if (open) selection.clear(); else { selection.set([id], id); if (scene.view() === 'set') scene.frame([id], 1.2); setTab('object'); } } },
        box,
        look ? h('img', { class: 'cast-thumb', src: refUrl(look), alt: '' }) : h('span', { class: 'cast-ph' }, shapeIcon(r.entity.shape)),
        h('div', { class: 'cast-main' },
          h('span', { class: 'cast-name' }, r.entity.name),
          h('span', { class: 'cast-why' }, why, looks.length ? ` · ${looks.length} image${looks.length === 1 ? '' : 's'}` : '', card.sharedFrom ? ` · shares ${entity(card.sharedFrom)?.name}` : ''),
          !open && r.inCast && card.description ? h('span', { class: 'cast-desc' }, card.description) : null),
        h('span', { class: 'cast-chev', 'aria-hidden': 'true' }, '›')),
      open ? h('div', { class: 'cast-slot', 'data-cast-slot': id }) : null);
  };
  return h('div', { class: 'block' },
    h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, `In this shot · ${featured.length}`), h('span', { class: 'muted', style: 'font-size:11.5px' }, 'Open an object to edit its Cast Card and images')),
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
  if (!e) { objectPane.replaceChildren(h('div', { class: 'empty-state', style: 'margin:8px' }, 'Select an object to design its look. ', h('button', { class: 'btn sm', type: 'button', onclick: () => openLooks() }, 'Open Looks board'))); return; }
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
  const upload = h('label', { class: 'ob-add', title: `Upload looks for ${e.name}` }, h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true, onchange: (ev: Event) => void uploadRefs(Array.from((ev.target as HTMLInputElement).files || []), e.id, false) }), '＋', h('small', {}, 'Upload'));
  dropTarget(upload, files => uploadRefs(files, e.id, false));
  const hero = h('div', { class: 'ob-hero' + (primary ? '' : ' empty') },
    primary ? h('img', { src: refUrl(primary), alt: `${e.name} look`, title: primary.generated ? `${primary.generated.model} · seed ${primary.generated.seed}\n${primary.generated.prompt}` : primary.name }) : h('div', { class: 'ob-ph' }, shapeIcon(e.shape), h('span', {}, 'No look yet — generate one below or drop an image here')),
    primary ? h('span', { class: 'ob-badge' }, '★ Primary · ', primary.generated ? primary.generated.model.split(' (')[0] : 'uploaded') : null);
  dropTarget(hero, files => uploadRefs(files, e.id, false));
  const strip = h('div', { class: 'ob-strip' }, ...looks.map(r => h('div', { class: 'ob-thumb' + (r.id === e.look ? ' on' : ''), title: r.id === e.look ? 'Primary look' : 'Make primary' },
    h('button', { type: 'button', class: 'ob-thumb-img', 'aria-label': r.id === e.look ? `${r.name} (primary)` : `Make ${r.name} primary`, onclick: () => void edit([{ op: 'set_look', entityId: e.id, referenceId: r.id }]) }, h('img', { src: refUrl(r), alt: '', loading: 'lazy' })),
    h('button', { type: 'button', class: 'ob-x', 'aria-label': `Remove look ${r.name}`, title: 'Remove look (file is kept)', onclick: () => void edit([{ op: 'remove_reference', referenceId: r.id }]) }, '✕'))), upload);
  // Share another object's look and description (e.g. every police car uses Police 1).
  const others = project.scene.entities.filter(x => x.id !== e.id && lookSource(project, x.id)?.id !== e.id).sort((a, b) => (b.kind === e.kind ? 1 : 0) - (a.kind === e.kind ? 1 : 0) || a.name.localeCompare(b.name));
  const shareSel = h('select', { class: 'field', 'aria-label': 'Look' }, h('option', { value: '' }, 'Its own look'), ...others.map(x => h('option', { value: x.id, selected: e.lookFrom === x.id }, `Same as ${x.name}${objectLooks(project, x.id).length ? '' : ' (no look yet)'}`)));
  shareSel.onchange = () => { const before = e.lookFrom || null, after = shareSel.value || null; void runEntry({ label: after ? 'Share look' : 'Own look', redo: [{ op: 'update_entity', id: e.id, patch: { lookFrom: after } }], undo: [{ op: 'update_entity', id: e.id, patch: { lookFrom: before } }] }).then(rerender); };
  const sameKind = project.scene.entities.filter(x => x.id !== e.id && x.kind === e.kind && x.shape === e.shape && !x.lookFrom && !objectLooks(project, x.id).length && (x.lookFrom !== e.id));
  const shareAll = !shared && looks.length && sameKind.length ? h('button', { class: 'btn sm', type: 'button', title: sameKind.map(x => x.name).join(', '), onclick: () => void runEntry({ label: 'Share look', redo: sameKind.map(x => ({ op: 'update_entity', id: x.id, patch: { lookFrom: e.id } })), undo: sameKind.map(x => ({ op: 'update_entity', id: x.id, patch: { lookFrom: null } })) }).then(() => toast(`${sameKind.length} object${sameKind.length === 1 ? '' : 's'} now use ${e.name}’s look`)) }, `Use for ${sameKind.length} similar ${e.shape}${sameKind.length === 1 ? '' : 's'} without a look`) : null;
  const usedBy = project.scene.entities.filter(x => x.lookFrom === e.id);
  objectPane.replaceChildren(...([
    inspector,
    h('div', { class: 'block object-visual' },
      h('div', { class: 'block-head' }, h('strong', { style: 'flex:1' }, 'Visual reference'), h('button', { class: 'btn primary sm', type: 'button', onclick: () => { if (shared) { select(shared.id); return; } const form = objectPane.querySelector<HTMLDetailsElement>('.object-generate'); if (form) { form.open = true; form.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); form.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true }); } } }, shared ? 'Edit shared image…' : 'Generate image…')),
      h('div', { class: 'ob-shots' }, ...(inShots.length ? [h('span', { class: 'muted' }, 'In shot'), ...inShots.map(x => h('button', { type: 'button', class: 'chip', title: x.s.title, onclick: () => selectShot(x.s.id) }, String(x.i + 1).padStart(2, '0')))] : [h('span', { class: 'muted' }, 'No shot camera sees this object yet.')])),
      hero, shared ? null : strip,
      h('details', { class: 'object-reference-options' }, h('summary', {}, 'Reference sharing & project images'), h('label', { class: 'ob-share' }, h('span', { class: 'muted' }, 'Look'), shareSel), shared ? null : linkPicker(e), shareAll),
      shared ? h('p', { class: 'note', style: 'margin:0' }, `Uses ${shared.name}’s looks and description. Change them on `, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => select(shared.id) }, shared.name), '.') : null,
      usedBy.length ? h('p', { class: 'note', style: 'margin:0' }, `Shared with ${usedBy.map(x => x.name).join(', ')}.`) : null,
      h('p', { class: 'note', style: 'margin:0' }, 'Associated with ', h('strong', {}, e.name), '. The primary image is offered as a reference when this object is in a shot; workflow limits still apply.')),
    h('div', { class: 'block cast-card' },
      h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, 'Appearance')),
      h('label', { class: 'cc-field' }, h('span', {}, shared ? 'Description · extra notes for this one' : 'Description'), shared ? h('p', { class: 'note', style: 'margin:0' }, `From ${shared.name}’s Cast Card: ${shared.notes || '—'}`) : null, notes),
      h('label', { class: 'cc-field' }, h('span', {}, 'Style notes'), styleNotes),
      h('div', { class: 'ob-style' }, h('span', { class: 'muted' }, 'Project style: '), styleText ? h('span', {}, styleText) : h('span', { class: 'muted' }, 'not set'), h('button', { class: 'btn ghost sm', type: 'button', onclick: () => openLooks() }, styleText ? 'Edit' : 'Set style')),
      h('p', { class: 'note', style: 'margin:0' }, 'Description and style go into this object’s looks and into every shot it appears in. Its primary look is sent with those shots’ videos.')),
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
    h('div', { class: 'facts' }, 'Model', h('b', {}, job.model), 'Backend', h('b', {}, job.backend.kind === 'cloud' ? 'Comfy Cloud' : job.backend.url), 'Images', h('b', {}, `${job.count} · ${job.aspect} · seed ${job.seed}`), 'Cost', h('b', { style: `color:${free ? 'var(--ok)' : 'var(--warn)'}` }, job.quote.label), 'Quote', h('b', {}, job.fingerprint.slice(0, 12))),
    h('label', { style: 'display:flex;gap:8px;align-items:center' }, approve, 'I approve this exact request'),
    free ? null : h('label', { style: 'display:flex;gap:8px;align-items:center' }, unknown, 'I accept the Cloud total is unknown, up to', max, 'USD'),
    h('div', { style: 'display:flex;gap:8px;align-items:center' }, go, blocked ? h('span', { class: 'note' }, 'Paid generation is off on this server (PREVIS_ALLOW_PAID≠1). Nothing will be sent.') : null),
    status);
}
function jobRow(job: any) {
  const color = job.status === 'completed' ? 'var(--ok)' : job.status === 'failed' || job.status === 'uncertain' || job.status === 'invalidated' ? 'var(--bad)' : 'var(--warn)';
  return h('div', { style: 'display:flex;flex-direction:column;gap:2px;font-size:12px;border-top:1px solid var(--line);padding-top:6px' },
    h('div', { style: 'display:flex;gap:8px' }, h('b', { style: `color:${color};font-weight:600` }, job.status), h('span', { class: 'muted', style: 'flex:1' }, `${job.model.split(' (')[0]} · ${job.count} img`), job.status === 'submitted' ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => void trackJob(job.id) }, 'Check') : null),
    h('span', { class: 'note' }, job.message));
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
function setTab(t: 'direct' | 'shot' | 'object') {
  tab = t; shotTab.classList.add('on');
  directPane.hidden = true; shotPane.hidden = false;
  if (t === 'object') { if (collapsed.side) setCollapsed('side', false); renderObjectPane(); void loadRefgen(); placeObjectPane(true); }
}
const colorOf = (id: string | null) => (id ? objectColors(project, shot()).get(id) ?? null : null);
/** Put the selected object's editor inside its cast row (or at the top when it isn't in the cast). */
function placeObjectPane(scroll = false) {
  if (!selected) { objectPane.remove(); highlightPrompt(null); return; }
  objectPane.hidden = false;
  const slot = shotPane.querySelector(`[data-cast-slot="${selected}"]`);
  if (slot) { if (objectPane.parentElement !== slot) slot.append(objectPane); }
  else { objectPane.classList.add('loose'); const after = shotPane.firstElementChild; if (objectPane.previousElementSibling !== after) after ? after.after(objectPane) : shotPane.prepend(objectPane); }
  if (slot) objectPane.classList.remove('loose');
  highlightPrompt(selected);
  if (scroll) requestAnimationFrame(() => (slot?.closest('.cast-row') || objectPane).scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}
/** Light up an object's words in the prompt (and its chip); everything else steps back. */
function highlightPrompt(id: string | null) {
  shotPane.classList.toggle('hl-on', !!id && !!shotPane.querySelector(`[data-ids~="${id}"]`));
  shotPane.querySelectorAll<HTMLElement>('[data-ids]').forEach(el => el.classList.toggle('hl', !!id && el.dataset.ids!.split(' ').includes(id)));
}
function setView(v: 'set' | 'camera') {
  scene.setView(v); setBtn.classList.toggle('on', v === 'set'); camBtn.classList.toggle('on', v === 'camera');
  viewport.classList.toggle('camview', v === 'camera');
}
async function addShot() {
  const s = shot();
  const r = await edit([{ op: 'add_shot', index: project.shots.indexOf(s) + 1, shot: { duration: s.duration, camera: { ...s.camera, keys: s.camera.move === 'custom' ? s.camera.keys : null } } }]);
  selectShot(r.results[0].id); setTab('shot');
}
async function addObject(shape: string) {
  addMenu.hidden = true; addPopup.hidden = true;
  const t = scene.orbitTarget(), id = crypto.randomUUID();
  // Blockout assets land at the orbit target on the ground, like Otter.
  const ok = await runEntry({ label: `Add ${shape}`, redo: [{ op: 'add_entity', entity: { id, name: shape[0].toUpperCase() + shape.slice(1), shape, position: [snap(t[0], 0.1), 0, snap(t[2], 0.1)] } }], undo: [{ op: 'remove_entity', id }] });
  if (ok) selection.set([id], id);
}
function workflowUrl(previsShotId: string, assetId: string, prompt: string) {
  return `/generation.html?shot=${previsShotId}&asset=${assetId}&prompt=${encodeURIComponent(prompt)}`;
}

async function uploadRefs(files: File[], entityId: string | null, toComposer: boolean) {
  const images = files.filter(f => /^image\/(png|jpeg|webp)$/.test(f.type));
  if (!images.length) { toast('Drop PNG, JPEG or WebP images', true); return; }
  for (const f of images) {
    if (f.size > 10 * 1024 * 1024) { toast(`${f.name} is over 10 MB`, true); continue; }
    try {
      const r = await api('director/reference', { projectId, shotId, name: f.name, data: await readFileBase64(f), entityId, ...(entityId && !toComposer ? { scope: 'object' } : {}) });
      apply(r.project);
      if (toComposer) pendingAtts.push(r.referenceId);
      if (entityId) toast(`${f.name} added as a look for ${entity(entityId)?.name}`);
    } catch (e) { toast((e as Error).message, true); }
  }
  renderAtts();
}
function renderAtts() {
  const refs = shot().references;
  pendingAtts = pendingAtts.filter(id => refs.some(r => r.id === id));
  attsRow.replaceChildren(...pendingAtts.map(id => { const r = refs.find(x => x.id === id)!; return h('figure', {}, h('img', { src: refUrl(r), alt: r.name, title: r.name }), h('button', { type: 'button', 'aria-label': `Detach ${r.name}`, onclick: () => { pendingAtts = pendingAtts.filter(x => x !== id); renderAtts(); } }, '×')); }));
  attsRow.hidden = !pendingAtts.length;
}

async function send() {
  const text = textarea.value.trim();
  if (!text && !pendingAtts.length) return;
  sendBtn.disabled = true;
  try {
    const r = await api('director/message', { projectId, shotId, text, attachments: pendingAtts, mode });
    textarea.value = ''; pendingAtts = []; renderAtts(); suggest.hidden = true;
    apply(r.project);
  } catch (e) { toast((e as Error).message, true); }
  finally { sendBtn.disabled = false; textarea.focus(); }
}

function dropTarget(el: HTMLElement, onFiles: (files: File[]) => void, onState?: (on: boolean) => void) {
  let depth = 0;
  el.addEventListener('dragenter', ev => { if (!ev.dataTransfer?.types.includes('Files')) return; ev.preventDefault(); depth++; el.classList.add('drag'); onState?.(true); });
  el.addEventListener('dragover', ev => { if (ev.dataTransfer?.types.includes('Files')) ev.preventDefault(); });
  el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.classList.remove('drag'); onState?.(false); } });
  el.addEventListener('drop', ev => { ev.preventDefault(); depth = 0; el.classList.remove('drag'); onState?.(false); onFiles(Array.from(ev.dataTransfer?.files || [])); });
}

// ---------- @mentions ----------
let suggestIndex = 0;
function mentionQuery() {
  const before = textarea.value.slice(0, textarea.selectionStart);
  return before.match(/@([a-z0-9-]*)$/i)?.[1] ?? null;
}
function updateSuggest() {
  const q = mentionQuery();
  if (q === null) { suggest.hidden = true; return; }
  const list = project.scene.entities.filter(e => handleOf(e.name).includes(q.toLowerCase()) || e.name.toLowerCase().includes(q.toLowerCase())).slice(0, 7);
  if (!list.length) { suggest.hidden = true; return; }
  suggestIndex = Math.min(suggestIndex, list.length - 1);
  suggest.replaceChildren(...list.map((e, i) => h('button', { type: 'button', class: i === suggestIndex ? 'on' : '', onmousedown: (ev: Event) => { ev.preventDefault(); insertMention(e); } }, h('span', { class: 'sw', style: `width:9px;height:9px;border-radius:3px;background:${e.color}` }), e.name, h('span', { class: 'k' }, e.kind))));
  suggest.hidden = false;
  (suggest as any)._list = list;
}
function insertMention(e: Entity) {
  const q = mentionQuery(); if (q === null) return;
  const start = textarea.selectionStart - q.length - 1;
  textarea.setRangeText('@' + handleOf(e.name) + ' ', start, textarea.selectionStart, 'end');
  suggest.hidden = true; textarea.focus();
}
textarea.addEventListener('input', () => { suggestIndex = 0; updateSuggest(); });
textarea.addEventListener('keydown', ev => {
  const list: Entity[] = (suggest as any)._list || [];
  if (!suggest.hidden && list.length) {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); suggestIndex = (suggestIndex + (ev.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length; updateSuggest(); return; }
    if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); insertMention(list[suggestIndex]); return; }
    if (ev.key === 'Escape') { suggest.hidden = true; return; }
  }
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void send(); }
});
textarea.addEventListener('paste', ev => {
  const files = Array.from(ev.clipboardData?.files || []).filter(f => f.type.startsWith('image/'));
  if (files.length) { ev.preventDefault(); void uploadRefs(files, null, true); }
});
sendBtn.onclick = () => void send();
routeSel.onchange = () => { mode = routeSel.value as typeof mode; renderRoute(); };
fileInput.onchange = () => { void uploadRefs(Array.from(fileInput.files || []), null, true); fileInput.value = ''; };
dropTarget(composer, files => uploadRefs(files, null, true));
dropTarget(thread, files => uploadRefs(files, null, true));

// Drop an image straight onto an object in the viewport to link it.
viewport.addEventListener('dragover', ev => { if (ev.dataTransfer?.types.includes('Files')) { ev.preventDefault(); dropHint.hidden = false; const id = scene.pick(ev.clientX, ev.clientY); dropHint.textContent = id ? `Add as a look for ${entity(id)?.name}` : 'Drop on an object to link it — or anywhere to add a shot reference'; } });
viewport.addEventListener('dragleave', ev => { if (!viewport.contains(ev.relatedTarget as Node)) dropHint.hidden = true; });
viewport.addEventListener('drop', ev => { ev.preventDefault(); dropHint.hidden = true; const id = scene.pick(ev.clientX, ev.clientY); void uploadRefs(Array.from(ev.dataTransfer?.files || []), id, false).then(() => { if (id) select(id); }); });

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
previewBtn.onclick = () => { setView('camera'); playhead = 0; togglePlay(true); };
scrub.oninput = () => { playhead = Number(scrub.value); playing = false; scene.setPlayhead(playhead); renderTransport(); renderInspector(); };
monitor.onclick = () => setView('camera');
monitor.onkeydown = ev => { if (ev.key === 'Enter') setView('camera'); };
titleInput.onchange = () => void edit([{ op: 'set_project', patch: { title: titleInput.value } }]);
directTab.onkeydown = shotTab.onkeydown = null;

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
  keyTrack.replaceChildren(...times.filter(t => t >= start - KEY_EPS && t <= start + s.duration + KEY_EPS).map(t => {
    const on = Math.abs(start + playhead - t) <= KEY_EPS;
    return h('button', { class: 'kf' + (on ? ' on' : ''), type: 'button', title: `Keyframe @ ${t.toFixed(2)}s (scene) · click to jump`, style: `left:calc(8px + (100% - 16px) * ${s.duration ? (t - start) / s.duration : 0})`, onclick: () => { playing = false; playhead = Math.max(0, Math.min(s.duration, t - start)); scene.setPlayhead(playhead); renderTransport(); renderInspector(); } });
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
function renderHelp() {
  const grid = h('input', { type: 'checkbox', checked: gridVisible }); grid.onchange = () => { gridVisible = grid.checked; localStorage.setItem('previs.grid.v2', gridVisible ? '1' : '0'); scene.setGridVisible(gridVisible); };
  const snapBox = h('input', { type: 'checkbox', checked: snapPref }); snapBox.onchange = () => setSnap(snapBox.checked);
  helpCard.replaceChildren(
    h('div', { class: 'help-head' }, h('strong', {}, 'Controls'), h('span', { class: 'muted' }, 'Viewport and shortcuts'), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close', onclick: () => { helpCard.hidden = true; } }, '✕')),
    h('div', { class: 'help-cols' }, ...HELP.map(([title, rows]) => h('section', {}, h('strong', {}, title), ...rows.map(([a, b]) => h('div', { class: 'help-row' }, h('span', {}, a), h('kbd', {}, b)))))),
    h('section', { class: 'help-settings' }, h('strong', {}, 'Viewport'), h('label', {}, h('span', {}, 'Show grid'), grid), h('label', {}, h('span', {}, 'Snap movement to grid'), snapBox), h('div', { class: 'help-row' }, h('span', {}, 'Grid step'), h('kbd', {}, `${scene.gridStep()} m`))));
}
const helpBtn = h('button', { class: 'btn sm help-toggle', type: 'button', 'aria-label': 'Show viewport controls', title: 'Controls and shortcuts (?)', onclick: () => { renderHelp(); helpCard.hidden = !helpCard.hidden; } }, '?');
const undoBtn = h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Undo', onclick: () => void undo() }, '↶');
const redoBtn = h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Redo', onclick: () => void redo() }, '↷');
viewport.querySelector('.vp-tools')!.append(helpBtn);
// [director-phone] pair a phone and preview its aim in the shot camera (live only, not recorded).
{ const slot = h('span', { class: 'phone-slot' }); moveChip.before(slot); installPhoneDemo(slot, scene, () => setView('camera')); }
assetsBtn.before(undoBtn, redoBtn);
assetsBtn.after(editBtn);
setTransformMode('translate'); setSnap(snapPref); scene.setGridVisible(gridVisible); renderUndo();

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
  if (ev.key === 'Escape') { if (!addPopup.hidden) addPopup.hidden = true; else if (!helpCard.hidden) helpCard.hidden = true; else if (scene.view() === 'camera') setView('set'); return; }
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
async function captureShotVideo(s: Shot, o: { width: number; height: number; prompt: string; onFrame?: (url: string, i: number, n: number) => void; onStatus?: (t: string) => void }) {
  if (shotId !== s.id) selectShot(s.id);
  const idx = project.shots.indexOf(s), { width, height } = o;
  const n = Math.min(120, Math.max(2, Math.round(s.duration * 24))), at = (i: number) => i / 24;
  const motion = Array.from({ length: n }, (_, i) => { const p = scene.pose(at(i)); return { t: i / 24, p: p.p, q: scene.quaternionAt(at(i)), mm: Math.round(p.mm * 1000) / 1000 }; });
  o.onStatus?.('Saving camera motion…');
  const main = await api('project');
  const target = entity(s.camera.target);
  const sig = signature(project, s);
  const saved = await api('browser-shot', {
    revision: main.project.revision, title: `${project.title} · Shot ${idx + 1} · ${s.title}`.slice(0, 160), camera: motion[0], subject: target ? focusPoint(target) : [0, 1, 0], frames: motion,
    png: scene.capture(at(0), 640, 360).split(',')[1], delivery: { width, height, fps: 24 },
    director: { projectId: project.id, shotId: s.id, projectRevision: project.revision, sceneName: project.scene.name, shotTitle: s.title, camera: s.camera, entities: project.scene.entities },
  });
  const previsShot = saved.project.shots.filter((x: any) => x.browser?.director?.shotId === s.id).at(-1);
  const { stage } = await api('video/browser/start', { revision: saved.project.revision, shotId: previsShot.id, width, height, fps: 24, frameCount: n });
  let stageId: string | null = stage.id;
  try {
    for (let i = 0; i < n; i++) {
      const url = scene.capture(at(i), width, height);
      await api('video/browser/frame', { stageId, index: i, png: url.split(',')[1] });
      o.onFrame?.(url, i, n);
    }
    o.onStatus?.('Encoding…');
    const { asset } = await api('video/browser/finish', { stageId }); stageId = null;
    const r = await api('director/render', { projectId, shotId: s.id, previsShotId: previsShot.id, assetId: asset.id, prompt: o.prompt, signature: sig });
    apply(r.project);
    return { asset, previsShotId: previsShot.id as string, project: r.project as DirectorProject };
  } finally { if (stageId) await api('video/browser/abort', { stageId }).catch(() => {}); }
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
  const showFacts = () => facts.replaceChildren('Frames', h('b', {}, `${frames()} @ 24 fps`), 'Duration', h('b', {}, `${(frames() / 24).toFixed(3)}s (shot ${s.duration}s)`), 'Size', h('b', {}, `${width}×${height} · 16:9`), 'Pass', h('b', {}, 'beauty (Three.js blockout)'));
  showFacts();
  const res = h('div', { class: 'radio-row' },
    ...[[1280, 720], [640, 360]].map(([w, hh]) => { const input = h('input', { type: 'radio', name: 'res', checked: w === 1280 }); input.onchange = () => { width = w; height = hh; showFacts(); }; return h('label', {}, input, `${w}×${hh}`); }));
  const bar = h('i'); const progress = h('div', { class: 'progress', hidden: true }, bar);
  const status = h('div', { class: 'status-line' });
  const capture = h('button', { class: 'btn camera', type: 'button' }, `Capture camera video`);
  const prompt = h('textarea', { class: 'field', rows: 5, 'aria-label': 'Render prompt' }, shotPrompt(project, s, 'video'));
  const open = h('a', { class: 'btn ghost sm', target: '_blank', 'aria-disabled': 'true', style: 'pointer-events:none;opacity:.45', title: 'Full workflow page: import graphs, map inputs, compare and review' }, 'Advanced workflow page ↗');
  const step1 = h('div', { class: 'step active' }, h('span', { class: 'n' }, '1'), h('div', {}, h('h3', {}, 'Camera video'), h('p', {}, 'Renders every frame through the shot camera at a fixed 24 fps — the exact source the workflow receives.'), res, h('div', { style: 'height:8px' }), facts, h('div', { style: 'height:10px' }), capture, h('div', { style: 'height:8px' }), progress, status));
  const refs = [...project.scene.entities.map(e => objectLooks(project, e.id)[0]).filter(Boolean) as Reference[], ...s.references];
  const step2 = h('div', { class: 'step' }, h('span', { class: 'n' }, '2'), h('div', {}, h('h3', {}, 'Prompt & references'), h('p', {}, 'Compiled from the shot description, camera and linked references. Edit freely.'), prompt,
    refs.length ? h('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-top:8px' }, ...refs.map(r => h('div', { style: 'display:flex;gap:8px;align-items:center;font-size:12px' }, h('img', { src: refUrl(r), alt: '', style: 'width:34px;height:34px;object-fit:cover;border-radius:6px' }), h('span', { style: 'flex:1' }, r.name), h('span', { class: entity(r.entityId) ? '' : 'muted' }, entity(r.entityId) ? `→ ${entity(r.entityId)!.name} · ${r.role}` : r.role === 'style' ? 'style' : 'not linked')))) : h('p', { class: 'note', style: 'margin-top:8px' }, 'No references on this shot.'),
    h('p', { class: 'note', style: 'margin-top:8px' }, 'Reference images are named in the prompt. Workflows with image inputs are mapped on the workflow page.')));
  const gen = h('div', { class: 'gen-box' }, h('p', { class: 'note', style: 'margin:0' }, 'Capture the camera video first.'));
  const step3 = h('div', { class: 'step' }, h('span', { class: 'n' }, '3'), h('div', {}, h('h3', {}, 'Generate the video'), h('p', { style: 'margin:0 0 8px' }, 'Run a Comfy video workflow on this exact camera video. You see the quote first; nothing runs until you approve it.'), gen));
  const setOpen = (previsShotId: string, assetId: string) => { open.href = workflowUrl(previsShotId, assetId, prompt.value); open.removeAttribute('aria-disabled'); open.style.cssText = ''; renderGenerate(gen, s, previsShotId, assetId, () => prompt.value); };
  prompt.oninput = () => { if (s.render && open.href) setOpen(s.render.previsShotId, s.render.assetId); };
  const sig = signature(project, s);
  if (s.render && s.render.signature === sig) {
    media.replaceChildren(h('video', { src: `/assets/${s.render.assetId}.mp4`, controls: true, autoplay: true, muted: true, loop: true, playsinline: true }));
    step1.className = 'step done'; status.textContent = `Up to date: ${s.render.frameCount} frames · ${Number(s.render.duration).toFixed(2)}s · ${s.render.width}×${s.render.height}. Capture again to replace.`;
    step2.className = 'step active'; setOpen(s.render.previsShotId, s.render.assetId);
  }
  capture.onclick = async () => {
    capture.disabled = true; status.className = 'status-line'; progress.hidden = false; bar.style.width = '0%';
    const started = performance.now();
    try {
      const img = h('img', { alt: 'Captured frame' }); media.replaceChildren(img);
      const { asset, previsShotId, project: saved } = await captureShotVideo(s, { width, height, prompt: prompt.value, onFrame: (url, i, n) => { if (i % 4 === 0) img.src = url; bar.style.width = `${((i + 1) / n) * 100}%`; status.textContent = `Rendering frame ${i + 1} / ${n}`; }, onStatus: t => { status.textContent = t; } });
      const previsShot = { id: previsShotId }; const r = { project: saved };
      apply(r.project);
      media.replaceChildren(h('video', { src: asset.url, controls: true, autoplay: true, muted: true, loop: true, playsinline: true }));
      status.textContent = `Saved: ${asset.frameCount} frames · ${Number(asset.duration).toFixed(2)}s · ${asset.width}×${asset.height} in ${((performance.now() - started) / 1000).toFixed(1)}s.`;
      step1.className = 'step done'; step2.className = 'step done'; step3.className = 'step active';
      setOpen(previsShot.id, asset.id);
    } catch (e) {
      status.className = 'status-line err'; status.textContent = (e as Error).message;
    } finally {
      capture.disabled = false; progress.hidden = true; capture.textContent = 'Capture again';
    }
  };
  const dlg = h('dialog', { class: 'render', id: 'render-dialog', 'aria-labelledby': 'render-title' },
    h('div', { class: 'dialog-head' }, h('h2', { id: 'render-title' }, `Render shot ${String(idx + 1).padStart(2, '0')} · ${s.title}`), h('span', { class: 'muted', style: 'font-size:12px' }, describeCamera(s, project.scene.entities)), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'render-body' }, media, h('div', { class: 'render-steps' }, step1, step2, step3)),
    h('div', { class: 'render-foot' }, h('p', { class: 'note' }, 'Nothing is uploaded or charged without a quote you approve.'), open));
  document.body.append(dlg); dlg.showModal();
}

// ---------- In-app video generation (uses the workflow engine: preset → bind → quote → approve → submit → track) ----------
type GenState = { presets: any[]; definitions: any[]; jobs: any[]; paidExecutionEnabled: boolean };
async function renderGenerate(box: HTMLElement, s: Shot, previsShotId: string, assetId: string, getPrompt: () => string) {
  let st: GenState;
  try { st = await api('generation'); } catch (e) { box.replaceChildren(h('p', { class: 'status-line err' }, (e as Error).message)); return; }
  const choices = videoChoices(st as any);
  const wf = h('select', { class: 'field', 'aria-label': 'Workflow' }, ...choices.map(d => h('option', { value: d.id }, d.title)));
  const previous = st.jobs.filter(j => j.shotId === previsShotId && (j.sources?.sourceVideo?.id === assetId || j.sources?.controlVideo?.id === assetId)).at(-1);
  if (previous && choices.some(d => d.id === previous.definition?.id)) wf.value = previous.definition.id;
  const backendSel = h('select', { class: 'field', 'aria-label': 'Backend' }, h('option', { value: 'cloud' }, 'Comfy Cloud'), h('option', { value: 'local' }, 'Local ComfyUI'));
  const note = h('p', { class: 'note', style: 'margin:0' });
  const showNote = () => { const d = choices.find(c => c.id === wf.value); note.textContent = d?.description || ''; backendSel.value = d?.id?.startsWith('wan-') ? 'local' : 'cloud'; };
  const useRefs = h('input', { type: 'checkbox', checked: localStorage.getItem('previs.seq.refs') !== '0' });
  const refsBox = h('div', { class: 'gen-refs' });
  const showRefs = () => {
    const cap = referenceCapacity(st as any, wf.value), list = useRefs.checked ? plannedReferences(project, s, st as any, wf.value) : [];
    refsBox.replaceChildren(!cap ? h('span', { class: 'note' }, 'This workflow takes no reference images.') : list.length
      ? h('div', { class: 'gen-refs-row' }, ...list.map((r, i) => h('span', { class: 'gen-ref', title: `${r.label} — ${r.ref.name}` }, h('img', { src: refUrl(r.ref), alt: '' }), h('small', {}, `${i + 1} · ${r.label}`))))
      : h('span', { class: 'note' }, useRefs.checked ? 'No looks yet for the objects in this shot. Make them in Looks.' : 'References off.'));
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
    jobsBox.replaceChildren(...mine.map(j => h('div', { class: 'gen-job' }, h('b', { class: `st-${j.status}` }, j.status), h('span', {}, `${j.definition?.title?.split(' ·')[0] || 'Workflow'} · ${j.backend?.kind}`), h('small', { class: 'muted' }, j.message || ''))));
  };
  drawJobs();
  box.replaceChildren(h('div', { class: 'grid2' }, h('label', {}, 'Workflow', wf), h('label', {}, 'Backend', backendSel)), note,
    h('label', { style: 'display:flex;gap:8px;align-items:center;font-size:12px;color:var(--muted)' }, useRefs, 'Send the looks of the objects in this shot as reference images'), refsBox,
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
        if (['completed', 'failed', 'uncertain', 'closed', 'error'].includes(t.job.status)) { if (t.job.status === 'completed') toast(`Shot ${String(project.shots.indexOf(s) + 1).padStart(2, '0')} video is ready — see Workflow results`); return; }
        setTimeout(poll, 5000);
      };
      setTimeout(poll, 4000);
    } catch (e) { status.className = 'status-line err'; status.textContent = `${(e as Error).message} · No retry. Inspect request ${job.id} before preparing anything else.`; }
  };
  return h('div', { class: 'prompt-box', style: 'display:flex;flex-direction:column;gap:8px;white-space:normal' },
    h('div', { class: 'facts' }, 'Workflow', h('b', {}, def.title), 'Backend', h('b', {}, request.backend.kind === 'cloud' ? 'Comfy Cloud' : 'Local ComfyUI'),
      'Ready', h('b', { style: `color:${job.validation?.compatible ? 'var(--ok)' : 'var(--bad)'}` }, job.validation?.compatible ? 'Schema compatible' : 'Missing requirements'),
      'Cost', h('b', { style: `color:${free ? 'var(--ok)' : 'var(--warn)'}` }, free ? 'No charge (local)' : est ? `≈ $${est.toFixed(3)} estimate; Cloud total unknown` : 'Unknown — needs approval'),
      'Quote', h('b', {}, String(job.fingerprint || '').slice(0, 12))),
    h('p', { class: 'note' }, `Exact source: ${job.sources?.sourceVideo?.id || job.sources?.controlVideo?.id || job.sources?.firstFrame?.id || 'see request'} · ${job.sources?.sourceVideo?.frameCount ?? 'image'} frames · ${job.sources?.sourceVideo?.duration ?? '—'} s. Preparation does not upload inputs.`),
    def.pricing?.partnerEstimate ? h('p', { class: 'note' }, `Published partner estimate: $${def.pricing.partnerEstimate.min.toFixed(4)}–$${def.pricing.partnerEstimate.max.toFixed(4)} USD. ${def.pricing.partnerEstimate.note}`) : null,
    h('details', {}, h('summary', {}, 'Advanced · exact prompt and prepared graph'), h('pre', { style: 'max-height:240px;overflow:auto;white-space:pre-wrap' }, JSON.stringify({ prompt: job.binding?.prompt, sources: job.sources, graph: job.preparedGraph }, null, 2))),
    issues.length ? h('ul', { class: 'note', style: 'margin:0;padding-left:16px' }, ...issues.slice(0, 5).map((i: any) => h('li', {}, i.message))) : null,
    h('label', {}, approve, ' I approve this exact request, with an allowance of ', max, ' USD.'),
    !free ? h('label', {}, unknown, ' I accept unresolved provider/runtime charges. This allowance is not a provider-enforced spending cap.') : null,
    h('div', {}, go), status);
}

// ---------- Live sync ----------
async function pollNow() {
  try {
    const r = await api(`director/project?id=${projectId}&since=${project.revision}`);
    const changed = JSON.stringify(r.agent) !== JSON.stringify(agent);
    agent = r.agent;
    if (r.project) apply(r.project); else if (changed) renderRoute();
  } catch {}
}
async function poll() { await pollNow(); setTimeout(poll, 1200); }

async function boot() {
  if (!projectId) { location.href = '/'; return; }
  try {
    const [p, a] = await Promise.all([api(`director/project?id=${projectId}`), api('director/agent')]);
    agent = a.agent; connect = a.connect;
    void loadRefgen().then(pollJobs);
    apply(p.project);
    // Open on the action: frame subjects, not the buildings around them.
    scene.frame(project.scene.entities.filter(e => e.kind !== 'environment').map(e => e.id), 3.5);
    setTab('shot');
    if (params.get('view') === 'sequence') setMode('sequence');
    agentUi.connect(); // [agent] live steps + streaming reply
    setTimeout(poll, 1200);
  } catch (e) {
    app.replaceChildren(h('div', { class: 'empty-state', style: 'margin:80px auto;max-width:420px' }, (e as Error).message, h('br'), h('a', { href: '/', class: 'btn', style: 'margin-top:12px' }, 'Back to projects')));
  }
}
void boot();
