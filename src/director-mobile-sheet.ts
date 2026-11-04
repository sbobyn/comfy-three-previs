// Bottom sheets for the mobile layer: panel (non-modal, detents), task (modal <dialog>, full) and action sheets.
import { h } from './director-common';
import { nextDetent, rubber } from './director-mobile-core';
import type { Detent } from './director-mobile-core';

export type SheetKind = 'panel' | 'task' | 'action';
export type Sheet = { el: HTMLElement; body: HTMLElement; head: HTMLElement; setDetent(d: Detent): void; detent(): Detent; setTitle(t: string): void; close(): void; closed(): boolean };
type Opts = { title: string; kind: SheetKind; detent?: Detent; body?: Node | Node[]; foot?: Node[]; onClose?: () => void; cls?: string; aside?: Node | null; host?: HTMLElement };

const stack: Sheet[] = [];
export const openSheets = () => stack.length;
export const topSheet = () => stack.at(-1) || null;
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const docked = () => document.body.classList.contains('m-medium');
// Back-stack: while any sheet is open there is one extra history entry, so the OS back gesture closes the top sheet.
// director.ts rewrites the URL with replaceState; keep the newest URL so popping never brings back an older ?view=/&shot=.
let popping = false, ignorePops = 0, pushed = false, latest = location.href;
const replace = history.replaceState.bind(history);
/** Called once by the mobile layer (never on desktop). */
export function installSheetHistory() {
  history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => { replace(data, unused, url); latest = location.href; };
  addEventListener('popstate', () => {
    if (location.href !== latest) replace(history.state, '', latest);
    if (ignorePops) { ignorePops--; return; }
    pushed = false;
    const s = topSheet(); if (s) { popping = true; s.close(); popping = false; }
    if (stack.length) { pushed = true; history.pushState({ mSheet: 1 }, '', latest); }
  });
  // Keep the focused field above the keyboard: the open sheet never exceeds the visual viewport.
  visualViewport?.addEventListener('resize', () => { const s = topSheet(); if (s) s.el.style.setProperty('--m-vvh', `${Math.round(visualViewport!.height)}px`); });
}
// One sheet often replaces another in the same task (Scene → Object): only drop the entry once none is open.
const unpush = () => setTimeout(() => { if (!stack.length && pushed) { pushed = false; ignorePops++; history.back(); } }, 0);
const syncDock = () => document.body.classList.toggle('m-docked', stack.some(s => s.el.classList.contains('m-panel')));
export function openSheet(o: Opts): Sheet {
  const modal = o.kind !== 'panel';
  const title = h('h2', {}, o.title);
  const closeBtn = h('button', { class: 'm-ib m-sheet-x', type: 'button', 'aria-label': 'Close' }, icon('close'));
  const head = h('div', { class: 'm-sheet-head' }, title, o.aside || null, o.kind === 'action' ? null : closeBtn);
  const body = h('div', { class: 'm-sheet-body' }, ...(Array.isArray(o.body) ? o.body : o.body ? [o.body] : []));
  const grab = h('div', { class: 'm-grab', 'aria-hidden': 'true' });
  const foot = o.foot?.length ? h('div', { class: 'm-sheet-foot' }, ...o.foot) : null;
  const el = h(modal ? 'dialog' : 'section', { class: `m-sheet m-${o.kind}${o.cls ? ' ' + o.cls : ''}`, 'aria-label': o.title, role: modal ? null : 'dialog' }, grab, head, body, foot);
  const scrim = modal ? null : h('div', { class: 'm-scrim', 'aria-hidden': 'true' });
  let detent: Detent = o.detent || (o.kind === 'panel' ? 'half' : 'full'), isClosed = false;
  const opener = document.activeElement as HTMLElement | null;
  const setDetent = (d: Detent) => { detent = d; el.dataset.detent = d; el.style.removeProperty('--m-drag'); scrim?.classList.toggle('m-light', d !== 'full'); navigator.vibrate?.(8); };
  const close = () => {
    if (isClosed) return; isClosed = true;
    stack.splice(stack.indexOf(api), 1);
    el.classList.remove('m-open'); scrim?.classList.remove('m-open');
    const done = () => { el.remove(); scrim?.remove(); };
    if (reduce() || !el.isConnected) done(); else setTimeout(done, 220);
    if (modal) { try { (el as HTMLDialogElement).close(); } catch {} }
    if (!popping) unpush();
    syncDock(); o.onClose?.();
    if (opener?.isConnected && !document.querySelector('.m-sheet.m-open')) opener.focus?.({ preventScroll: true });
  };
  const api: Sheet = { el, body, head, setDetent, detent: () => detent, setTitle: t => { title.textContent = t; el.setAttribute('aria-label', t); }, close, closed: () => isClosed };
  closeBtn.onclick = close;
  setDetent(detent);
  if (modal) {
    el.addEventListener('cancel', ev => { ev.preventDefault(); close(); });
    el.addEventListener('click', ev => { if (ev.target === el) { const r = el.getBoundingClientRect(); const e = ev as MouseEvent; if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) close(); } });
    document.body.append(el); (el as HTMLDialogElement).showModal();
  } else {
    scrim!.onclick = close;
    (o.host || document.getElementById('app')!).append(scrim!, el);
    el.addEventListener('keydown', ev => { if ((ev as KeyboardEvent).key === 'Escape') { ev.stopPropagation(); close(); } });
  }
  stack.push(api); syncDock();
  if (!pushed) { pushed = true; history.pushState({ mSheet: 1 }, '', latest); }
  requestAnimationFrame(() => { el.classList.add('m-open'); scrim?.classList.add('m-open'); if (modal) (el.querySelector('.m-sheet-body button, .m-sheet-body [href], .m-sheet-body input, .m-sheet-body select') as HTMLElement | null)?.focus({ preventScroll: true }); });
  dragToDetent(api, grab, head, body, o.kind === 'panel' && !docked());
  return api;
}

