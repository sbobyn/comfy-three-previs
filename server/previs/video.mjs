// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const VIDEO_LIMITS = Object.freeze({ maxFrames: 120, maxWidth: 1280, maxHeight: 720, minFps: 1, maxFps: 60, maxFrameBytes: 8 * 1024 * 1024, maxVideoBytes: 128 * 1024 * 1024, maxStages: 4, processTimeoutMs: 120000 });
const stages = new Map();
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const gcd = (a, b) => b ? gcd(b, a % b) : a;

function fraction(value) {
  if (typeof value !== 'string' || !/^\d+\/\d+$/.test(value)) throw Error('Expected a positive rational FPS');
  const [n, d] = value.split('/').map(Number);
  if (![n, d].every(v => Number.isSafeInteger(v) && v > 0 && v <= 1000000000)) throw Error('Invalid rational value');
  const divisor = gcd(n, d);
  return [n / divisor, d / divisor];
}

function frameRate(fps) {
  let pair;
  if (typeof fps === 'string') pair = fraction(fps);
  else {
    if (!Number.isFinite(fps) || fps < VIDEO_LIMITS.minFps || fps > VIDEO_LIMITS.maxFps) throw Error('FPS must be between 1 and 60');
    // Recover common fractional scene rates (e.g. 24000/1001) from JSON numbers.
    let x = fps, n0 = 0, n1 = 1, d0 = 1, d1 = 0;
    for (let i = 0; i < 32; i++) {
      const a = Math.floor(x), n = a * n1 + n0, d = a * d1 + d0;
      if (n > 1000000 || d > 1000000) break;
      pair = [n, d];
      if (Math.abs(n / d - fps) < 1e-10) break;
      [n0, n1, d0, d1] = [n1, n, d1, d];
      x = 1 / (x - a);
    }
    if (!pair || Math.abs(pair[0] / pair[1] - fps) > 1e-9) throw Error('Supply FPS as a bounded rational numerator/denominator');
  }
  const [n, d] = pair;
  if (n > 1000000 || d > 1000000 || n / d < VIDEO_LIMITS.minFps || n / d > VIDEO_LIMITS.maxFps) throw Error('FPS must be between 1 and 60, with numerator and denominator at most 1000000');
  return { fps: n / d, fpsRational: `${n}/${d}` };
}

/** Explicit output timing: N frames last N / fps seconds, including the last frame. */
export function videoOptions({ width = 640, height = 360, fps = 24, frameCount } = {}) {
  if (!Number.isInteger(width) || width < 2 || width > VIDEO_LIMITS.maxWidth || width % 2 || !Number.isInteger(height) || height < 2 || height > VIDEO_LIMITS.maxHeight || height % 2) throw Error('Video dimensions must be even, at most 1280 x 720');
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > VIDEO_LIMITS.maxFrames) throw Error('Video requires 1 to 120 frames');
  const rate = frameRate(fps);
  return { width, height, ...rate, frameCount, duration: frameCount / rate.fps };
}

/** Server-only capability. Never create a stage from a client-supplied path. */
export async function createFrameStage(options) {
  const normalized = videoOptions(options);
  if (stages.size >= VIDEO_LIMITS.maxStages) throw Error('Too many active video stages');
  const id = randomUUID();
  // Reserve before awaiting so concurrent callers cannot exceed the stage bound.
  stages.set(id, null);
  try {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'previs-video-')));
    const stage = Object.freeze({ id, directory, outputPath: join(directory, 'video.mp4'), ...normalized });
    stages.set(id, { stage, encoding: false, encoded: false, writes: 0 });
    return stage;
  } catch (error) { stages.delete(id); throw error; }
}

function stageRecord(directory) {
  const record = [...stages.values()].find(value => value?.stage.directory === directory);
  if (!record) throw Error('Unknown video stage; arbitrary paths are not accepted');
  return record;
}

/** Used by the fixed Blender script generator; paths must come from this process. */
export function assertFrameStage(directory, options) {
  const { stage } = stageRecord(directory);
  if (options) {
    const expected = videoOptions(options);
    if (['width', 'height', 'fpsRational', 'frameCount'].some(key => expected[key] !== stage[key])) throw Error('Video options differ from the allocated stage');
    if (options.outputPath !== undefined && options.outputPath !== stage.outputPath) throw Error('Output path must belong to the allocated stage');
  }
  return stage;
}

/** Releases only the in-memory slot. Files are retained, including partial outputs.
 * Do not release a stage while Blender may still be writing after an uncertain MCP result.
 */
export function releaseFrameStage(directory) {
  const record = stageRecord(directory);
  if (record.encoding || record.writes) throw Error('Video stage is busy');
  stages.delete(record.stage.id);
  return { directory, retained: true };
}

