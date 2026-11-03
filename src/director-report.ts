// "Report a problem": a small ring buffer of recent errors (installed when this module loads, at boot), and a dialog
// that previews exactly what a prefilled GitHub issue will contain. Nothing is sent: the user submits it on GitHub.
import { diagnosticsText, issueBody, issueUrl, pathOnly, sanitize } from '../shared/report-issue.mjs';
import { h, DEMO } from './director-common';

declare const __PREVIS_VERSION__: string, __PREVIS_COMMIT__: string;
const recent: string[] = [];
const note = (line: string) => { recent.push(`${new Date().toISOString().slice(11, 19)} ${sanitize(line).slice(0, 300)}`); if (recent.length > 10) recent.shift(); };
const text = (v: unknown) => v instanceof Error ? `${v.name}: ${v.message}` : typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();

if (!(window as any).__previsReportBuffer) {
  (window as any).__previsReportBuffer = recent;
  const error = console.error.bind(console);
  console.error = (...args: unknown[]) => { note(`console.error ${args.map(text).join(' ')}`); error(...args); };
  addEventListener('error', ev => note(`error ${ev.message || text(ev.error)}${ev.filename ? ` (${pathOnly(ev.filename)}:${ev.lineno})` : ''}`));
  addEventListener('unhandledrejection', ev => note(`unhandled rejection ${text(ev.reason)}`));
  const fetch0 = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const path = pathOnly(input instanceof Request ? input.url : String(input));
    try { const r = await fetch0(input, init); if (!r.ok) note(`request ${method} ${path} → ${r.status}`); return r; }
    catch (e) { note(`request ${method} ${path} → failed (${text(e)})`); throw e; }
  };
}

/** What goes in the Diagnostics block: ids only, never project names or content. */
export function diagnostics() {
  const q = new URLSearchParams(location.search), root = document.documentElement;
  const version = typeof __PREVIS_VERSION__ === 'string' ? __PREVIS_VERSION__ : 'unknown';
  const commit = typeof __PREVIS_COMMIT__ === 'string' && __PREVIS_COMMIT__ ? ` (${__PREVIS_COMMIT__})` : '';
  return diagnosticsText({
    'App': `Comfy Previs ${version}${commit} · ${DEMO ? 'read-only web demo' : 'local'}`,
    'Browser': navigator.userAgent,
    'Screen': `${screen.width}×${screen.height} · window ${innerWidth}×${innerHeight} @${devicePixelRatio}x`,
    'Theme': `${root.dataset.theme || '?'} (setting: ${root.dataset.themePref || '?'})`,
    'View': pathOnly(location.pathname).split('/').pop() || 'start',
    'Project id': q.get('project'),
    'Shot id': q.get('shot'),
  }, recent);
}

/** The dialog: a preview of everything that will be included, then Open GitHub issue or Copy details. */
export function openReport(summary = '') {
  document.getElementById('report-dialog')?.remove();
  const opener = document.activeElement as HTMLElement | null;
  const body = issueBody(diagnostics(), summary), title = summary ? `Bug: ${sanitize(summary).slice(0, 90)}` : 'Bug: ';
  const copy = h('button', { class: 'btn', type: 'button' }, 'Copy details');
  copy.onclick = async () => { try { await navigator.clipboard.writeText(body); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select the text above to copy'; } };
  const dlg = h('dialog', { id: 'report-dialog', class: 'report-dialog', 'aria-labelledby': 'report-title' },
    h('div', { class: 'dialog-head' }, h('h2', { id: 'report-title' }, 'Report a problem'), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'dialog-body' },
      h('p', {}, 'Review these details before opening GitHub. Opening the link shares the prefilled text with GitHub; no issue is submitted until you submit it there.'),
      h('div', { class: 'code-block' }, h('div', { class: 'code-head' }, h('span', { class: 'muted' }, 'What will be included (secrets, emails, query strings and your home folder are removed)')),
        h('textarea', { class: 'code report-preview', readOnly: true, rows: 12, 'aria-label': 'Issue text preview', style: 'width:100%;white-space:pre;font:inherit;resize:vertical' }, body)),
      h('p', { class: 'note' }, 'Long details may be shortened in the GitHub link. Copy details keeps the full bounded preview. Redaction is best-effort: remove anything else you do not want to share. No GitHub account? Paste the copied details in Discord or an email instead.'),
      h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap' }, copy,
        h('a', { class: 'btn primary', href: issueUrl(title, body), target: '_blank', rel: 'noopener', onclick: () => dlg.close() }, 'Open GitHub issue ↗'))));
  dlg.addEventListener('keydown', ev => ev.stopPropagation());
  dlg.addEventListener('close', () => { dlg.remove(); if (opener?.isConnected) opener.focus(); });
  document.body.append(dlg); dlg.showModal();
}

/** A footer link that opens the dialog. */
export const reportLink = (cls = 'home-link') => h('button', { class: cls, type: 'button', onclick: () => openReport() }, 'Report a problem');
