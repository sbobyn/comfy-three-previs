import { SHAPES, entitySize } from '../shared/director.mjs';
import type { Entity } from '../shared/director.mjs';

export type RunnerStatus = { available: boolean; model: string; busy: string[]; runs: Record<string, { messageId: string; startedAt: string; text: string; steps: string[] } | null> }; // [agent]
export type AgentStatus = { connected: boolean; waiting: boolean; lastSeen: string | null; name: string | null; runner?: RunnerStatus | null };
export type Connect = { command: string; args: string[]; env: Record<string, string> } | null;

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/' + path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
  if (!response.ok) throw Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') (el as any)[k.toLowerCase()] = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function toast(text: string, error = false) {
  const t = h('div', { class: 'toast' + (error ? ' err' : ''), role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), error ? 6000 : 2600);
}

export function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Top-down plan of a blockout. Camera sits at the bottom (+z), looking up the page.
export function planSvg(entities: Pick<Entity, 'shape' | 'position' | 'rotation' | 'scale' | 'color' | 'kind'>[], width = 320, height = 200) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'plan');
  svg.setAttribute('aria-hidden', 'true');
  const scale = 9, cx = width / 2, cy = height * 0.58;
  const grid = document.createElementNS(ns, 'g');
  grid.setAttribute('stroke', 'rgba(255,255,255,0.05)');
  for (let x = -20; x <= 20; x += 2) { const l = document.createElementNS(ns, 'line'); l.setAttribute('x1', String(cx + x * scale)); l.setAttribute('x2', String(cx + x * scale)); l.setAttribute('y1', '0'); l.setAttribute('y2', String(height)); grid.append(l); }
  for (let z = -16; z <= 12; z += 2) { const l = document.createElementNS(ns, 'line'); l.setAttribute('y1', String(cy + z * scale)); l.setAttribute('y2', String(cy + z * scale)); l.setAttribute('x1', '0'); l.setAttribute('x2', String(width)); grid.append(l); }
  svg.append(grid);
  const sorted = [...entities].sort((a, b) => (a.kind === 'environment' ? -1 : 0) - (b.kind === 'environment' ? -1 : 0));
  for (const e of sorted) {
    const [w, , d] = entitySize(e as Entity);
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('transform', `translate(${cx + e.position[0] * scale} ${cy + e.position[2] * scale}) rotate(${-e.rotation})`);
    const shape = SHAPES[e.shape] ? e.shape : 'box';
    const round = ['person', 'sphere', 'cylinder', 'tree', 'lamp', 'rock'].includes(shape);
    const r = document.createElementNS(ns, round ? 'ellipse' : 'rect');
    if (round) { r.setAttribute('rx', String(Math.max(2.5, (w * scale) / 2))); r.setAttribute('ry', String(Math.max(2.5, (d * scale) / 2))); }
    else { r.setAttribute('x', String((-w * scale) / 2)); r.setAttribute('y', String((-d * scale) / 2)); r.setAttribute('width', String(w * scale)); r.setAttribute('height', String(Math.max(2, d * scale))); r.setAttribute('rx', '1.5'); }
    r.setAttribute('fill', e.color);
    r.setAttribute('fill-opacity', e.kind === 'environment' ? '0.35' : '0.9');
    r.setAttribute('stroke', 'rgba(255,255,255,0.25)');
    g.append(r);
    if (shape === 'person' || shape === 'car') { const n = document.createElementNS(ns, 'line'); n.setAttribute('x1', '0'); n.setAttribute('y1', '0'); n.setAttribute('x2', '0'); n.setAttribute('y2', String((d * scale) / 2 + 4)); n.setAttribute('stroke', '#fff'); n.setAttribute('stroke-opacity', '.7'); g.append(n); }
    svg.append(g);
  }
  const cam = document.createElementNS(ns, 'path');
  cam.setAttribute('d', `M${cx} ${height - 10} l-7 -10 h14 z`);
  cam.setAttribute('fill', '#ffb547');
  svg.append(cam);
  return svg;
}

