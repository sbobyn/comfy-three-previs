// [agent] Built-in agent experience for the Direct tab: the status pill, the live "thinking" block
// (steps + streaming reply over SSE), answer actions (Copy, Use as shot prompt), the proposal card
// (Apply / Discard / Undo through the app's undo stack) and error + Retry. Styles: director-agent.css.
import './director-agent.css';
import type { DirectorProject, Message, Shot } from '../shared/director.mjs';
import type { UndoEntry } from '../shared/editor-controls.mjs';
import { api, h, toast } from './director-common';
import type { AgentStatus } from './director-common';

export type Route = 'auto' | 'runner' | 'agent' | 'builtin';
export const ROUTES: { value: Route; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Built-in agent when Claude Code is installed; otherwise a connected MCP agent, else the parser' },
  { value: 'runner', label: 'Built-in agent', title: 'Claude Code on this Mac, run by Previs with Previs tools only' },
  { value: 'agent', label: 'Your agent (MCP)', title: 'Your own Claude Code / Codex session connected over MCP' },
  { value: 'builtin', label: 'Parser', title: 'Offline phrase parser; no model' },
];

type Ctx = {
  projectId: string;
  project(): DirectorProject;
  apply(p: DirectorProject): void;
  runEntry(e: UndoEntry): Promise<boolean>;
  pushUndo(e: UndoEntry): void;
  refresh(): Promise<void>;
  resend(text: string, shotId: string | null): void;
  selectShot(id: string): void;
};
type Live = { text: string; steps: string[] };
const KIND_ICON: Record<string, string> = { add: '＋', change: '✎', remove: '－', camera: '◎', animate: '◆', prompt: '¶', scene: '⌂' };
const AUTO_KEY = 'previs.agent.autoApply';