/** Drag the grab handle (or the body when scrolled to the top) between detents; velocity flicks one detent. */
function dragToDetent(s: Sheet, grab: HTMLElement, head: HTMLElement, body: HTMLElement, detents: boolean) {
  let start: { y: number; t: number; h: number; id: number } | null = null, lastY = 0, lastT = 0, vy = 0;
  const down = (ev: PointerEvent) => {
    if (ev.target instanceof HTMLElement && ev.target.closest('button,input,select,textarea,a,video,[role=slider]')) return;
    if (ev.currentTarget === body && body.scrollTop > 0) return;
    start = { y: ev.clientY, t: performance.now(), h: s.el.getBoundingClientRect().height, id: ev.pointerId }; lastY = ev.clientY; lastT = start.t; vy = 0;
  };
  const move = (ev: PointerEvent) => {
    if (!start || ev.pointerId !== start.id) return;
    const dy = ev.clientY - start.y;
    if (Math.abs(dy) < 6) return;
    if ((ev.currentTarget as HTMLElement) === body && dy < 0 && s.detent() === 'full') { start = null; return; } // let the body scroll
    (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
    const now = performance.now(); vy = (ev.clientY - lastY) / Math.max(1, now - lastT); lastY = ev.clientY; lastT = now;
    const max = innerHeight - 56, want = start.h - dy;
    s.el.style.setProperty('--m-drag', `${Math.round(want > max ? max + rubber(want - max) : Math.max(0, want))}px`);
    s.el.classList.add('m-dragging');
  };
  const up = (ev: PointerEvent) => {
    if (!start || ev.pointerId !== start.id) return;
    const dy = ev.clientY - start.y; start = null; s.el.classList.remove('m-dragging');
    if (Math.abs(dy) < 6) { s.el.style.removeProperty('--m-drag'); return; }
    const H = innerHeight;
    const next = detents ? nextDetent(s.detent(), dy, vy, { peek: 170, half: H * 0.52, full: H - 56 }) : (dy > 120 || vy > 0.5 ? null : s.detent());
    if (next) s.setDetent(next); else s.close();
  };
  for (const el of [grab, head, body]) { el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); }
}

export type ActionItem = { label: string; icon?: string; destructive?: boolean; disabled?: boolean; onPick: () => void };
/** Bottom list of 52 pt rows plus Cancel. */
export function actionSheet(title: string, items: ActionItem[]) {
  let s: Sheet;
  const rows = items.map(it => h('button', { class: 'm-act-row' + (it.destructive ? ' m-bad' : ''), type: 'button', disabled: !!it.disabled, onclick: () => { s.close(); it.onPick(); } }, it.icon ? icon(it.icon) : null, h('span', {}, it.label)));
  s = openSheet({ title, kind: 'action', body: rows, foot: [h('button', { class: 'm-btn m-block', type: 'button', onclick: () => s.close() }, 'Cancel')] });
  return s;
}
/** Confirmation as an action sheet; resolves true on confirm. */
export function confirmSheet(o: { title: string; body: string; confirm: string; destructive?: boolean }): Promise<boolean> {
  return new Promise(resolve => {
    let ok = false;
    const s = openSheet({ title: o.title, kind: 'action', body: h('p', { class: 'm-note' }, o.body), onClose: () => resolve(ok),
      foot: [h('button', { class: 'm-btn', type: 'button', onclick: () => s.close() }, 'Cancel'), h('button', { class: 'm-btn ' + (o.destructive ? 'm-danger' : 'm-primary'), type: 'button', onclick: () => { ok = true; s.close(); } }, o.confirm)] });
  });
}

// 24-grid stroke icons (from the mockups' _icons.svg).
const PATHS: Record<string, string> = {
  back: '<path d="M15 5l-7 7 7 7"/>', more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  undo: '<path d="M9 7L5 11l4 4"/><path d="M5 11h9a5 5 0 0 1 0 10h-3"/>', redo: '<path d="M15 7l4 4-4 4"/><path d="M19 11h-9a5 5 0 0 0 0 10h3"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', build: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  shoot: '<rect x="3" y="6.5" width="13" height="11" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3"/>', cut: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9.5h18M3 14.5h18M8 5v14M16 5v14"/>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/>', frame: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>', play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  library: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  claude: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/>', guide: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>', download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', tips: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>', trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  dup: '<rect x="8" y="8" width="12" height="12" rx="2"/><rect x="4" y="4" width="12" height="12" rx="2"/>', grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor"/><circle cx="15" cy="6" r="1.3" fill="currentColor"/><circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/><circle cx="9" cy="18" r="1.3" fill="currentColor"/><circle cx="15" cy="18" r="1.3" fill="currentColor"/>',
  chev: '<path d="M9 5l7 7-7 7"/>', down: '<path d="M6 9l6 6 6-6"/>', move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  twist: '<path d="M5 12a7 7 0 1 1 3 5.7"/><path d="M5 17v-5h5"/>', pinch: '<path d="M4 4l6 6M20 20l-6-6M4 4v5M4 4h5M20 20v-5M20 20h-5"/>',
};
export function icon(name: string) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('fill', 'none'); el.setAttribute('stroke', 'currentColor'); el.setAttribute('stroke-width', '2');
  el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round'); el.setAttribute('aria-hidden', 'true');
  el.innerHTML = PATHS[name] || '';
  return el;
}