export const SHAPE_ICONS: Record<string, string> = {
  person: '<circle cx="12" cy="6" r="3"/><path d="M7 21v-6a5 5 0 0 1 10 0v6"/>',
  car: '<path d="M3 15h18v-3l-3-5H7l-4 5z"/><circle cx="7.5" cy="16.5" r="1.8"/><circle cx="16.5" cy="16.5" r="1.8"/>',
  box: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
  table: '<path d="M3 9h18M6 9v10M18 9v10"/>',
  chair: '<path d="M7 3v18M7 12h10v9M7 12h10"/>',
  sphere: '<circle cx="12" cy="12" r="7"/>',
  cylinder: '<ellipse cx="12" cy="6" rx="6" ry="2.5"/><path d="M6 6v12c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V6"/>',
  lamp: '<path d="M12 21V6M8 6h8M12 3v3"/>',
  building: '<rect x="6" y="3" width="12" height="18"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>',
  wall: '<rect x="3" y="8" width="18" height="8"/>',
  tree: '<path d="M12 3l6 11H6z"/><path d="M12 14v7"/>',
  rock: '<path d="M4 18l3-8 5-3 6 4 2 7z"/>',
};
export function shapeIcon(shape: string) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.6'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('stroke-linecap', 'round');
  s.innerHTML = SHAPE_ICONS[shape] || SHAPE_ICONS.box;
  return s;
}

export function agentPill(status: AgentStatus | null, onClick: () => void) {
  const pill = h('button', { class: 'pill' + (status?.connected ? ' on' : ''), type: 'button', title: 'Connect an agent over MCP', onclick: onClick }, h('span', { class: 'dot' }), status?.connected ? `Agent connected${status.name ? ` · ${status.name}` : ''}` : 'Agent: not connected');
  return pill;
}

const quote = (s: string) => (/^[\w./:@=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
export function connectDialog(status: AgentStatus | null, connect: Connect) {
  const old = document.getElementById('connect-dialog'); old?.remove();
  const claude = connect ? `claude mcp add comfy-previs -e PREVIS_URL=${connect.env.PREVIS_URL} -- ${quote(connect.command)} ${connect.args.map(quote).join(' ')}` : 'Start the Previs server first.';
  const json = connect ? JSON.stringify({ mcpServers: { 'comfy-previs': { command: connect.command, args: connect.args, env: connect.env } } }, null, 2) : '';
  const ask = 'Use the comfy-previs MCP tools to direct my Previs scene. Loop: call previs_director_wait_for_direction; read the project with previs_director_get; post a short previs_director_progress line before each step; make changes with previs_director_edit and previs_director_animate (keyframes); then previs_director_reply with what changed, and wait again. Keep going until I say stop in Previs.';
  const code = (text: string) => { const b = h('button', { class: 'btn sm', type: 'button' }, 'Copy'); const box = h('div', { class: 'code' }, text, b); b.onclick = async () => { await navigator.clipboard.writeText(text).catch(() => {}); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1400); }; return box; };
  const dlg = h('dialog', { id: 'connect-dialog', 'aria-labelledby': 'connect-title' },
    h('div', { class: 'dialog-head' }, h('h2', { id: 'connect-title' }, 'Connect your agent'), agentPill(status, () => {}), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'dialog-body' },
      h('p', { class: 'muted', style: 'margin:0' }, status?.runner?.available ? 'The built-in agent is ready: Previs runs Claude Code on this Mac with Previs tools only, on your existing login. You only need the steps below to use a different agent (Codex, another MCP client) instead.' : 'Install Claude Code and sign in once (run “claude” in a terminal) for the built-in agent. Or connect your own coding agent (Claude Code, Codex, any MCP client) over MCP: it reads the chat, edits the blockout, shots and camera, and replies here. Without an agent, a built-in parser handles simple directions.'),
      h('ol', {},
        h('li', {}, h('b', {}, 'Add the MCP server'), ' (Claude Code):', code(claude), h('details', {}, h('summary', { class: 'muted', style: 'cursor:pointer;margin-top:6px' }, 'Other MCP clients (JSON)'), code(json))),
        h('li', {}, h('b', {}, 'Ask your agent to listen'), code(ask)),
        h('li', {}, h('b', {}, 'Type direction here'), ' — the pill turns green while the agent is listening. Messages wait for it; you can hand any message to the built-in parser instead.'),
      ),
      h('p', { class: 'note', style: 'margin:0' }, 'Loopback only. Direction tools cannot submit renders or paid generations.'),
    ));
  document.body.append(dlg);
  dlg.showModal();
}

export function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error || Error('Could not read file'));
    r.readAsDataURL(file);
  });
}
