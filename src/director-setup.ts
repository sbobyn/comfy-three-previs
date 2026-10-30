// Setup: what works on this machine, what each key unlocks, and the .env settings.
// Rendered in the home page's Setup dialog and on /setup.html.
import './director-setup.css';
import { api, h } from './director-common';

export type Check = { id: string; label: string; status: 'ok' | 'optional' | 'warn' | 'required'; detail: string; fix: string };
export type Setup = { checks: Check[]; dataDir: string };

const MARK = { ok: '✓', optional: '–', warn: '!', required: '✗' };
/** Checks shown to people; Blender is no longer part of the app. */
export const shownChecks = (checks: Check[]) => checks.filter(c => c.id !== 'blender');

export function checkList(checks: Check[]) {
  return h('ul', { class: 'setup-checks' }, ...shownChecks(checks).map(c => h('li', { class: `s-${c.status}` },
    h('span', { class: 'mk', 'aria-label': c.status }, MARK[c.status]),
    h('span', {}, h('b', {}, c.label), h('small', {}, c.detail, c.status !== 'ok' && c.fix ? ` — ${c.fix}` : '')))));
}

const ENV: [string, string][] = [
  ['COMFY_CLOUD_API_KEY', 'Your Comfy Cloud API key (comfy.org). Enables cost estimates, cast images, stills and video.'],
  ['PREVIS_ALLOW_PAID', 'Set to 1 to allow paid runs. Default 0; every run still shows its cost and needs your approval.'],
  ['PORT', 'Server port. Default 5190.'],
  ['PREVIS_DATA_DIR', 'Where projects are stored. Default .previs/ in the checkout.'],
  ['PREVIS_COMFY_URL', 'A local ComfyUI server, e.g. http://127.0.0.1:8000.'],
  ['PREVIS_FFMPEG, PREVIS_FFPROBE', 'Full paths if FFmpeg is not on your PATH.'],
  ['PREVIS_PHONE_*', 'Phone camera over HTTPS (host, port, certificate, key, CA).'],
];
// What each extra unlocks. `now` reads the live checks.
type Can = { what: string; needs: string; now: (ok: (id: string) => boolean, phone: boolean) => boolean };
const CAN: Can[] = [
  { what: 'Build scenes, frame shots, make blockouts', needs: 'FFmpeg', now: ok => ok('ffmpeg') },
  { what: 'Cut the shots and export the film', needs: 'FFmpeg', now: ok => ok('ffmpeg') },
  { what: 'Cast images and stills', needs: 'Comfy Cloud key or local ComfyUI', now: ok => ok('cloud') || ok('local') },
  { what: 'Generate video', needs: 'Comfy Cloud key, PREVIS_ALLOW_PAID=1', now: ok => ok('cloud') && ok('paid-on') },
  { what: 'Aim the shot camera with your phone', needs: 'Phone HTTPS settings', now: (_ok, phone) => phone },
];

const code = (text: string) => {
  const b = h('button', { class: 'btn sm', type: 'button' }, 'Copy');
  b.onclick = async () => { await navigator.clipboard.writeText(text).catch(() => {}); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1400); };
  return h('div', { class: 'code' }, text, b);
};

export function setupBody(s: Setup | null, phone: { available: boolean } | null) {
  const status = (id: string) => s?.checks.find(c => c.id === id)?.status;
  const ok = (id: string) => id === 'paid-on' ? status('paid') === 'warn' : status(id) === 'ok';
  const cloud = ok('cloud'), local = ok('local');
  return h('div', { class: 'setup' },
    h('section', {}, h('h3', {}, 'This machine'),
      s ? checkList(s.checks) : h('p', { class: 'note' }, 'Could not read the setup checks. Is the server running?'),
      s ? h('p', { class: 'note' }, 'Projects live in ', h('code', {}, s.dataDir), '.') : null),
    h('section', {}, h('h3', {}, 'What you can do'),
      h('table', { class: 'setup-can' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Needs'), h('th', {}, 'Now'))),
        h('tbody', {}, ...CAN.map(c => { const on = !!s && c.now(ok, !!phone?.available); return h('tr', {}, h('th', { scope: 'row' }, c.what), h('td', {}, c.needs), h('td', { class: on ? 'yes' : 'no' }, on ? '✓ Ready' : '–')); }))),
      h('p', { class: 'note' }, 'Every paid run shows its estimated cost first and waits for your approval.')),
    h('section', {}, h('h3', {}, 'Optional'),
      h('dl', { class: 'setup-opt' },
        h('dt', {}, 'Comfy Cloud key', h('span', { class: cloud ? 'ok' : '' }, cloud ? 'Set' : 'Not set')),
        h('dd', {}, 'Create a key at comfy.org, then put it in .env beside package.json and restart. Never paste it into a project or chat.', code('cp .env.example .env\n# then set COMFY_CLOUD_API_KEY=… in .env')),
        h('dt', {}, 'Local ComfyUI', h('span', { class: local ? 'ok' : '' }, local ? 'Reachable' : 'Not reachable')),
        h('dd', {}, 'Run ComfyUI (the desktop app or python main.py). Set PREVIS_COMFY_URL if it is not on port 8000.'),
        h('dt', {}, 'Phone camera over HTTPS', h('span', { class: phone?.available ? 'ok' : '' }, phone?.available ? 'Ready' : 'Not set up')),
        h('dd', {}, 'Make a certificate once, then set the PREVIS_PHONE_* variables and restart. Pair the phone from the workspace’s Phone button.', code('node scripts/phone-certificate.mjs .evidence/phone-tls YOUR_MAC_LAN_IP')))),
    h('section', {}, h('h3', {}, 'Settings (.env)'),
      h('table', { class: 'setup-env' }, h('tbody', {}, ...ENV.map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, h('code', {}, k)), h('td', {}, v))))),
      h('p', { class: 'note' }, 'Shell variables override .env. Restart Comfy Three Previs after changes (pnpm start).')));
}

export async function loadSetup() {
  const [s, phone] = await Promise.all([api<Setup>('director/setup').catch(() => null), api<{ available: boolean }>('phone').catch(() => null)]);
  return setupBody(s, phone);
}

export function openSetup() {
  document.getElementById('setup-dialog')?.remove();
  const body = h('div', { class: 'dialog-body' }, h('p', { class: 'note' }, 'Checking…'));
  const dlg = h('dialog', { id: 'setup-dialog', class: 'setup-dialog', 'aria-labelledby': 'setup-title' },
    h('div', { class: 'dialog-head' }, h('h2', { id: 'setup-title' }, 'Setup'), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
    body);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
  void loadSetup().then(el => body.replaceChildren(el));
}
