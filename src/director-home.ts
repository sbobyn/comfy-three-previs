// Home / launch page: what Comfy Three Previs does, how it works in three steps, starters, and your projects.
import './director-home.css';
import './director-home-mobile.css'; // [mobile]
import { TEMPLATES, makeEntity, makeShot } from '../shared/director.mjs';
import type { DirectorProject, Shot } from '../shared/director.mjs';
import { KIND_COLORS } from '../shared/prompt.mjs';
import { renderStill } from './director-scene';
import { api, h, ago, claudeDialog, toast, DEMO, demoBadge } from './director-common';
import type { AgentStatus, Connect } from './director-common';
import { openJourney } from './director-guide';
import { checkList, openSetup } from './director-setup';
import type { Check } from './director-setup';
import { beforeAfter, guideManifest, guideUrl } from './director-media';
import { starterMedia } from './director-desktop-core';

type Summary = { id: string; title: string; template: string; updatedAt: string; shots: number; entities: number; references: number; renders: number; assets: number; sceneName: string };
/** One starter card: enough of the blockout to draw shot 1. `key` is what the server creates from. */
export type Starter = { key: string; title: string; description: string; scene: DirectorProject['scene']; shot: Shot; shots?: number };

const app = document.getElementById('app')!;
let agent: AgentStatus | null = null, connect: Connect = null;
let showArchived = false;
const stills = new Map<string, string>();

async function create(template: string) {
  try {
    const { project } = await api('director/projects', { template });
    location.href = `/director.html?project=${project.id}`;
  } catch (e) { toast((e as Error).message, true); }
}

// What the first shot's camera sees halfway through (the first frame can start inside the set). Cached per key; '' when WebGL fails.
function still(project: Pick<DirectorProject, 'scene'>, shot: Shot, key: string) {
  let url = stills.get(key);
  if (url === undefined) { try { url = renderStill(project, shot, 960, 540, (shot.duration || 0) / 2); } catch { url = ''; } stills.set(key, url); }
  return url;
}
function frame(url: string, cls = '') {
  return h('div', { class: `home-frame ${cls}` }, url ? h('img', { src: url, alt: '', decoding: 'async' }) : null);
}

