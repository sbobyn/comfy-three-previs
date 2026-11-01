// Frames for agents (contract C4 view_shot): one frame of a director video asset at time t, a still reference
// downscaled, or a tiled contact sheet of several (blockout frames come from the headless renderer). FFmpeg only.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opQuery } from './headless.mjs';
import { VIDEO_LIMITS } from './video.mjs';

function fail(message, status = 400) { const e = Error(message); e.status = status; throw e; }
const MAX_TILES = 16, MAX_BYTES = 4 * 1024 * 1024;
const even = n => Math.max(2, Math.floor(n / 2) * 2);
const int = (v, d, lo, hi, name) => { const n = v == null || v === '' ? d : Number(v); if (!Number.isInteger(n) || n < lo || n > hi) fail(`${name} must be a whole number from ${lo} to ${hi}`); return n; };

/** Width and height from PNG IHDR or a JPEG SOF marker. */
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  for (let i = 2; buf[0] === 0xff && buf[1] === 0xd8 && i + 9 < buf.length;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  return { width: null, height: null };
}

/** FFmpeg args: one frame per input (seeked to t), scaled; several inputs are tiled cols-wide into one image. */
export function frameArgs(inputs, { width, cols, type }) {
  const args = ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe'];
  for (const x of inputs) args.push(...(x.t > 0 ? ['-ss', x.t.toFixed(3)] : []), '-i', x.file);
  let graph;
  if (inputs.length === 1) graph = `[0:v]trim=end_frame=1,scale=w='min(${width},iw)':h=-2,setsar=1[out]`;
  else {
    const c = Math.min(cols, inputs.length), rows = Math.ceil(inputs.length / c), cw = even((width - 4 * (c + 1)) / c), ch = even((cw * 9) / 16);
    graph = inputs.map((_, i) => `[${i}:v]trim=end_frame=1,setpts=PTS-STARTPTS,scale=${cw}:${ch}:force_original_aspect_ratio=decrease,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2:color=0x111111,setsar=1,format=yuv420p[v${i}]`).join(';')
      + `;${inputs.map((_, i) => `[v${i}]`).join('')}concat=n=${inputs.length}:v=1:a=0,tile=${c}x${rows}:padding=4:margin=4:color=0x111111[out]`;
  }
  return [...args, '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', '-f', 'image2pipe', ...(type === 'image/jpeg' ? ['-c:v', 'mjpeg', '-q:v', '4', '-pix_fmt', 'yuvj420p'] : ['-c:v', 'png']), 'pipe:1'];
}

function ffmpeg(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.env.PREVIS_FFMPEG || 'ffmpeg', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; let size = 0, stderr = '', failure;
    const stop = message => { failure ||= Error(message); child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('ffmpeg exceeded the video process time limit'), VIDEO_LIMITS.processTimeoutMs);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > MAX_BYTES) stop('Frame is too large'); else out.push(chunk); });
    child.stderr.on('data', chunk => { if (stderr.length < 65536) stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(Error(`ffmpeg could not start (${error.code || 'process error'}); install it or set PREVIS_FFMPEG`)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0 || !size) reject(Error(`ffmpeg could not read a frame: ${stderr.slice(-600) || `exit ${code}`}`));
      else resolveRun(Buffer.concat(out));
    });
  });
}

/** Frames of local videos ({ file, t } each) tiled `cols` wide into one PNG or JPEG image. */
export const contactSheet = (inputs, { width = 1024, cols = 1, type = 'image/png' } = {}) => ffmpeg(frameArgs(inputs, { width, cols, type }));

/** One frame of a local video at t seconds as PNG or JPEG bytes, no wider than width (the clip's own size at most). */
export async function videoFrame(file, t, { width = 1280, type = 'image/png' } = {}) {
  const bytes = await ffmpeg(frameArgs([{ file, t }], { width, cols: 1, type }));
  return { bytes, ...imageSize(bytes) };
}

/** GET /api/director/asset-frame?projectId&(assetId&t…|referenceId…|shotId&t…)&width&cols&type → { data, mime, width, height, frames }. */
export function frameRoutes({ director, headless }) {
  return async function route(url) {
    const q = url.searchParams, p = await director.get(q.get('projectId'));
    const width = int(q.get('width'), 1280, 64, 1920, 'width'), cols = int(q.get('cols'), 3, 1, 6, 'cols');
    const type = q.get('type') || 'image/png'; if (!['image/png', 'image/jpeg'].includes(type)) fail('type must be image/png or image/jpeg');
    const ts = q.getAll('t').map(Number); if (ts.some(t => !Number.isFinite(t) || t < 0)) fail('t must be seconds ≥ 0');
    const assetId = q.get('assetId'), refIds = q.getAll('referenceId'), shotId = q.get('shotId');
    if ((ts.length || refIds.length) > MAX_TILES) fail(`At most ${MAX_TILES} frames per contact sheet`);
    let inputs, tmp = null;
    try {
      if (assetId) {
        const a = (p.assets || []).find(x => x.id === assetId); if (!a) fail('Unknown asset', 404);
        if (!/^(video\/|image\/png)/.test(a.mime || '')) fail('That asset is not a video or image');
        const file = await director.assetFile(p.id, a.file.replace(/^assets\//, '')), last = Math.max(0, (a.duration || 0) - 1 / (a.fps || 24));
        inputs = (ts.length ? ts : [0]).map(t => ({ file, t: Math.min(t, last) }));
      } else if (refIds.length) {
        const all = [...(p.scene.references || []), ...p.shots.flatMap(s => s.references)];
        inputs = [];
        for (const id of refIds) { const r = all.find(x => x.id === id); if (!r) fail('Unknown reference', 404); inputs.push({ file: await director.refFile(p.id, r.file), t: 0, referenceId: id }); }
      } else if (shotId) {
        // Blockout contact sheet: small frames from the headless renderer, tiled here.
        const s = p.shots.find(x => x.id === shotId); if (!s) fail('Unknown shot', 404);
        if (!ts.length) fail('t is required for blockout frames');
        tmp = await mkdtemp(join(tmpdir(), 'previs-frames-')); inputs = [];
        const c = Math.min(cols, ts.length), cw = even((width - 4 * (c + 1)) / c), ch = even((cw * 9) / 16);
        for (const [i, t] of ts.entries()) {
          const r = await headless.run(opQuery('frame', { project: p.id, shot: s.id, t: Math.min(t, s.duration), width: cw, height: ch, type: 'image/png' }));
          const file = join(tmp, `f${i}.png`); await writeFile(file, Buffer.from(r.data, 'base64')); inputs.push({ file, t: 0 });
        }
      } else fail('assetId, referenceId or shotId is required');
      const bytes = await ffmpeg(frameArgs(inputs, { width, cols, type }));
      return { data: bytes.toString('base64'), mime: type, ...imageSize(bytes), bytes: bytes.length, frames: assetId ? inputs.map(x => x.t) : refIds.length ? refIds : ts };
    } finally { if (tmp) await rm(tmp, { recursive: true, force: true }); }
  };
}
