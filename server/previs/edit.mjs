// Edit timeline export: trims each clip and joins them into one 1280×720, 24 fps H.264 video with FFmpeg.
// Clips are conformed (scaled/padded, frame rate, pixel format) so mixed sources cut together cleanly.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exe = name => process.env[name === 'ffmpeg' ? 'PREVIS_FFMPEG' : 'PREVIS_FFPROBE'] || name;
function run(cmd, args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe(cmd), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error(`${cmd} timed out`)); }, timeoutMs);
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err = (err + d).slice(-4000); });
    child.on('error', e => { clearTimeout(timer); reject(Error(`${cmd} is not available: ${e.message}`)); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(Error(`${cmd} failed: ${err.split('\n').filter(Boolean).slice(-2).join(' ')}`)); });
  });
}

export const EDIT_FORMAT = { width: 1280, height: 720, fps: 24 };

/** Validate clips against known media: [{ file, duration, in, out }] → trimmed spans. */
export function planClips(clips) {
  if (!Array.isArray(clips) || !clips.length) throw Error('Add at least one rendered shot to the timeline');
  if (clips.length > 60) throw Error('The timeline supports at most 60 clips');
  return clips.map((c, i) => {
    const dur = Number(c.duration);
    if (!c.file || !Number.isFinite(dur) || dur <= 0) throw Error(`Clip ${i + 1} has no rendered video`);
    const a = Math.max(0, Math.min(dur, Number(c.in) || 0));
    const b = Math.max(0, Math.min(dur, Number.isFinite(Number(c.out)) && Number(c.out) > 0 ? Number(c.out) : dur));
    if (b - a < 1 / EDIT_FORMAT.fps) throw Error(`Clip ${i + 1} is trimmed to nothing`);
    return { file: c.file, in: a, out: b, length: b - a };
  });
}

export async function renderEdit(clips, outFile) {
  const spans = planClips(clips);
  const { width: W, height: H, fps } = EDIT_FORMAT;
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const s of spans) args.push('-ss', s.in.toFixed(3), '-t', s.length.toFixed(3), '-i', s.file);
  const chains = spans.map((_, i) => `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`);
  const filter = `${chains.join(';')};${spans.map((_, i) => `[v${i}]`).join('')}concat=n=${spans.length}:v=1:a=0[out]`;
  args.push('-filter_complex', filter, '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-movflags', '+faststart', outFile);
  await run('ffmpeg', args);
  const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames,r_frame_rate:format=duration', '-of', 'json', outFile]));
  const st = probe.streams?.[0] || {};
  return { width: st.width, height: st.height, frameCount: Number(st.nb_read_frames), duration: Math.round(Number(probe.format?.duration) * 1000) / 1000, fps, clips: spans.length, size: (await stat(outFile)).size };
}

export async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'previs-edit-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Any still image → PNG bytes, fitted inside 2048×2048 (reference images for video models). */
export async function imageToPng(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', "scale='min(2048,iw)':'min(2048,ih)':force_original_aspect_ratio=decrease", '-f', 'image2pipe', '-vcodec', 'png', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('ffmpeg timed out')); }, 60000);
    child.stdout.on('data', d => chunks.push(d)); child.stderr.on('data', d => { err = (err + d).slice(-2000); });
    child.on('error', e => { clearTimeout(timer); reject(Error(`ffmpeg is not available: ${e.message}`)); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks)) : reject(Error(`ffmpeg failed: ${err.trim().split('\n').at(-1)}`)); });
  });
}
