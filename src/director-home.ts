// Home / launch page: what Previs is, how it works in three steps, starters, and your projects.
import './director-home.css';
import { TEMPLATES, makeEntity, makeShot } from '../shared/director.mjs';
import type { DirectorProject, Shot } from '../shared/director.mjs';
import { KIND_COLORS } from '../shared/prompt.mjs';
import { renderStill } from './director-scene';
import { api, h, ago, connectDialog, toast } from './director-common';
import type { AgentStatus, Connect } from './director-common';
import { openJourney } from './director-guide';

type Summary = { id: string; title: string; template: string; updatedAt: string; shots: number; entities: number; references: number; renders: number; assets: number; sceneName: string };
type Check = { id: string; label: string; status: 'ok' | 'optional' | 'warn' | 'required'; detail: string; fix: string };
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

// What the first shot's camera sees at its first frame. Cached per key; '' when WebGL fails.
function still(project: Pick<DirectorProject, 'scene'>, shot: Shot, key: string) {
  let url = stills.get(key);
  if (url === undefined) { try { url = renderStill(project, shot, 960, 540); } catch { url = ''; } stills.set(key, url); }
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

/** The starter grid. Every starter renders through here. */
export function starterCards(starters: Starter[], onPick: (key: string) => void) {
  return h('div', { class: 'home-starters', 'data-count': String(Math.min(starters.length, 4)) }, ...starters.map(s =>
    h('button', { class: 'home-starter', type: 'button', 'data-template': s.key, onclick: () => onPick(s.key) },
      frame(still({ scene: s.scene }, s.shot, `starter:${s.key}`)),
      h('span', { class: 'home-starter-meta' },
        h('strong', {}, s.title),
        h('span', {}, s.description),
        h('span', { class: 'home-open', 'aria-hidden': 'true' }, s.shots && s.shots > 1 ? `${s.shots} shots` : 'Open', ' →')))));
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
    step(1, ICONS.block, 'Block out', 'Place people, cars and sets.'),
    step(2, ICONS.direct, 'Direct', 'Frame each shot, move the camera.'),
    step(3, ICONS.generate, 'Generate', 'Comfy renders the video you blocked.'));
}

// Quiet one-line readiness. Opens to the full check list; open by default only when something is required.
function setupStatus(checks: Check[], dataDir: string) {
  const required = checks.filter(c => c.status === 'required');
  const cloud = checks.find(c => c.id === 'cloud');
  const [tone, text] = required.length ? ['bad', `Setup needs attention · ${required.length}`]
    : cloud?.status === 'ok' ? ['ok', 'Comfy Cloud ready'] : ['warn', 'Add a Comfy Cloud key to generate'];
  const mark = { ok: '✓', optional: '–', warn: '!', required: '✗' };
  return h('details', { class: `home-status t-${tone}`, open: required.length > 0 },
    h('summary', {}, h('span', { class: 'home-dot' }), text),
    h('div', { class: 'home-status-pop' },
      h('ul', {}, ...checks.map(c => h('li', { class: `s-${c.status}` }, h('span', { class: 'mk' }, mark[c.status]), h('span', {}, h('b', {}, c.label), h('small', {}, c.detail, c.status !== 'ok' && c.fix ? ` — ${c.fix}` : ''))))),
      h('p', {}, 'Projects live in ', h('code', {}, dataDir), '. ', h('a', { href: '/setup.html' }, 'Open setup'))));
}

function claudeHint() {
  const text = agent?.connected ? `Claude connected${agent.name ? ` · ${agent.name}` : ''}` : 'Works with Claude — direct your scene in chat';
  return h('button', { class: 'home-claude' + (agent?.connected ? ' on' : ''), type: 'button', onclick: () => connectDialog(agent, connect) }, h('span', { class: 'home-claude-mark', 'aria-hidden': 'true' }, '✳'), text);
}

// Hero visual: the starters' first frames, cross-fading like a monitor.
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

function menu(p: Summary) {
  const act = (label: string, fn: () => Promise<void>) => h('button', { role: 'menuitem', type: 'button', onclick: async () => { try { await fn(); } catch (e) { toast((e as Error).message, true); } } }, label);
  const pop = h('div', { class: 'home-menu', hidden: true, role: 'menu' },
    h('a', { role: 'menuitem', href: `/api/director/export?id=${p.id}`, download: '' }, 'Export (.zip)'),
    act('Duplicate', async () => { await api('director/duplicate', { projectId: p.id }); toast(`Duplicated “${p.title}”`); void render(); }),
    act('Archive', async () => { if (!confirm(`Archive “${p.title}”? It moves to Archived and can be restored. Nothing is deleted.`)) return; await api('director/archive', { projectId: p.id }); toast('Archived'); void render(); }));
  const btn = h('button', { class: 'home-more', type: 'button', 'aria-label': `More actions for ${p.title}`, 'aria-haspopup': 'menu', onclick: (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); document.querySelectorAll('.home-menu').forEach(m => { if (m !== pop) (m as HTMLElement).hidden = true; }); pop.hidden = !pop.hidden; } }, '⋯');
  return [btn, pop];
}