function frameName(index) { return `frame-${String(index).padStart(6, '0')}.png`; }
function validatePng(bytes, size, stage) {
  if (size < 33 || size > VIDEO_LIMITS.maxFrameBytes || !bytes.subarray(0, 8).equals(pngSignature) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw Error('Expected a PNG frame under 8 MB');
  if (bytes.readUInt32BE(16) !== stage.width || bytes.readUInt32BE(20) !== stage.height) throw Error('PNG frame dimensions differ from the video stage');
}

/** Browser upload: zero-based, exclusive frame writes; duplicate indices are refused. */
export async function writeFrame({ directory, index, bytes }) {
  const record = stageRecord(directory), { stage } = record;
  if (record.encoding || record.encoded) throw Error('Video stage is already encoding or encoded');
  if (!Number.isInteger(index) || index < 0 || index >= stage.frameCount) throw Error('Frame index is outside the video stage');
  if (!Buffer.isBuffer(bytes)) throw Error('PNG bytes must be a Buffer');
  validatePng(bytes, bytes.length, stage);
  record.writes++;
  try { await writeFile(join(directory, frameName(index)), bytes, { flag: 'wx', mode: 0o600 }); }
  finally { record.writes--; }
  return { index };
}

async function regularFile(file, maxBytes) {
  if (typeof file !== 'string' || !isAbsolute(file)) throw Error('An absolute local file is required');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) throw Error('Expected a bounded regular local file');
  return stat;
}

function executable(name) { return process.env[name === 'ffmpeg' ? 'PREVIS_FFMPEG' : 'PREVIS_FFPROBE'] || name; }
function run(name, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable(name), args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure;
    const stop = message => { failure ||= Error(message); child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop(`${name} exceeded the video process time limit`), VIDEO_LIMITS.processTimeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length + chunk.length > 1024 * 1024) stop(`${name} returned too much output`); else stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length + chunk.length > 65536) stop(`${name} returned too many errors`); else stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(Error(`${name} could not start (${error.code || 'process error'}); install it or set PREVIS_${name.toUpperCase()}`)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(Error(`${name} failed (${code}): ${stderr.slice(-1200)}`));
      else resolveRun(stdout);
    });
  });
}

/** No downloads or jobs: checks only the configured local executables. */
export async function videoReadiness() {
  const results = await Promise.all(['ffmpeg', 'ffprobe'].map(async name => {
    try { await run(name, ['-version']); return { name, available: true }; }
    catch (error) { return { name, available: false, error: error.message }; }
  }));
  return { available: results.every(r => r.available), tools: results, limits: VIDEO_LIMITS };
}

/** Strict probe for bounded silent H.264 MP4s; checks decoded count and every packet's timing. */
export async function probeVideo(file) {
  const stat = await regularFile(file, VIDEO_LIMITS.maxVideoBytes);
  const output = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-count_frames', '-show_streams', '-show_format', '-show_packets', '-of', 'json', file]);
  let data; try { data = JSON.parse(output); } catch { throw Error('ffprobe returned invalid JSON'); }
  const stream = data.streams?.[0];
  if (data.streams?.length !== 1 || stream?.codec_type !== 'video') throw Error('Video must contain exactly one video stream and no audio or other streams');
  if (stream.codec_name !== 'h264' || stream.pix_fmt !== 'yuv420p' || !data.format?.format_name?.split(',').includes('mp4')) throw Error('Expected H.264 yuv420p in an MP4 container');
  const metadata = videoOptions({ width: stream.width, height: stream.height, fps: stream.avg_frame_rate, frameCount: Number(stream.nb_read_frames) });
  if (frameRate(stream.r_frame_rate).fpsRational !== metadata.fpsRational || Number(stream.nb_frames) !== metadata.frameCount) throw Error('Video frame count or rational FPS is inconsistent');
  const [n, d] = fraction(metadata.fpsRational).map(BigInt), [tn, td] = fraction(stream.time_base).map(BigInt);
  const ticksMatch = (ticks, frames) => Number.isSafeInteger(Number(ticks)) && BigInt(ticks) * tn * n === BigInt(frames) * d * td;
  if (!ticksMatch(stream.start_pts, 0) || !ticksMatch(stream.duration_ts, metadata.frameCount) || !Number.isFinite(Number(data.format.duration)) || Math.abs(Number(data.format.duration) - metadata.duration) > 0.0011) throw Error('Video duration does not equal frameCount / FPS');
  const packets = data.packets;
  if (!Array.isArray(packets) || packets.length !== metadata.frameCount) throw Error('Video packet count differs from its frame count');
  const ordered = packets.toSorted((a, b) => Number(a.pts) - Number(b.pts));
  if (ordered.some((packet, i) => packet.stream_index !== stream.index || !ticksMatch(packet.pts, i) || !ticksMatch(packet.duration, 1))) throw Error('Video is not an exact constant-rate frame sequence');
  return { ...metadata, audio: false, codec: 'h264', pixelFormat: 'yuv420p', container: 'mp4', bytes: stat.size };
}

function verifyMetadata(metadata, options) {
  const expected = videoOptions(options);
  if (['width', 'height', 'frameCount', 'fpsRational'].some(key => metadata[key] !== expected[key])) throw Error('Encoded video does not match the requested dimensions, frame count or FPS');
  return metadata;
}