/** Starters from the shared TEMPLATES list (empty is the "New scene" action, not a card). */
function templateStarters(): Starter[] {
  return Object.entries(TEMPLATES).filter(([key]) => key !== 'empty').map(([key, t]) => {
    const entities = t.entities.map((e, i) => makeEntity(e, String(i)));
    return { key, title: t.title, description: t.description, scene: { name: t.title, environment: t.environment, entities } as DirectorProject['scene'], shot: makeShot({ title: 'Shot 1' }, 'starter', 1, entities) };
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** One card for starters and projects: a frame, a title (full text in `title`) and a line under it. */
function card(el: HTMLElement, img: HTMLElement | null, title: string, line: string, extra?: HTMLElement) {
  if (img) el.append(img);
  el.append(h('span', { class: 'home-card-meta' }, h('strong', { title }, title.replace(/^Starter · /, '')), h('span', {}, line), extra));
  return el;
}

/**
 * The starter grid. Every starter renders through here: its hero shot as a draggable blockout → video seam
 * (a still pair, or just the blockout frame, when that's all there is), the cast's images under it, then the title.
 */
export function starterCards(starters: Starter[], onPick: (key: string) => void) {
  const cards = starters.map(s => {
    const blockout = frame(still({ scene: s.scene }, s.shot, `starter:${s.key}`));
    const slot = h('button', { class: 'home-seam-slot', type: 'button', tabindex: -1, 'aria-hidden': 'true', onclick: () => onPick(s.key) }, blockout);
    const cast = h('div', { class: 'home-cast', hidden: true });
    const open = card(h('button', { class: 'home-starter-open', type: 'button', onclick: () => onPick(s.key) }), null, s.title, s.description,
      h('span', { class: 'home-open', 'aria-hidden': 'true' }, s.shots && s.shots > 1 ? `${s.shots} shots` : 'Open', ' →'));
    return { s, slot, cast, el: h('div', { class: 'home-starter', 'data-template': s.key }, slot, cast, open) };
  });
  void guideManifest().then(map => {
    const entries = [...map.values()];
    for (const c of cards) {
      const m = starterMedia(c.s.key, entries);
      if (m.kind !== 'still' && c.slot.isConnected) {
        // The generated loop fills the card; hovering (or dragging on touch) scrubs the blockout in from the left.
        const seam = beforeAfter({ before: guideUrl(m.before!), after: guideUrl(m.after!), kind: m.kind, posters: m.posters?.map(guideUrl) as [string, string] | undefined, sweep: false, reveal: true, alt: `${m.label || c.s.title}: the generated ${m.kind === 'video' ? 'video' : 'still'}. Move across it, or use the arrow keys, to reveal the blockout it was made from.` });
        c.slot.replaceWith(h('div', { class: 'home-seam-slot has-seam' }, seam));
      }
      if (m.cast.length) { c.cast.hidden = false; c.cast.replaceChildren(h('span', { class: 'home-cast-label' }, 'Cast'), ...m.cast.slice(0, 5).map(x => h('img', { src: guideUrl(x.file), alt: x.label, title: x.label, loading: 'lazy', decoding: 'async' }))); }
    }
  });
  return h('div', { class: 'home-starters', 'data-count': String(Math.min(starters.length, 4)) }, ...cards.map(c => c.el));
}

const ICONS = {
  block: `<svg viewBox="0 0 64 48" aria-hidden="true"><ellipse cx="32" cy="38" rx="26" ry="7" fill="currentColor" opacity=".08"/>
    <rect x="10" y="22" width="14" height="14" rx="2.5" fill="${KIND_COLORS.vehicle}"/>
    <rect x="27" y="10" width="11" height="26" rx="5.5" fill="${KIND_COLORS.character}"/>
    <path d="M42 36 L49 20 L56 36 Z" fill="${KIND_COLORS.environment}"/></svg>`,
  direct: `<svg viewBox="0 0 64 48" aria-hidden="true"><rect x="8" y="8" width="48" height="30" rx="4" fill="none" stroke="currentColor" stroke-width="2" opacity=".85"/>
    <path d="M8 16V8h8M56 16V8h-8M8 30v8h8M56 30v8h-8" fill="none" stroke="currentColor" stroke-width="2"/>
    <path d="M14 33 C 24 20, 38 18, 50 14" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="3 3"/>
    <circle cx="50" cy="14" r="3.5" fill="var(--accent)"/></svg>`,
  generate: `<svg viewBox="0 0 64 48" aria-hidden="true"><rect x="8" y="9" width="48" height="30" rx="4" fill="currentColor"/>
    <path d="M8 16h48M8 32h48" stroke="var(--card)" stroke-width="1.5" opacity=".35"/>
    <path d="M32 15 l2.6 6.4 6.4 2.6 -6.4 2.6 -2.6 6.4 -2.6 -6.4 -6.4 -2.6 6.4 -2.6 Z" fill="var(--card)"/>
    <circle cx="44" cy="19" r="1.6" fill="var(--card)" opacity=".7"/></svg>`,
};
function steps() {
  const step = (n: number, icon: string, title: string, line: string) => {
    const art = h('span', { class: 'home-step-art' }); art.innerHTML = icon;
    return h('li', { class: 'home-step' }, art, h('span', { class: 'home-step-n' }, String(n)), h('strong', {}, title), h('span', {}, line));
  };
  return h('ol', { class: 'home-steps', 'aria-label': 'How it works' },
    step(1, ICONS.block, 'Build', 'Place people, cars and sets.'),
    step(2, ICONS.direct, 'Shoot', 'Frame each shot, move the camera.'),
    step(3, ICONS.generate, 'Generate', 'Comfy turns your blockout into video.'));
}

// Quiet one-line readiness. Opens to the full check list; open by default only when something is required.
function setupStatus(checks: Check[], dataDir: string) {
  const required = checks.filter(c => c.status === 'required');
  const cloud = checks.find(c => c.id === 'cloud');
  const [tone, text] = required.length ? ['bad', `Setup needs attention · ${required.length}`]
    : cloud?.status === 'ok' ? ['ok', 'Comfy Cloud ready'] : ['warn', 'Add a Comfy Cloud key to generate'];
  return h('details', { class: `home-status t-${tone}`, open: required.length > 0 },
    h('summary', {}, h('span', { class: 'home-dot' }), text),
    h('div', { class: 'home-status-pop' }, checkList(checks),
      h('p', {}, 'Projects live in ', h('code', {}, dataDir), '. ', h('button', { class: 'home-inline', type: 'button', onclick: () => openSetup() }, 'Open setup'))));
}

function claudeHint() {
  const text = agent?.connected ? `Claude connected${agent.name ? ` · ${agent.name}` : ''}` : 'Works with Claude — direct your scene in chat';
  return h('button', { class: 'home-claude' + (agent?.connected ? ' on' : ''), type: 'button', onclick: () => claudeDialog(connect) }, h('span', { class: 'home-claude-mark', 'aria-hidden': 'true' }, '✳'), text);
}

/**
 * Hero: The draft (Final Lap) as one frame — blockout ↔ generated, the same camera — sweeping once on load,
 * then the seam follows a drag. Falls back to the starters' blockout frames when the example media is missing.
 */
function heroSeam(starters: Starter[]) {
  const slot = h('div', { class: 'home-hero-seam' }, heroReel(starters));
  void guideManifest().then(map => {
    const m = starterMedia('final-lap', [...map.values()]);
    if (m.kind !== 'video' || !slot.isConnected) return;
    const seam = beforeAfter({ before: guideUrl(m.before!), after: guideUrl(m.after!), kind: 'video', posters: m.posters?.map(guideUrl) as [string, string] | undefined, sweep: 'once', alt: `${m.label || 'The draft'}: the blockout on the left and the generated video on the right, the same camera. Drag the seam or use the arrow keys.` });
    slot.replaceChildren(seam, h('p', { class: 'home-hero-cap' }, h('strong', {}, 'Same camera.'), ' Drag the seam.', h('span', {}, m.label || 'Final Lap · The draft')));
  });
  return slot;
}
// Fallback hero: the starters' first frames, cross-fading like a monitor.
function heroReel(starters: Starter[]) {
  const urls = starters.map(s => still({ scene: s.scene }, s.shot, `starter:${s.key}`)).filter(Boolean);
  if (!urls.length) return h('div', { class: 'home-reel is-empty' });
  const imgs = urls.map((u, i) => h('img', { src: u, alt: '', class: i === 0 ? 'on' : '' }));
  const reel = h('div', { class: 'home-reel', 'aria-hidden': 'true' }, ...imgs,
    h('span', { class: 'home-reel-corners' }), h('span', { class: 'home-reel-tag' }, h('i'), 'SHOT 01'));
  if (imgs.length > 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let i = 0;
    const timer = setInterval(() => {
      if (!reel.isConnected) return clearInterval(timer);
      imgs[i]!.classList.remove('on'); i = (i + 1) % imgs.length; imgs[i]!.classList.add('on');
    }, 3600);
  }
  return reel;
}

async function importFile(file: File) {
  try {
    const r = await fetch('/api/director/import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file });
    const data = await r.json();
    if (!r.ok) throw Error(data.error);
    toast(`Imported “${data.project.title}”`);
    void render();
  } catch (e) { toast((e as Error).message, true); }
}

// Small modal in the workspace's delete-dialog style. `field` adds a text input; resolves its value (or true), null on cancel.
function ask(title: string, body: string, ok: string, field?: string): Promise<string | true | null> {
  return new Promise(resolve => {
    const input = field !== undefined ? h('input', { class: 'field', type: 'text', value: field, maxlength: 120, 'aria-label': 'Project name' }) : null;
    let result: string | true | null = null;
    const okBtn = h('button', { class: 'btn primary', type: 'submit' }, ok);
    const dlg = h('dialog', { class: 'confirm', 'aria-labelledby': 'ask-title' },
      h('form', { class: 'dialog-body', method: 'dialog', onsubmit: () => { result = input ? input.value.trim() || null : true; } },
        h('h2', { id: 'ask-title', style: 'margin:0;font-size:15px' }, title),
        body ? h('p', { class: 'muted', style: 'margin:0' }, body) : null, input,
        h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'), okBtn)));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    document.body.append(dlg); dlg.showModal();
    if (input) input.select(); else okBtn.focus();
  });
}

function menu(p: Summary) {
  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const act = (label: string, fn: () => Promise<void>) => h('button', { role: 'menuitem', type: 'button', onclick: async () => { close(); try { await fn(); } catch (e) { toast((e as Error).message, true); } } }, label);
  const pop = h('div', { class: 'home-menu', hidden: true, role: 'menu' },
    act('Rename…', async () => { const name = await ask('Rename project', '', 'Rename', p.title); if (typeof name !== 'string' || name === p.title) return; await api('director/edit', { projectId: p.id, ops: [{ op: 'set_project', patch: { title: name } }] }); void render(); }),
    h('a', { role: 'menuitem', href: `/api/director/export?id=${p.id}`, download: '' }, 'Export (.zip)'),
    act('Duplicate', async () => { await api('director/duplicate', { projectId: p.id }); toast(`Duplicated “${p.title}”`); void render(); }),
    act('Archive…', async () => { if (!await ask(`Archive “${p.title}”?`, 'It moves to Archived and can be restored. Nothing is deleted.', 'Archive')) return; await api('director/archive', { projectId: p.id }); toast('Archived'); void render(); }));
  const items = () => Array.from(pop.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  pop.onkeydown = ev => {
    const list = items(), i = list.indexOf(document.activeElement as HTMLElement);
    const go = (k: number) => { ev.preventDefault(); list[(k + list.length) % list.length]?.focus(); };
    if (ev.key === 'ArrowDown') go(i + 1); else if (ev.key === 'ArrowUp') go(i - 1); else if (ev.key === 'Home') go(0); else if (ev.key === 'End') go(list.length - 1);
    else if (ev.key === 'Escape' || ev.key === 'Tab') { if (ev.key === 'Escape') { ev.preventDefault(); btn.focus(); } close(); }
  };
  const btn = h('button', { class: 'home-more', type: 'button', 'aria-label': `More actions for ${p.title}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: (ev: Event) => {
    ev.preventDefault(); ev.stopPropagation();
    document.querySelectorAll('.home-menu').forEach(m => { if (m !== pop) (m as HTMLElement).hidden = true; });
    pop.hidden = !pop.hidden; btn.setAttribute('aria-expanded', String(!pop.hidden));
    if (!pop.hidden && (ev as MouseEvent).detail === 0) items()[0]?.focus();
  } }, '⋯');
  return [btn, pop];
}

function projectCard(p: Summary) {
  const el = card(h('a', { class: 'home-project', href: `/director.html?project=${p.id}` }), h('div', { class: 'home-frame is-loading' }),
    p.title, `${plural(p.shots, 'shot')} · ${plural(p.entities, 'object')} · ${ago(p.updatedAt)}`);
  void api(`director/project?id=${p.id}`).then(({ project }) => {
    el.firstElementChild!.replaceWith(frame(project.shots[0] ? still(project, project.shots[0], `${p.id}:${project.revision}`) : ''));
  }).catch(() => el.firstElementChild!.classList.remove('is-loading'));
  return h('div', { class: 'home-project-wrap' }, el, ...menu(p));
}

async function render() {
  let projects: Summary[] = [], archivedCount = 0, archived: Summary[] = [], served: Starter[] = [];
  let setup: { checks: Check[]; dataDir: string } | null = null;
  try {
    const [data, s, st] = await Promise.all([api('director/projects'), api('director/setup').catch(() => null), api('director/starters').catch(() => ({ starters: [] }))]);
    projects = data.projects; agent = data.agent; connect = data.connect; archivedCount = data.archived; setup = s;
    served = (st.starters || []).map((t: any) => ({ key: t.slug, title: String(t.title).replace(/^Starter · /, ''), description: t.description, shots: t.shots, scene: t.scene, shot: { ...t.shot, id: `starter-${t.slug}`, references: [], render: null } }));
    if (showArchived) archived = (await api('director/archived')).projects;
  } catch (e) { toast((e as Error).message, true); }
  const starters = served.length ? served : templateStarters();
  const starterSection = h('section', { class: 'home-section', id: 'starters', 'aria-labelledby': 'starters-title' },
    h('div', { class: 'home-head' }, h('h2', { id: 'starters-title' }, 'Starters'), h('span', {}, 'Open one and make it yours.')),
    starterCards(starters, key => void create(key)));
  const fileInput = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true, onchange: (ev: Event) => { const f = (ev.target as HTMLInputElement).files?.[0]; if (f) void importFile(f); } });
  const newScene = (label: string, cls = 'primary') => h('button', { class: `home-btn ${cls}`, type: 'button', onclick: () => void create('empty') }, label);
  const list = projects.length
    ? h('div', { class: 'home-projects' }, ...projects.map(projectCard))
    : h('div', { class: 'home-empty' }, h('strong', {}, 'No projects yet'), h('span', {}, 'Start a new scene or open a starter. Your work saves here automatically.'), newScene('New scene', 'ghost'));
  const archivedList = showArchived ? h('div', { class: 'home-projects is-archived' }, ...archived.map(p => card(h('div', { class: 'home-project' }), null, p.title, `${plural(p.shots, 'shot')} · archived`,
    h('button', { class: 'home-btn ghost sm', type: 'button', onclick: async () => { try { await api('director/restore', { projectId: p.id }); toast(`Restored “${p.title}”`); void render(); } catch (e) { toast((e as Error).message, true); } } }, 'Restore')))) : null;

  app.replaceChildren(
    h('header', { class: 'home-top' },
      h('a', { class: 'brand', href: '/' }, h('span', { class: 'brand-mark' }), 'Comfy Three Previs'),
      h('nav', {}, DEMO ? demoBadge() : null,
        h('button', { class: 'home-link', type: 'button', onclick: () => openJourney() }, 'Guide'),
        h('button', { class: 'home-link', type: 'button', onclick: () => openSetup() }, 'Setup'))),
    // Phones list projects before starters, except for someone new (fewer than 3 projects): starters first.
    h('main', { class: 'home' + (projects.length < 3 ? ' is-new' : '') },
      h('section', { class: 'home-hero' },
        h('div', { class: 'home-hero-copy' },
          h('p', { class: 'home-eyebrow' }, 'Previsualization for AI video'),
          h('h1', {}, 'Block out the scene.', h('br'), h('span', {}, 'Generate the shot you meant.')),
          h('p', { class: 'home-lede' }, 'Arrange a scene in 3D, direct the camera, and Comfy turns it into video.'),
          h('div', { class: 'home-actions' },
            newScene('New scene'),
            h('a', { class: 'home-btn', href: '#starters', onclick: (ev: Event) => { ev.preventDefault(); starterSection.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); } }, 'Open a starter')),
          h('div', { class: 'home-meta' }, claudeHint(), setup && !DEMO ? setupStatus(setup.checks, setup.dataDir) : null)),
        heroSeam(starters)),
      steps(),
      starterSection,
      h('section', { class: 'home-section', 'aria-labelledby': 'projects-title' },
        h('div', { class: 'home-head' }, h('h2', { id: 'projects-title' }, 'Your projects'), projects.length ? h('span', {}, String(projects.length)) : null, h('i', { class: 'grow' }),
          fileInput, h('button', { class: 'home-link', type: 'button', onclick: () => fileInput.click() }, 'Import…'),
          archivedCount ? h('button', { class: 'home-link home-archived', type: 'button', 'aria-pressed': String(showArchived), onclick: () => { showArchived = !showArchived; void render(); } }, showArchived ? 'Hide archived' : `Archived · ${archivedCount}`) : null),
        list, archivedList)));
}

export function renderHome() {
  document.addEventListener('click', ev => {
    document.querySelectorAll('.home-menu').forEach(m => { (m as HTMLElement).hidden = true; m.previousElementSibling?.setAttribute('aria-expanded', 'false'); });
    const status = document.querySelector<HTMLDetailsElement>('.home-status[open]');
    if (status && !status.contains(ev.target as Node)) status.open = false;
  });
  void render();
}
