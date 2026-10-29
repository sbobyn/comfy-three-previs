import './director.css';
import { TEMPLATES, makeEntity, makeShot, MOVES } from '../shared/director.mjs';
import type { DirectorProject, Shot } from '../shared/director.mjs';
import { renderStill } from './director-scene';
import { api, h, ago, agentPill, connectDialog, toast } from './director-common';
import type { AgentStatus, Connect } from './director-common';

type Summary = { id: string; title: string; template: string; updatedAt: string; shots: number; entities: number; references: number; renders: number; assets: number; sceneName: string };
type Check = { id: string; label: string; status: 'ok' | 'optional' | 'warn' | 'required'; detail: string; fix: string };
const app = document.getElementById('app')!;
let agent: AgentStatus | null = null, connect: Connect = null;
let showArchived = false;
const stills = new Map<string, string>();

async function open(template: string, name: string) {
  try {
    const { project } = await api('director/projects', { template, title: name.trim() || undefined });
    location.href = `/director.html?project=${project.id}`;
  } catch (e) { toast((e as Error).message, true); }
}

// Card thumbnail: what the first shot's camera sees at its first frame.
function thumb(project: Pick<DirectorProject, 'scene'>, shot: Shot, key: string) {
  let url = stills.get(key);
  if (!url) { try { url = renderStill(project, shot, 640, 360); stills.set(key, url); } catch { url = ''; } }
  return h('div', { class: 'plan still' },
    url ? h('img', { src: url, alt: '' }) : null,
    h('span', { class: 'still-chip' }, `SHOT 01 · ${MOVES[shot.camera.move]} · ${Math.round(shot.camera.mm)}mm`));
}
async function thumbFor(id: string) {
  const { project } = await api(`director/project?id=${id}`);
  return thumb(project, project.shots[0], `${id}:${project.revision}`);
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
  const pop = h('div', { class: 'card-menu', hidden: true, role: 'menu' },
    h('a', { role: 'menuitem', href: `/api/director/export?id=${p.id}`, download: '' }, 'Export (.zip)'),
    h('button', { role: 'menuitem', type: 'button', onclick: async () => { try { await api('director/duplicate', { projectId: p.id }); toast(`Duplicated “${p.title}”`); void render(); } catch (e) { toast((e as Error).message, true); } } }, 'Duplicate'),
    h('button', { role: 'menuitem', type: 'button', onclick: async () => { if (!confirm(`Archive “${p.title}”? It moves to Archived and can be restored. Nothing is deleted.`)) return; try { await api('director/archive', { projectId: p.id }); toast('Archived'); void render(); } catch (e) { toast((e as Error).message, true); } } }, 'Archive'));
  const btn = h('button', { class: 'btn ghost sm icon card-more', type: 'button', 'aria-label': `More actions for ${p.title}`, 'aria-haspopup': 'menu', onclick: (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); document.querySelectorAll('.card-menu').forEach(m => { if (m !== pop) (m as HTMLElement).hidden = true; }); pop.hidden = !pop.hidden; } }, '⋯');
  return [btn, pop];
}

function setupCard(checks: Check[], dataDir: string) {
  const required = checks.filter(c => c.status === 'required');
  const mark = { ok: '✓', optional: '–', warn: '!', required: '✗' };
  const details = h('details', { class: 'setup-card', open: required.length > 0 },
    h('summary', {}, h('strong', {}, required.length ? `Setup needs attention · ${required.length}` : 'Setup'), h('span', { class: 'muted' }, required.length ? 'Fix the ✗ items to export videos and save work.' : `Ready · ${checks.filter(c => c.status === 'ok').length}/${checks.length} checks`)),
    h('ul', {}, ...checks.map(c => h('li', { class: `s-${c.status}` }, h('span', { class: 'mk' }, mark[c.status]), h('span', { class: 'lb' }, c.label), h('span', { class: 'dt' }, c.detail, c.status !== 'ok' && c.fix ? h('small', {}, c.fix) : null)))),
    h('p', { class: 'note' }, 'Projects are saved in ', h('code', {}, dataDir), '. Run ', h('code', {}, 'pnpm run doctor'), ' in a terminal for the same checks.'));
  return details;
}