/** Both browser and Blender use this encoder. No paths except allocated stages are accepted. */
export async function encodeFrames(options) {
  const stage = assertFrameStage(options.directory, options), record = stageRecord(stage.directory);
  if (record.encoding || record.encoded || record.writes) throw Error('Video stage is busy or already encoded');
  record.encoding = true;
  try {
    const names = await readdir(stage.directory);
    if (names.length !== stage.frameCount || names.some(name => !Array.from({ length: stage.frameCount }, (_, i) => frameName(i)).includes(name))) throw Error('Expected exactly the complete PNG frame sequence in an empty output stage');
    for (let i = 0; i < stage.frameCount; i++) {
      const file = join(stage.directory, frameName(i));
      await regularFile(file, VIDEO_LIMITS.maxFrameBytes);
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const bytes = Buffer.alloc(33); await handle.read(bytes, 0, 33, 0); validatePng(bytes, (await handle.stat()).size, stage); }
      finally { await handle.close(); }
    }
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file', '-f', 'image2', '-framerate', stage.fpsRational, '-start_number', '0', '-i', join(stage.directory, 'frame-%06d.png'), '-map', '0:v:0', '-frames:v', String(stage.frameCount), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-bf', '0', '-threads', '2', '-fps_mode', 'passthrough', '-video_track_timescale', stage.fpsRational.split('/')[0], '-an', '-map_metadata', '-1', '-movflags', '+faststart', '-f', 'mp4', stage.outputPath]);
    const metadata = verifyMetadata(await probeVideo(stage.outputPath), stage);
    record.encoded = true;
    return { file: stage.outputPath, metadata };
  } finally { record.encoding = false; }
}

/** Hash of the JSON snapshot actually persisted by openProject (key order is preserved). */
export function browserSnapshotHash(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw Error('A saved browser scene/camera snapshot is required');
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

/** Appends a versioned immutable file and asset using openProject's revision gate.
 * Call outside project.mutate, inside the server's serial queue. Keep stages on disk.
 * Browser provenance requires browserSnapshot equal to the originating saved shot.browser.
 */
export async function saveVideoAsset({ root, project, revision, shotId, file, metadata, binding, provenance = {} }) {
  const record = stageRecord(dirname(file));
  if (record.stage.outputPath !== file || !record.encoded) throw Error('Only a verified encoded stage can become a video asset');
  const verified = verifyMetadata(await probeVideo(file), record.stage);
  if (!isDeepStrictEqual(metadata, verified)) throw Error('Video metadata changed since encoding');
  const sourceBinding = structuredClone(binding), sourceProvenance = structuredClone(provenance);
  const id = randomUUID(), assetPath = join(resolve(root), 'assets', id + '.mp4');
  let asset;
  const saved = await project.mutate(revision, async p => {
    const shot = p.shots.find(s => s.id === shotId);
    if (!shot || !isDeepStrictEqual(shot.binding, sourceBinding)) throw Error('Saved shot binding changed before video attachment');
    if (!['three', 'blender'].includes(sourceBinding.source)) throw Error('Unsupported video source');
    if (sourceBinding.source === 'blender' && verified.frameCount !== sourceBinding.end - sourceBinding.start + 1) throw Error('Video must contain every selected Blender frame');
    if (sourceBinding.source === 'three') {
      if (!shot.browser || !isDeepStrictEqual(shot.browser, sourceProvenance.browserSnapshot)) throw Error('Video requires the exact saved browser scene/camera snapshot');
      const hash = browserSnapshotHash(shot.browser);
      if (sourceProvenance.browserSnapshotHash !== undefined && sourceProvenance.browserSnapshotHash !== hash) throw Error('Browser snapshot hash does not match the saved shot');
      sourceProvenance.browserSnapshotHash = hash;
    }
    await mkdir(dirname(assetPath), { recursive: true });
    await copyFile(file, assetPath, constants.COPYFILE_EXCL);
    await chmod(assetPath, 0o444);
    const handle = await open(assetPath, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    const sha256 = createHash('sha256');
    const copied = await open(assetPath, 'r');
    try { for await (const chunk of copied.createReadStream({ autoClose: false })) sha256.update(chunk); }
    finally { await copied.close(); }
    asset = { id, kind: 'video', pass: 'beauty', version: 1 + Math.max(0, ...(p.assets || []).filter(a => a.kind === 'video' && a.shotId === shotId).map(a => a.version || 1)), shotId, source: sourceBinding.source, binding: sourceBinding, requestRevision: revision, ...verified, mimeType: 'video/mp4', url: `/assets/${id}.mp4`, sha256: sha256.digest('hex'), provenance: sourceProvenance, timing: { sourceFps: sourceBinding.fps, outputFps: verified.fps, outputFpsRational: verified.fpsRational, frameCount: verified.frameCount, duration: verified.duration, sampling: sourceBinding.source === 'blender' ? 'one-output-frame-per-source-frame' : 'saved-browser-motion' }, createdAt: new Date().toISOString() };
    (p.assets ||= []).push(asset);
  });
  return { project: saved, asset: structuredClone(asset) };
}
