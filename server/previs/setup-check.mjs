// Setup checks shared by `pnpm doctor` and the in-app setup checklist.
// Reports presence only; never returns credential values.
import { spawn } from 'node:child_process';
import { access, mkdir, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { openLibrary, libraryDir, LIMITS } from './library.mjs';

function version(cmd, args = ['-version']) {
  return new Promise(resolve => {
    let out = '';
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return resolve(null); }
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', code => resolve(code === 0 ? out.split('\n')[0].trim() : null));
  });
}
const exists = path => access(path, constants.F_OK).then(() => true, () => false);

export async function setupChecks({ root, data, env = process.env, fetcher = fetch } = {}) {
  const checks = [];
  const add = (id, label, status, detail, fix = '') => checks.push({ id, label, status, detail, fix });
  const [major, minor] = process.versions.node.split('.').map(Number);
  add('node', 'Node.js 22.12+', major > 22 || (major === 22 && minor >= 12) ? 'ok' : 'required', `Node ${process.versions.node}`, 'Install Node 22.12 or newer from nodejs.org (or nvm install 22).');
  const built = await exists(join(root, 'dist', 'start.html')) && await exists(join(root, 'dist-server', 'relay.js'));
  add('build', 'App built', built ? 'ok' : 'required', built ? 'dist/ and dist-server/ present' : 'Build output missing', 'Run: pnpm build');
  const ffmpeg = await version(env.PREVIS_FFMPEG || 'ffmpeg'), ffprobe = await version(env.PREVIS_FFPROBE || 'ffprobe');
  add('ffmpeg', 'FFmpeg + FFprobe', ffmpeg && ffprobe ? 'ok' : 'required', ffmpeg && ffprobe ? ffmpeg.replace(/ Copyright.*/, '') : `${ffmpeg ? '' : 'ffmpeg '}${ffprobe ? '' : 'ffprobe '}not found`, 'Needed to export camera videos. macOS: brew install ffmpeg · Ubuntu: sudo apt install ffmpeg · Windows: winget install Gyan.FFmpeg — or set PREVIS_FFMPEG / PREVIS_FFPROBE.');
  if (data) {
    let writable = false; try { await mkdir(data, { recursive: true }); await access(data, constants.W_OK); writable = true; } catch {}
    add('data', 'Project folder writable', writable ? 'ok' : 'required', data, 'Set PREVIS_DATA_DIR to a folder you can write to.');
    // Shared assets: the app skips a manifest it cannot read; say which ones here. Only shown once a library exists.
    const lib = libraryDir(data, env);
    if (await exists(join(lib, 'assets'))) {
      const { assets, bad } = await openLibrary(lib).scan();
      const many = assets.length > LIMITS.assets;
      add('library', 'Asset library', bad.length || many ? 'warn' : 'ok', `${assets.length} shared asset${assets.length === 1 ? '' : 's'} in ${lib}${bad.length ? `; ${bad.length} unreadable: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}` : ''}`,
        bad.length ? 'Those folders under library/assets/ have a missing or broken asset.json; move them aside or import the asset again.' : many ? `More than ${LIMITS.assets} assets makes listing slow; export and remove ones you no longer use.` : '');
    }
  }
  add('env', '.env file', await exists(join(root, '.env')) ? 'ok' : 'optional', await exists(join(root, '.env')) ? '.env present' : 'No .env (optional)', 'cp .env.example .env, then add keys you need.');
  add('cloud', 'Comfy Cloud key', env.COMFY_CLOUD_API_KEY ? 'ok' : 'optional', env.COMFY_CLOUD_API_KEY ? 'COMFY_CLOUD_API_KEY is set' : 'Not set — Cloud quotes and generation unavailable', 'Create a key at comfy.org and put it in .env as COMFY_CLOUD_API_KEY=… (never commit it).');
  add('paid', 'Paid generation', env.PREVIS_ALLOW_PAID === '1' ? 'warn' : 'ok', env.PREVIS_ALLOW_PAID === '1' ? 'ENABLED — approved Cloud requests will be charged' : 'Off (quotes only). Set PREVIS_ALLOW_PAID=1 to allow approved paid runs.', '');
  const comfyUrl = env.PREVIS_COMFY_URL || 'http://127.0.0.1:8000';
  let local = null;
  try { const r = await fetcher(comfyUrl + '/system_stats', { signal: AbortSignal.timeout(1500) }); local = r.ok; } catch { local = false; }
  add('local', 'Local ComfyUI', local ? 'ok' : 'optional', local ? `Reachable at ${comfyUrl}` : `Not reachable at ${comfyUrl}`, 'Optional: run ComfyUI locally (Desktop app or python main.py) and set PREVIS_COMFY_URL if not on port 8000.');
  // Blender belongs to the retired workbench routes: only worth a line when someone runs them.
  if (env.PREVIS_LEGACY_ROUTES === '1' || env.PREVIS_BLENDER_MCP_COMMAND) add('blender', 'Blender MCP', env.PREVIS_BLENDER_MCP_COMMAND ? 'ok' : 'optional', env.PREVIS_BLENDER_MCP_COMMAND ? 'Configured' : 'Not configured (optional)', 'See docs/standalone-previs.md to connect Blender.');
  const ready = checks.every(c => c.status !== 'required');
  return { ready, checks };
}