async function render() {
  let projects: Summary[] = [], archivedCount = 0, archived: Summary[] = [];
  let setup: { checks: Check[]; dataDir: string } | null = null;
  try {
    const [data, s] = await Promise.all([api('director/projects'), api('director/setup').catch(() => null)]);
    projects = data.projects; agent = data.agent; connect = data.connect; archivedCount = data.archived; setup = s;
    if (showArchived) archived = (await api('director/archived')).projects;
  } catch (e) { toast((e as Error).message, true); }
  const name = h('input', { class: 'field', id: 'new-name', placeholder: 'Untitled scene', maxlength: 120, autocomplete: 'off' });
  const templates = Object.entries(TEMPLATES).map(([key, t]) => {
    const entities = t.entities.map((e, i) => makeEntity(e, String(i)));
    const scene = { name: t.title, environment: t.environment, entities };
    return h('button', { class: 'card', type: 'button', 'data-template': key, onclick: () => open(key, name.value) },
      thumb({ scene }, makeShot({ title: 'Shot 1' }, 'starter', 1, entities), `template:${key}`),
      h('div', { class: 'meta' }, h('strong', {}, t.title), h('span', {}, t.description)));
  });
  const fileInput = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true, onchange: (ev: Event) => { const f = (ev.target as HTMLInputElement).files?.[0]; if (f) void importFile(f); } });
  const list = projects.length
    ? h('div', { class: 'projects' }, ...projects.map(p => {
        const card = h('a', { class: 'card', href: `/director.html?project=${p.id}` },
          h('div', { class: 'plan' }),
          h('div', { class: 'meta' }, h('strong', {}, p.title), h('span', {}, `${p.shots} shot${p.shots === 1 ? '' : 's'} · ${p.entities} objects${p.references ? ` · ${p.references} refs` : ''}${p.assets ? ` · ${p.assets} assets` : ''} · ${ago(p.updatedAt)}`)));
        void thumbFor(p.id).then(el => card.firstElementChild!.replaceWith(el)).catch(() => {});
        return h('div', { class: 'card-wrap' }, card, ...menu(p));
      }))
    : h('div', { class: 'empty-state' }, 'No projects yet. Start from a blockout above, or import an exported project.');
  const archivedList = showArchived ? h('div', { class: 'projects', style: 'margin-top:14px' }, ...archived.map(p => h('div', { class: 'card', style: 'cursor:default' },
    h('div', { class: 'meta' }, h('strong', {}, p.title), h('span', {}, `${p.shots} shots · archived`), h('button', { class: 'btn sm', type: 'button', style: 'margin-top:8px;align-self:flex-start', onclick: async () => { try { await api('director/restore', { projectId: p.id }); toast(`Restored “${p.title}”`); void render(); } catch (e) { toast((e as Error).message, true); } } }, 'Restore'))))) : null;

  app.replaceChildren(
    h('header', { class: 'launch-top' },
      h('a', { class: 'brand', href: '/' }, h('span', { class: 'brand-mark' }), 'Comfy Previs'),
      h('nav', {},
        agentPill(agent, () => connectDialog(agent, connect)),
        h('a', { class: 'btn ghost sm', href: '/generation.html' }, 'Workflows'),
        h('a', { class: 'btn ghost sm', href: '/setup.html' }, 'Setup'))),
    h('main', { class: 'launch-main' },
      h('section', { class: 'launch-hero' },
        h('div', {},
          h('div', { class: 'eyebrow' }, 'Previs for filmmakers'),
          h('h1', {}, 'Direct the scene.', h('br'), h('span', { class: 'muted' }, 'Then hand it to Comfy.')),
          h('p', {}, 'Block out a scene, describe each shot to your agent, drop in image references, preview the camera — and send the exact camera render to a Comfy workflow.')),
        h('div', { class: 'journey', 'aria-label': 'Journey' }, ...['Block out', 'Describe shots', 'Reference', 'Preview camera', 'Render workflow'].map((s, i) => h('span', {}, h('b', {}, String(i + 1).padStart(2, '0')), s)))),
      setup ? setupCard(setup.checks, setup.dataDir) : null,
      h('div', { class: 'section-head' }, h('h2', {}, 'New project'), h('span', { class: 'muted' }, 'Pick a starting blockout — everything stays editable.')),
      h('div', { class: 'new-row' },
        h('div', { class: 'new-name' }, h('label', { for: 'new-name' }, 'Project name'), name, h('p', { class: 'note', style: 'margin:0' }, 'One scene per project for now. Add as many shots as you need.'), h('div', { style: 'flex:1' }), h('button', { class: 'btn', type: 'button', onclick: () => open('empty', name.value) }, 'Start empty')),
        h('div', { class: 'templates' }, ...templates)),
      h('div', { class: 'section-head' }, h('h2', {}, 'Open project'), h('span', { class: 'grow' }),
        fileInput, h('button', { class: 'btn sm', type: 'button', onclick: () => fileInput.click() }, 'Import project…'),
        archivedCount ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { showArchived = !showArchived; void render(); } }, showArchived ? 'Hide archived' : `Archived · ${archivedCount}`) : null),
      list, archivedList,
      h('div', { class: 'foot-links' }, h('span', {}, 'Earlier tools:'), h('a', { href: '/index.html' }, 'Camera studio (keyboard / phone / gamepad)'), h('a', { href: '/previs.html' }, 'Blender scenes & shots'), h('a', { href: '/generation.html' }, 'Video workflows'))));
}
document.addEventListener('click', () => document.querySelectorAll('.card-menu').forEach(m => ((m as HTMLElement).hidden = true)));
void render();