function projectCard(p: Summary) {
  const card = h('a', { class: 'home-project', href: `/director.html?project=${p.id}` },
    h('div', { class: 'home-frame is-loading' }),
    h('span', { class: 'home-project-meta' }, h('strong', {}, p.title), h('span', {}, `${p.shots} shot${p.shots === 1 ? '' : 's'} · ${ago(p.updatedAt)}`)));
  void api(`director/project?id=${p.id}`).then(({ project }) => {
    card.firstElementChild!.replaceWith(frame(project.shots[0] ? still(project, project.shots[0], `${p.id}:${project.revision}`) : ''));
  }).catch(() => card.firstElementChild!.classList.remove('is-loading'));
  return h('div', { class: 'home-project-wrap' }, card, ...menu(p));
}

async function render() {
  let projects: Summary[] = [], archivedCount = 0, archived: Summary[] = [];
  let setup: { checks: Check[]; dataDir: string } | null = null;
  try {
    const [data, s] = await Promise.all([api('director/projects'), api('director/setup').catch(() => null)]);
    projects = data.projects; agent = data.agent; connect = data.connect; archivedCount = data.archived; setup = s;
    if (showArchived) archived = (await api('director/archived')).projects;
  } catch (e) { toast((e as Error).message, true); }
  const starters = templateStarters();
  const starterSection = h('section', { class: 'home-section', id: 'starters', 'aria-labelledby': 'starters-title' },
    h('div', { class: 'home-head' }, h('h2', { id: 'starters-title' }, 'Starters'), h('span', {}, 'Open one and make it yours.')),
    starterCards(starters, key => void create(key)));
  const fileInput = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true, onchange: (ev: Event) => { const f = (ev.target as HTMLInputElement).files?.[0]; if (f) void importFile(f); } });
  const newScene = (label: string, cls = 'primary') => h('button', { class: `home-btn ${cls}`, type: 'button', onclick: () => void create('empty') }, label);
  const list = projects.length
    ? h('div', { class: 'home-projects' }, ...projects.map(projectCard))
    : h('div', { class: 'home-empty' }, h('strong', {}, 'No projects yet'), h('span', {}, 'Start a new scene or open a starter. Your work saves here automatically.'), newScene('New scene', 'ghost'));
  const archivedList = showArchived ? h('div', { class: 'home-projects is-archived' }, ...archived.map(p => h('div', { class: 'home-project' },
    h('span', { class: 'home-project-meta' }, h('strong', {}, p.title), h('span', {}, `${p.shots} shot${p.shots === 1 ? '' : 's'} · archived`),
      h('button', { class: 'home-btn ghost sm', type: 'button', onclick: async () => { try { await api('director/restore', { projectId: p.id }); toast(`Restored “${p.title}”`); void render(); } catch (e) { toast((e as Error).message, true); } } }, 'Restore'))))) : null;

  app.replaceChildren(
    h('header', { class: 'home-top' },
      h('a', { class: 'brand', href: '/' }, h('span', { class: 'brand-mark' }), 'Comfy Previs'),
      h('nav', {},
        h('button', { class: 'home-link', type: 'button', onclick: () => openJourney() }, 'Guide'),
        h('a', { class: 'home-link', href: '/setup.html' }, 'Setup'))),
    h('main', { class: 'home' },
      h('section', { class: 'home-hero' },
        h('div', { class: 'home-hero-copy' },
          h('p', { class: 'home-eyebrow' }, 'Previs for AI video'),
          h('h1', {}, 'Block out the scene.', h('br'), h('span', {}, 'Generate the shot you meant.')),
          h('p', { class: 'home-lede' }, 'Arrange a scene in 3D, direct the camera, and Comfy turns it into video.'),
          h('div', { class: 'home-actions' },
            newScene('New scene'),
            h('a', { class: 'home-btn', href: '#starters', onclick: (ev: Event) => { ev.preventDefault(); starterSection.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); } }, 'Open a starter')),
          h('div', { class: 'home-meta' }, claudeHint(), setup ? setupStatus(setup.checks, setup.dataDir) : null)),
        heroReel(starters)),
      steps(),
      starterSection,
      h('section', { class: 'home-section', 'aria-labelledby': 'projects-title' },
        h('div', { class: 'home-head' }, h('h2', { id: 'projects-title' }, 'Your projects'), projects.length ? h('span', {}, String(projects.length)) : null, h('i', { class: 'grow' }),
          fileInput, h('button', { class: 'home-link', type: 'button', onclick: () => fileInput.click() }, 'Import…'),
          archivedCount ? h('button', { class: 'home-link', type: 'button', 'aria-pressed': String(showArchived), onclick: () => { showArchived = !showArchived; void render(); } }, showArchived ? 'Hide archived' : `Archived · ${archivedCount}`) : null),
        list, archivedList),
      h('footer', { class: 'home-foot' }, h('span', {}, 'More tools'), h('a', { href: '/index.html' }, 'Camera studio'), h('a', { href: '/previs.html' }, 'Blender scenes'), h('a', { href: '/generation.html' }, 'Video workflows'))));
}

export function renderHome() {
  document.addEventListener('click', ev => {
    document.querySelectorAll('.home-menu').forEach(m => ((m as HTMLElement).hidden = true));
    const status = document.querySelector<HTMLDetailsElement>('.home-status[open]');
    if (status && !status.contains(ev.target as Node)) status.open = false;
  });
  void render();
}