/** Light formatting for agent replies: paragraphs, bullets, **bold**, `code`. DOM-built, never innerHTML. */
export function agentText(text: string, mention: (s: string) => Node) {
  const root = h('div', { class: 'body ag-body' });
  const inline = (line: string) => {
    const frag = document.createDocumentFragment();
    for (const part of line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
      if (!part) continue;
      if (part.startsWith('**') && part.endsWith('**')) frag.append(h('b', {}, part.slice(2, -2)));
      else if (part.startsWith('`') && part.endsWith('`')) frag.append(h('code', {}, part.slice(1, -1)));
      else frag.append(mention(part));
    }
    return frag;
  };
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter(l => l.trim());
    if (!lines.length) continue;
    if (lines.every(l => /^\s*[-*•]\s+/.test(l))) root.append(h('ul', {}, ...lines.map(l => h('li', {}, inline(l.replace(/^\s*[-*•]\s+/, ''))))));
    else if (lines.every(l => /^\s*\d+[.)]\s+/.test(l))) root.append(h('ol', {}, ...lines.map(l => h('li', {}, inline(l.replace(/^\s*\d+[.)]\s+/, ''))))));
    else { const p = h('p', {}); lines.forEach((l, i) => { if (i) p.append(h('br')); p.append(inline(l.replace(/^#+\s*/, ''))); }); root.append(p); }
  }
  return root;
}

export function createAgentUi(ctx: Ctx) {
  const live = new Map<string, Live>();
  const nodes = new Map<string, { steps: HTMLElement; text: HTMLElement; wrap: HTMLElement }>();
  const attempted = new Set<string>();
  const used = new Set<string>();
  let source: EventSource | null = null;
  const autoApply = () => localStorage.getItem(AUTO_KEY) !== '0';

  // ---- live stream ----
  function paint(messageId: string) {
    const n = nodes.get(messageId), l = live.get(messageId); if (!n || !l) return;
    n.steps.replaceChildren(...l.steps.slice(-8).map((s, i, a) => h('li', { class: i === a.length - 1 ? 'live' : '' }, s)));
    n.text.textContent = l.text; n.text.hidden = !l.text;
    n.wrap.classList.toggle('has-text', !!l.text);
  }
  function connect() {
    source?.close();
    source = new EventSource(`/api/director/agent/stream?id=${ctx.projectId}`);
    source.onmessage = ev => {
      let e: any; try { e = JSON.parse(ev.data); } catch { return; }
      if (e.type === 'state') { live.clear(); if (e.run) live.set(e.run.messageId, { text: e.run.text || '', steps: e.run.steps || [] }); return; }
      if (e.type === 'start') { live.set(e.messageId, { text: '', steps: [] }); void ctx.refresh(); return; }
      const l = live.get(e.messageId) || live.set(e.messageId, { text: '', steps: [] }).get(e.messageId)!;
      if (e.type === 'step') { l.steps.push(e.text); paint(e.messageId); }
      else if (e.type === 'text') { if (e.reset) l.text = ''; if (e.delta) l.text += e.delta; paint(e.messageId); }
      else if (e.type === 'done' || e.type === 'error') { live.delete(e.messageId); nodes.delete(e.messageId); void ctx.refresh(); }
    };
  }

  // ---- pill ----
  function pill(status: AgentStatus | null, onConnect: () => void) {
    const r = status?.runner;
    const busy = !!r?.busy?.includes(ctx.projectId);
    const state = busy ? 'busy' : r?.available ? 'ready' : status?.connected ? 'external' : 'off';
    const label = state === 'busy' ? 'Agent working…' : state === 'ready' ? 'Agent ready' : state === 'external' ? `Agent connected${status?.name ? ` · ${status.name}` : ''}` : 'Agent: parser only';
    const title = state === 'ready' ? `Built-in agent: Claude Code on this Mac (${r?.model || 'default model'}) · click for other ways to connect` : state === 'busy' ? 'The built-in agent is working on your last message' : state === 'external' ? 'Your own agent is listening over MCP' : 'Claude Code is not installed; click to connect an agent over MCP';
    return h('button', { class: `pill ag-pill ${state}` + (state === 'off' ? '' : ' on'), type: 'button', title, onclick: onConnect }, h('span', { class: 'dot' }), label);
  }
  function routeNote(mode: Route, status: AgentStatus | null) {
    const r = status?.runner?.available;
    if (mode === 'runner') return r ? '→ built-in agent' : '→ built-in agent (Claude Code not installed)';
    if (mode === 'agent') return status?.connected ? '→ your agent' : '→ your agent (not connected; will wait)';
    if (mode === 'builtin') return '→ parser';
    return r ? '→ built-in agent' : status?.connected ? '→ your agent' : '→ parser (no agent)';
  }

  // ---- cards ----
  const shotOf = (id: string | null) => ctx.project().shots.find(s => s.id === id) || null;
  const shotNo = (s: Shot) => String(ctx.project().shots.indexOf(s) + 1).padStart(2, '0');

  async function decide(m: Message, action: 'apply' | 'discard' | 'undo', quiet = false) {
    const pr = m.proposal!;
    try {
      const r = await api('director/agent/proposal', { projectId: ctx.projectId, messageId: m.id, action });
      ctx.apply(r.project);
      const label = pr.summary.length === 1 ? pr.summary[0].text : `${pr.summary.length} agent changes`;
      if (action === 'apply') { ctx.pushUndo({ label, redo: pr.ops, undo: pr.undo }); if (!quiet) toast(`Applied · ${label}`); else toast(`Applied: ${label} · Undo with ⌘Z`); }
      if (action === 'undo') { ctx.pushUndo({ label: `Undo ${label}`, redo: pr.undo, undo: pr.ops }); toast('Undone'); }
    } catch (e) { toast((e as Error).message, true); }
  }

  function proposalCard(m: Message) {
    const pr = m.proposal; if (!pr?.ops?.length) return null;
    const n = pr.summary.length;
    const list = h('ul', { class: 'ag-changes' }, ...pr.summary.map(s => h('li', { class: `k-${s.kind}` }, h('i', { 'aria-hidden': 'true' }, KIND_ICON[s.kind] || '•'), s.text)));
    let foot: Node;
    if (pr.status === 'pending') {
      const auto = h('label', { class: 'ag-auto', title: 'One-line changes to an existing object or shot apply straight away, with Undo' }, h('input', { type: 'checkbox', checked: autoApply(), onchange: (ev: Event) => localStorage.setItem(AUTO_KEY, (ev.target as HTMLInputElement).checked ? '1' : '0') }), 'Auto-apply one-line changes');
      foot = h('div', { class: 'ag-foot' },
        h('button', { class: 'btn sm primary', type: 'button', onclick: () => void decide(m, 'apply') }, 'Apply'),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => void decide(m, 'discard') }, 'Discard'),
        pr.small ? auto : h('span', { class: 'note' }, 'One undo step'));
    } else if (pr.status === 'applied') foot = h('div', { class: 'ag-foot' }, h('span', { class: 'ag-state ok' }, '✓ Applied'), h('button', { class: 'btn sm ghost', type: 'button', onclick: () => void decide(m, 'undo') }, 'Undo'));
    else foot = h('div', { class: 'ag-foot' }, h('span', { class: 'ag-state' }, pr.status === 'undone' ? 'Undone' : 'Discarded'));
    return h('div', { class: `ag-card proposal is-${pr.status}` },
      h('div', { class: 'ag-head' }, h('span', { class: 'ag-title' }, pr.status === 'pending' ? 'Proposed changes' : 'Changes'), h('span', { class: 'ag-count' }, `${n}`)),
      list, foot);
  }

  function suggestionRow(m: Message, replyText: string) {
    const s = m.suggestion; const shot = s ? shotOf(s.shotId) : null;
    const copy = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => void navigator.clipboard.writeText(s?.text || replyText).then(() => toast('Copied')) }, 'Copy');
    if (!s || !shot) return h('div', { class: 'ag-actions' }, copy);
    const done = used.has(m.id) || !!(shot.prompts?.[s.kind]?.edited && shot.prompts[s.kind]!.text === s.text);
    const use = h('button', { class: 'btn sm' + (done ? '' : ' primary'), type: 'button', disabled: done, title: `Write this as shot ${shotNo(shot)}’s ${s.kind} prompt (undoable)` }, done ? `✓ Used as shot ${shotNo(shot)} ${s.kind} prompt` : `Use as shot ${shotNo(shot)} ${s.kind} prompt`);
    use.onclick = async () => {
      const before = shot.prompts?.[s.kind] ?? null;
      const ok = await ctx.runEntry({ label: 'Use agent prompt', redo: [{ op: 'update_shot', id: shot.id, patch: { prompts: { [s.kind]: { text: s.text, edited: true, basedOn: '', editedAt: new Date().toISOString() } } } }], undo: [{ op: 'update_shot', id: shot.id, patch: { prompts: { [s.kind]: before } } }] });
      if (ok) { used.add(m.id); toast(`Shot ${shotNo(shot)} ${s.kind} prompt set · undo with ⌘Z`); ctx.selectShot(shot.id); }
    };
    return h('div', { class: 'ag-actions' }, use, copy);
  }

  function thinking(m: Message) {
    const l = live.get(m.id);
    const steps = l?.steps.length ? l.steps : (m.activity || []).map(a => a.text);
    const stepsEl = h('ol', { class: 'ag-steps' }, ...steps.slice(-8).map((s, i, a) => h('li', { class: i === a.length - 1 ? 'live' : '' }, s)));
    const textEl = h('div', { class: 'ag-stream', hidden: !l?.text }, l?.text || '');
    const wrap = h('div', { class: 'ag-card thinking' + (l?.text ? ' has-text' : '') },
      h('div', { class: 'ag-head' }, h('span', { class: 'ag-orb', 'aria-hidden': 'true' }), h('span', { class: 'ag-title' }, 'Thinking'), h('span', { style: 'flex:1' }),
        h('button', { class: 'btn sm ghost', type: 'button', title: 'Stop this turn', onclick: () => void api('director/agent/stop', { projectId: ctx.projectId, messageId: m.id }).then(() => ctx.refresh()).catch(e => toast(e.message, true)) }, 'Stop')),
      stepsEl, textEl);
    nodes.set(m.id, { steps: stepsEl, text: textEl, wrap });
    return wrap;
  }

  /** Extra nodes under a message. User messages: the thinking block while the runner works. Agent replies: actions, cards, errors. */
  function extras(m: Message): Node[] {
    const out: Node[] = [];
    if (m.role === 'user') {
      if (m.status === 'claimed' && m.handledBy === 'runner') out.push(thinking(m));
      else if ((m.status as string) === 'queued') out.push(h('div', { class: 'ag-queued', role: 'status' }, 'Queued · starts when the agent finishes the message above'));
      else if (m.status === 'handled' && (m.proposal || m.suggestion) && !ctx.project().messages.some(x => x.replyTo === m.id)) { const c = proposalCard(m); if (c) out.push(c); }
      return out;
    }
    if (m.role !== 'agent') return out;
    const original = m.replyTo ? ctx.project().messages.find(x => x.id === m.replyTo) : null;
    if (m.error) {
      out.push(h('div', { class: 'ag-actions' }, original ? h('button', { class: 'btn sm', type: 'button', onclick: () => ctx.resend(original.text, original.shotId) }, 'Retry') : null, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => void api('director/agent/reset', { projectId: ctx.projectId }).then(() => toast('Agent memory cleared')) }, 'Start fresh')));
      return out;
    }
    if (original) {
      out.push(suggestionRow(original, m.text));
      const pr = original.proposal;
      if (pr?.status === 'pending' && pr.small && autoApply() && !attempted.has(original.id)) { attempted.add(original.id); void decide(original, 'apply', true); }
      const card = proposalCard(original); if (card) out.push(card);
    } else if (m.via === 'runner') out.push(suggestionRow(m, m.text));
    return out;
  }

  return { connect, pill, routeNote, extras, isError: (m: Message) => !!m.error, dispose() { source?.close(); } };
}
