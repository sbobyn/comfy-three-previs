// Read-only demo shim (VITE_DEMO builds only). Serves GET /api/* from static
// JSON snapshots, rewrites media and page URLs under the deploy base, and
// answers every write with a friendly 403 so the UI shows a toast.
const BASE = import.meta.env.BASE_URL; // e.g. /comfy-three-previs/
const DATA = BASE + 'demo-data/';
const MEDIA = BASE + 'demo-media/';
const REPO = 'https://github.com/sbobyn/comfy-three-previs';
const READ_ONLY = 'This is a read-only demo — run Comfy Previs locally to edit and generate.';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const AGENT = { agent: { connected: false, waiting: false, lastSeen: null, name: null, runner: { available: false, model: '', busy: [], runs: {} } }, connect: null };

/** Root-relative app URL → URL under the deploy base. Leaves everything else alone. */
function rewrite(url: string): string {
  if (!url.startsWith('/') || url.startsWith('//') || url.startsWith(BASE)) return url;
  if (/^\/(assets\/[\w-]+\.(mp4|webm|mov|png)|director-refs\/|director-refgen\/|director-assets\/|renders\/)/.test(url)) return MEDIA + url.slice(1);
  // The old camera studio (index.html) is gone; its links go to the home page.
  if (url === '/index.html' || url.startsWith('/index.html?')) return BASE + url.slice(11);
  if (url === '/' || /^\/[\w-]+\.html/.test(url)) return BASE + (url === '/' ? '' : url.slice(1));
  return url;
}

async function apiGet(path: string, q: URLSearchParams): Promise<Response> {
  const file = async (name: string, fallback?: unknown) => {
    const r = await realFetch(DATA + name);
    return r.ok ? json(await r.json()) : fallback !== undefined ? json(fallback) : json({ error: 'Not part of this demo.' }, 404);
  };
  switch (path) {
    case 'director/projects': return file('projects.json', { projects: [] });
    case 'director/project': {
      // Live-sync polls pass `since`: nothing ever changes in the demo.
      if (q.has('since')) return json({ agent: AGENT.agent });
      return file(`project-${q.get('id')}.json`);
    }
    // The home's cards: the current starters, each paired with the finished project it opens (snapshot-demo.mjs).
    case 'director/starters': return file('starters.json', { starters: [] });
    case 'director/refgen': return file(`refgen-${q.get('projectId')}.json`, { presets: [], jobs: [] });
    case 'director/assets': return file(`assets-${q.get('id')}.json`, { assets: [] });
    case 'director/setup': return file('setup.json', { ready: true, checks: [] });
    case 'director/agent': return json(AGENT);
    case 'director/archived': return json({ projects: [] });
    case 'director/refgen/checkpoints': return json({ checkpoints: [], error: 'Local ComfyUI is not available in the read-only demo.' });
    case 'generation': return file('generation.json', { presets: [], definitions: [], jobs: [] });
    default: return json({ error: READ_ONLY }, 404);
  }
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, location.href);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return json({ error: READ_ONLY }, 403);
    return apiGet(url.pathname.slice(5), url.searchParams);
  }
  return realFetch(typeof input === 'string' ? rewrite(input) : input, init);
};

// No live agent stream in the demo: a quiet EventSource that never connects.
class DemoEventSource extends EventTarget {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSED = 2;
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSED = 2;
  readyState = 2; url: string; withCredentials = false;
  onopen: ((e: Event) => void) | null = null; onmessage: ((e: MessageEvent) => void) | null = null; onerror: ((e: Event) => void) | null = null;
  constructor(url: string | URL) { super(); this.url = String(url); }
  close() {}
}
const RealEventSource = window.EventSource;
(window as any).EventSource = function (url: string | URL, init?: EventSourceInit) {
  return String(url).startsWith('/api/') ? new DemoEventSource(url) : new RealEventSource(url, init);
};

// Media and page links: patch src/href setters and setAttribute.
for (const [proto, prop] of [[HTMLImageElement.prototype, 'src'], [HTMLMediaElement.prototype, 'src'], [HTMLSourceElement.prototype, 'src'], [HTMLAnchorElement.prototype, 'href']] as const) {
  const d = Object.getOwnPropertyDescriptor(proto, prop)!;
  Object.defineProperty(proto, prop, { ...d, set(v: string) { d.set!.call(this, rewrite(String(v))); } });
}
const setAttr = Element.prototype.setAttribute;
Element.prototype.setAttribute = function (name: string, value: string) {
  setAttr.call(this, name, (name === 'src' || name === 'href' || name === 'poster') ? rewrite(String(value)) : value);
};

// Pages with their own header badge (home, workspace) get no floating banner. Elsewhere the banner sits at the
// top right, out of the way of transports and tab bars, and can be dismissed.
function banner(tries = 0) {
  const own = document.querySelector<HTMLElement>('.demo-badge');
  if (own && own.offsetParent) return;
  // Pages that fetch before drawing (the home page) add their own badge a little later: wait for it before doubling up.
  if (tries < 8) { setTimeout(() => banner(tries + 1), 250); return; }
  const bar = document.createElement('div');
  bar.setAttribute('role', 'note'); bar.className = 'demo-banner';
  bar.style.cssText = 'position:fixed;right:12px;top:calc(56px + env(safe-area-inset-top, 0px));z-index:2147483647;display:flex;gap:8px;align-items:center;padding:6px 6px 6px 12px;border-radius:999px;background:rgba(17,17,20,.86);color:#f2f2f5;font:500 12px/1.3 system-ui,-apple-system,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(8px);pointer-events:auto;white-space:nowrap';
  // Phones: a short pill beside the view switch rather than over it.
  const narrow = innerWidth < 700;
  const link = document.createElement('a'); link.href = REPO; link.target = '_blank'; link.rel = 'noopener'; link.textContent = narrow ? 'Demo ↗' : 'Read-only demo · Run it locally ↗';
  link.title = 'Read-only demo. Run Comfy Previs locally to edit and generate.';
  link.style.cssText = 'color:#f2f2f5;text-decoration:none;font-weight:600';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '✕'; close.setAttribute('aria-label', 'Hide the demo notice');
  close.style.cssText = 'border:0;background:rgba(255,255,255,.14);color:#f2f2f5;border-radius:999px;width:22px;height:22px;cursor:pointer;font-size:11px';
  close.onclick = () => bar.remove();
  if (narrow) { bar.style.padding = '6px 12px'; bar.style.right = '64px'; } // clear of the viewport's corner button
  bar.append(link, ...(narrow ? [] : [close]));
  document.body.append(bar);
}
// After the page has built its header (a module script runs before the app's own code).
if (document.readyState === 'complete') setTimeout(banner, 300); else addEventListener('load', () => setTimeout(banner, 300));

export {};
