// Masked-edit: prepare / status / review / accept (local) + submit (generation authority).
// Submit builds crop/mask support media and delegates paid dispatch to generation; no parallel dispatcher.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, access, copyFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { deflateSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { atomicJson } from './atomic.mjs';
import { inspectOutputVideo } from './media-inspect.mjs';
import { builtInPresets } from './presets.mjs';
import { validateWorkflowDefinition } from './workflows.mjs';
import {
  MASKED_EDIT_VERSION, MASKED_EDIT_WORKFLOW, MASK_ALGORITHM_VERSION, COMPOSITE_VERSION,
  ELIGIBLE_WIDTH, ELIGIBLE_HEIGHT, assertUuid, sourceEligible, normalizeMask, rasterizeFixedMask,
  cropFromMask, validateCropEnvelope, validatePromptFields, composeInputKey, offlineQuoteEnvelope,
  compositeFrame, verifyOutsideExact, hashBytes, buildMaskedEditProvenance, validateAcceptanceState,
  isMaskedEditAsset, rootAssetId,
} from '../../shared/masked-edit.mjs';
import { cameraSourceForMaskedEdit } from '../../shared/camera-source.mjs';

const UUID = /^[a-f0-9-]{36}$/i;
const MASKED_PRESET_ID = 'wan-vace-14b-masked-v1';
const ALLOWED_FILES = new Set([
  'receipt.json', 'mask.bin', 'mask.png', 'support.bin', 'crop.json',
  'crop.mp4', 'mask.mp4', 'mask-frame.png',
  'candidate.mp4', 'candidate.sha256', 'preservation.json', 'patch.rgb', 'composite.rgb',
]);

function fail(message, status = 400, code = 'masked-edit') {
  const e = Error(message);
  e.status = status;
  e.code = code;
  throw e;
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
const exe = name => process.env[name === 'ffmpeg' ? 'PREVIS_FFMPEG' : 'PREVIS_FFPROBE'] || name;

function crcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
const CRC = crcTable();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typ = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typ, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Lossless 8-bit grayscale PNG (authoritative mask alpha). */
export function grayPng(width, height, alpha) {
  if (alpha.length !== width * height) fail('mask alpha size mismatch');
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    raw.set(alpha.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function run(cmd, args, timeoutMs = 120000) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(exe(cmd), args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = Buffer.alloc(0), err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error(`${cmd} timed out`)); }, timeoutMs);
    child.stdout.on('data', d => { out = Buffer.concat([out, d]); if (out.length > 512 * 1024 * 1024) { child.kill('SIGKILL'); reject(Error(`${cmd} output too large`)); } });
    child.stderr.on('data', d => { err = (err + d).slice(-4000); });
    child.on('error', e => { clearTimeout(timer); reject(Error(`${cmd} unavailable: ${e.message}`)); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolveRun(out) : reject(Error(`${cmd} failed: ${err.split('\n').filter(Boolean).slice(-2).join(' ')}`)); });
  });
}

/** Safe join under an edit receipt directory — rejects traversal and non-allowlisted names. */
export function safeEditPath(editRoot, name) {
  const base = String(name || '');
  if (!ALLOWED_FILES.has(base) && !/^[a-f0-9-]{36}\.(mp4|png|bin|json)$/.test(base)) fail('Unexpected masked-edit artifact name', 400, 'path');
  if (base.includes('..') || base.includes('/') || base.includes('\\') || base.includes('\0')) fail('Invalid artifact path', 400, 'path');
  const full = resolve(editRoot, base);
  if (!full.startsWith(resolve(editRoot) + sep) && full !== resolve(editRoot)) fail('Path escapes edit directory', 400, 'path');
  return full;
}

export function openMaskedEdit(dataRoot, director, { log = () => {}, generation = null, engineProject = null } = {}) {
  const root = resolve(dataRoot);
  const editsRoot = join(root, 'masked-edits');
  const genRoute = generation?.route ? (op, input) => generation.route(`/api/generation/${op}`, input) : null;

  const editDir = editId => {
    assertUuid(editId, 'editId');
    return join(editsRoot, editId);
  };

  async function loadReceipt(editId) {
    const dir = editDir(editId);
    try {
      return JSON.parse(await readFile(join(dir, 'receipt.json'), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') fail('Unknown edit', 404);
      throw e;
    }
  }

  async function saveReceipt(receipt) {
    const dir = editDir(receipt.editId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await atomicJson(join(dir, 'receipt.json'), receipt);
    return receipt;
  }

  async function resolveSource(projectId, shotId, sourceAssetId, sourceSha256) {
    assertUuid(projectId, 'projectId');
    assertUuid(shotId, 'shotId');
    assertUuid(sourceAssetId, 'sourceAssetId');
    const p = await director.get(projectId);
    const shot = p.shots.find(s => s.id === shotId);
    if (!shot) fail('Unknown shot', 404);
    const asset = (p.assets || []).find(a => a.id === sourceAssetId);
    if (!asset) fail('Unknown source take', 404);
    if (asset.shotId !== shotId) fail('Source take belongs to another shot', 400, 'cross-shot');
    if (asset.kind !== 'workflow-result' || !String(asset.mime || '').startsWith('video/')) fail('Source must be a generated video take');
    if (isMaskedEditAsset(asset)) fail('Chained masked edits are not supported in v1');
    if (sourceSha256 && asset.sha256 && asset.sha256 !== sourceSha256) fail('sourceSha256 does not match the project take', 409);
    const file = await director.assetFile(projectId, asset.file.split('/').pop());
    const bytes = await readFile(file);
    const liveSha = sha(bytes);
    if (asset.sha256 && asset.sha256 !== liveSha) fail('Source take bytes changed on disk', 409);
    if (sourceSha256 && sourceSha256 !== liveSha) fail('sourceSha256 does not match file bytes', 409);
    let media;
    try { media = await inspectOutputVideo(bytes, { mime: asset.mime || 'video/mp4' }); }
    catch (e) { fail(`Source media could not be inspected: ${e.message}`); }
    const eligibility = sourceEligible({
      width: media.width ?? asset.width,
      height: media.height ?? asset.height,
      fps: media.fps ?? asset.fps,
      frameCount: media.frameCount ?? asset.frameCount,
      audio: media.audio,
      variableRate: media.variableRate,
    });
    return { project: p, shot, asset, bytes, file, liveSha, media, eligibility };
  }

  /**
   * Local preparation only — rasterize mask, compute crop, store receipt + lossless mask.
   * Does not upload, reserve budget, or call any provider.
   */
  async function prepare(input = {}) {
    const draftId = assertUuid(input.draftId || randomUUID(), 'draftId');
    const projectId = assertUuid(input.projectId, 'projectId');
    const shotId = assertUuid(input.shotId, 'shotId');
    const sourceAssetId = assertUuid(input.sourceAssetId, 'sourceAssetId');
    const sourceSha256 = String(input.sourceSha256 || '');
    if (!/^[a-f0-9]{64}$/.test(sourceSha256)) fail('sourceSha256 must be a 64-char hex digest');
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) fail('expectedRevision must be a non-negative integer');

    const resolved = await resolveSource(projectId, shotId, sourceAssetId, sourceSha256);
    if (resolved.project.revision !== expectedRevision) fail('Project changed; refresh and prepare again', 409, 'revision');
    if (!resolved.eligibility.ok) {
      return {
        ok: false,
        editId: null,
        eligibility: resolved.eligibility,
        warnings: [],
        issues: resolved.eligibility.issues.map(text => ({ code: 'source-ineligible', text })),
        quote: null,
      };
    }

    let prompts, raster, crop;
    try {
      prompts = validatePromptFields({ prompt: input.prompt, negativePrompt: input.negativePrompt, seed: input.seed });
      raster = rasterizeFixedMask(input.mask, { width: ELIGIBLE_WIDTH, height: ELIGIBLE_HEIGHT });
      crop = cropFromMask(raster.alpha, ELIGIBLE_WIDTH, ELIGIBLE_HEIGHT);
      const cropOk = validateCropEnvelope(crop);
      if (!cropOk.ok) fail(cropOk.issues[0] || 'Invalid crop');
    } catch (e) {
      if (e.status) throw e;
      fail(e.message || 'Invalid mask or prompt');
    }

    const editId = draftId;
    const dir = editDir(editId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(safeEditPath(dir, 'mask.bin'), Buffer.from(raster.alpha), { mode: 0o600 });
    await writeFile(safeEditPath(dir, 'support.bin'), Buffer.from(raster.support), { mode: 0o600 });
    const maskPng = grayPng(ELIGIBLE_WIDTH, ELIGIBLE_HEIGHT, raster.alpha);
    await writeFile(safeEditPath(dir, 'mask.png'), maskPng, { mode: 0o600 });
    await atomicJson(safeEditPath(dir, 'crop.json'), crop);

    const sourceTiming = {
      width: resolved.media.width, height: resolved.media.height,
      fps: resolved.media.fps, frameCount: resolved.media.frameCount, duration: resolved.media.duration,
      fpsRational: resolved.media.fpsRational, codec: resolved.media.codec,
    };
    const inputKey = composeInputKey({
      projectId, shotId, sourceAssetId, sourceSha256: resolved.liveSha,
      sourceTiming, maskHash: raster.maskHash, featherPx: raster.mask.featherPx,
      crop: { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
      prompt: prompts.prompt, negativePrompt: prompts.negativePrompt, seed: prompts.seed,
      maskAlgorithmVersion: MASK_ALGORITHM_VERSION, compositeVersion: COMPOSITE_VERSION,
      workflow: MASKED_EDIT_WORKFLOW, offline: true,
    });
    const quote = offlineQuoteEnvelope({ frameCount: sourceTiming.frameCount, crop });
    const quoteFingerprint = sha(Buffer.from(JSON.stringify({ inputKey, estimate: quote.estimate, status: quote.status })));

    const receipt = {
      v: MASKED_EDIT_VERSION,
      editId,
      draftRevision: 1,
      state: 'prepared',
      projectId,
      shotId,
      sourceAssetId,
      sourceSha256: resolved.liveSha,
      expectedRevision,
      maskHash: raster.maskHash,
      featherPx: raster.mask.featherPx,
      cropRect: { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
      sourceTiming,
      prompt: prompts.prompt,
      negativePrompt: prompts.negativePrompt,
      seed: prompts.seed,
      inputKey,
      quoteFingerprint,
      quote,
      providerDispatch: false,
      createdAt: now(),
      updatedAt: now(),
      candidateSha256: null,
      review: null,
      acceptance: null,
      preservation: null,
    };
    await saveReceipt(receipt);
    log(`[masked-edit] prepared ${editId} (local only; nothing submitted)`);

    return {
      ok: true,
      editId,
      draftRevision: receipt.draftRevision,
      maskHash: raster.maskHash,
      sourceSha256: resolved.liveSha,
      effectiveMask: { path: 'mask.png', hash: sha(maskPng) },
      cropRect: receipt.cropRect,
      sourceTiming,
      sourceLabel: resolved.asset.source?.workflow || 'Generated',
      eligibility: resolved.eligibility,
      warnings: crop.warnings || [],
      quote: { ...quote, fingerprint: quoteFingerprint },
      inputKey,
      state: receipt.state,
    };
  }

  async function status({ projectId, editId } = {}) {
    assertUuid(projectId, 'projectId');
    const receipt = await loadReceipt(editId);
    if (receipt.projectId !== projectId) fail('Edit belongs to another project', 404);
    await director.get(projectId);
    let job = null;
    if (receipt.jobId && generation?.listForSync) {
      try {
        const listed = generation.state?.()?.jobs || [];
        job = listed.find(j => j.id === receipt.jobId) || null;
      } catch { /* status is best-effort */ }
    }
    return {
      editId: receipt.editId,
      state: receipt.state,
      draftRevision: receipt.draftRevision,
      sourceAssetId: receipt.sourceAssetId,
      sourceSha256: receipt.sourceSha256,
      maskHash: receipt.maskHash,
      cropRect: receipt.cropRect,
      sourceTiming: receipt.sourceTiming,
      candidateSha256: receipt.candidateSha256,
      review: receipt.review,
      acceptance: receipt.acceptance,
      preservation: receipt.preservation,
      quote: receipt.quote,
      quoteFingerprint: receipt.quoteFingerprint,
      inputKey: receipt.inputKey,
      providerDispatch: Boolean(receipt.jobId),
      jobId: receipt.jobId || null,
      job,
    };
  }

  /** Build crop plate + mask video for Cloud upload; register as engine support assets (not takes). */
  async function materializeSupportMedia(receipt) {
    if (!engineProject) fail('Engine project is not configured for masked-edit submit', 500);
    const dir = editDir(receipt.editId);
    const crop = receipt.cropRect;
    const frames = receipt.sourceTiming.frameCount;
    const fps = receipt.sourceTiming.fps || 24;
    const resolved = await resolveSource(receipt.projectId, receipt.shotId, receipt.sourceAssetId, receipt.sourceSha256);
    const cropPath = safeEditPath(dir, 'crop.mp4');
    const maskPath = safeEditPath(dir, 'mask.mp4');
    const maskFrame = safeEditPath(dir, 'mask-frame.png');
    // Crop the full take to the approved rectangle.
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', resolved.file,
      '-vf', `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`,
      '-frames:v', String(frames),
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', cropPath,
    ]);
    // Authoritative alpha → single PNG → N-frame mask video (red channel = alpha).
    const alpha = new Uint8Array(await readFile(safeEditPath(dir, 'mask.bin')));
    const croppedAlpha = Buffer.alloc(crop.w * crop.h);
    for (let y = 0; y < crop.h; y++) {
      for (let x = 0; x < crop.w; x++) {
        croppedAlpha[y * crop.w + x] = alpha[(crop.y + y) * ELIGIBLE_WIDTH + (crop.x + x)];
      }
    }
    await writeFile(maskFrame, grayPng(crop.w, crop.h, croppedAlpha), { mode: 0o600 });
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-loop', '1', '-i', maskFrame,
      '-frames:v', String(frames), '-r', String(fps),
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', maskPath,
    ]);
    const cropBytes = await readFile(cropPath);
    const maskBytes = await readFile(maskPath);
    let cropMeta, maskMeta;
    try {
      cropMeta = await inspectOutputVideo(cropBytes, { mime: 'video/mp4' });
      maskMeta = await inspectOutputVideo(maskBytes, { mime: 'video/mp4' });
    } catch (e) { fail(`Support media inspect failed: ${e.message}`); }
    if (cropMeta.frameCount !== frames || maskMeta.frameCount !== frames) fail('Support media frame count mismatch', 422, 'timing');
    if (cropMeta.width !== crop.w || cropMeta.height !== crop.h || maskMeta.width !== crop.w || maskMeta.height !== crop.h) {
      fail('Support media dimensions mismatch crop', 422, 'timing');
    }
    if (cropMeta.fps !== maskMeta.fps) fail('Support media fps mismatch', 422, 'timing');

    const engineShotId = await ensureEngineShot(receipt, frames, fps);
    const binding = {
      source: 'director-masked-edit', scene: 'masked-edit-support', camera: 'crop',
      start: 1, end: frames, frame: 1, fps,
    };
    const cropAsset = await registerEngineVideo({
      bytes: cropBytes, meta: cropMeta, shotId: engineShotId, binding,
      role: 'masked-edit-crop', editId: receipt.editId,
    });
    const maskAsset = await registerEngineVideo({
      bytes: maskBytes, meta: maskMeta, shotId: engineShotId, binding,
      role: 'masked-edit-mask', editId: receipt.editId,
    });
    return { cropAsset, maskAsset, engineShotId, cropMeta, maskMeta };
  }

  async function ensureEngineShot(receipt, frames, fps) {
    if (!engineProject) fail('Engine project is not configured', 500);
    const existing = engineProject.get().shots?.find(s => s.browser?.director?.projectId === receipt.projectId && s.browser?.director?.shotId === receipt.shotId && s.browser?.director?.maskedEdit === true);
    if (existing) return existing.id;
    const id = randomUUID();
    await engineProject.append(p => {
      const again = p.shots?.find(s => s.browser?.director?.projectId === receipt.projectId && s.browser?.director?.shotId === receipt.shotId && s.browser?.director?.maskedEdit === true);
      if (again) return false;
      (p.shots ||= []).push({
        id,
        title: `Masked edit · ${receipt.shotId.slice(0, 8)}`,
        binding: { source: 'director-masked-edit', start: 1, end: frames, frame: 1, fps },
        browser: { director: { projectId: receipt.projectId, shotId: receipt.shotId, maskedEdit: true, editId: receipt.editId } },
        renders: [],
      });
    });
    const shot = engineProject.get().shots.find(s => s.browser?.director?.projectId === receipt.projectId && s.browser?.director?.shotId === receipt.shotId && s.browser?.director?.maskedEdit === true);
    if (!shot) fail('Failed to create engine shot context for masked edit', 500);
    return shot.id;
  }

  async function registerEngineVideo({ bytes, meta, shotId, binding, role, editId }) {
    const id = randomUUID();
    const filename = `${id}.mp4`;
    const assetPath = join(root, 'assets', filename);
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(assetPath, bytes, { flag: 'wx', mode: 0o600 });
    const asset = {
      id,
      kind: 'video',
      pass: 'beauty',
      version: 1,
      shotId,
      source: 'director-masked-edit',
      binding: structuredClone(binding),
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      frameCount: meta.frameCount,
      duration: meta.duration,
      mime: 'video/mp4',
      mimeType: 'video/mp4',
      filename,
      url: `/assets/${filename}`,
      sha256: sha(bytes),
      provenance: { role, editId, supportMedia: true },
      createdAt: now(),
    };
    await engineProject.append(p => {
      if (!p.shots.some(s => s.id === shotId)) throw Object.assign(Error('Engine shot missing'), { status: 409 });
      (p.assets ||= []).push(asset);
    });
    return asset;
  }

  async function ensureMaskedDefinition() {
    const preset = builtInPresets.find(p => p.id === MASKED_PRESET_ID);
    if (!preset) fail('Masked VACE preset is missing from built-ins', 500);
    const existing = engineProject.get().workflowDefinitions?.find(d => d.id === MASKED_PRESET_ID || d.provenance?.presetId === MASKED_PRESET_ID);
    if (existing) return existing;
    const definition = validateWorkflowDefinition({ ...structuredClone(preset), id: MASKED_PRESET_ID, verification: { status: 'imported' } });
    await engineProject.append(p => {
      if ((p.workflowDefinitions || []).some(d => d.id === MASKED_PRESET_ID)) return false;
      (p.workflowDefinitions ||= []).push(definition);
    });
    return engineProject.get().workflowDefinitions.find(d => d.id === MASKED_PRESET_ID);
  }

  /**
   * Paid boundary: materialize crop/mask, quote via generation, submit with explicit approval.
   * Reuses generation's reservation/dedup/dispatch — no parallel Cloud client.
   */
  async function submit(input = {}) {
    if (!genRoute || !engineProject) fail('Masked-edit submit requires the generation authority', 503, 'no-submit');
    const editId = assertUuid(input.editId, 'editId');
    const projectId = assertUuid(input.projectId, 'projectId');
    const requestId = assertUuid(input.requestId || randomUUID(), 'requestId');
    const draftRevision = Number(input.draftRevision);
    if (!Number.isInteger(draftRevision) || draftRevision < 1) fail('draftRevision must be a positive integer');
    const fingerprint = String(input.fingerprint || '');
    if (!fingerprint) fail('fingerprint is required');
    const maxCostUsd = Number(input.maxCostUsd);
    if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) fail('maxCostUsd must be a non-negative number');
    const approval = input.approval;
    if (!approval?.approved || approval.allowance?.allowUnknownCharges !== true) {
      fail('Explicit approval with allowUnknownCharges is required', 400);
    }

    const receipt = await loadReceipt(editId);
    if (receipt.projectId !== projectId) fail('Edit belongs to another project', 404);
    if (receipt.draftRevision !== draftRevision) fail('draftRevision does not match the prepared edit', 409);
    if (receipt.state !== 'prepared' && receipt.state !== 'submitted') {
      fail(`Cannot submit from state ${receipt.state}`, 409);
    }
    // Idempotent replay of the same request UUID.
    if (receipt.jobId && receipt.submitRequestId === requestId) {
      return { ok: true, replay: true, editId, jobId: receipt.jobId, state: receipt.state };
    }
    if (fingerprint !== receipt.quoteFingerprint && fingerprint !== receipt.inputKey) {
      fail('fingerprint does not match the prepared edit', 409);
    }
    if (Number.isFinite(receipt.quote?.estimate) && maxCostUsd + 1e-9 < (receipt.quote.reservationRequiredUsd ?? receipt.quote.estimate * 1.1)) {
      fail('maxCostUsd is below the required reservation', 400);
    }

    const support = await materializeSupportMedia(receipt);
    const definition = await ensureMaskedDefinition();
    const parameters = {
      width: support.cropMeta.width,
      height: support.cropMeta.height,
      frames: support.cropMeta.frameCount,
      seed: receipt.seed,
      steps: 20,
      fps: 24,
      model: 'wan2.1_vace_14B_fp16.safetensors',
    };
    const bound = await genRoute('bind', {
      revision: engineProject.get().revision,
      definitionId: definition.id,
      shotId: support.engineShotId,
      assetBindings: {
        sourceVideo: { assetId: support.cropAsset.id },
        maskVideo: { assetId: support.maskAsset.id },
      },
      prompt: receipt.prompt,
      parameters,
      acceptTimingChange: true,
    });
    const genInput = {
      requestId,
      revision: bound.project.revision,
      workflowBindingId: bound.workflowBindingId,
      backend: { kind: 'cloud' },
    };
    const { job: quoted } = await genRoute('quote', genInput);
    if (!quoted?.fingerprint) fail('Generation quote did not return a fingerprint', 500);
    if (!Number.isFinite(quoted.quote?.estimate)) fail(quoted.quote?.estimateRefused || 'No reliable estimate is available. Nothing submitted.');
    const reservation = quoted.quote.reservationRequiredUsd ?? quoted.quote.estimate * 1.1;
    if (maxCostUsd + 1e-9 < reservation) fail('Run allowance is below the required reservation. Nothing submitted.');
    const genApproval = {
      approved: true,
      fingerprint: quoted.fingerprint,
      allowance: {
        currency: 'USD',
        maxAmount: maxCostUsd,
        allowUnknownCharges: true,
      },
    };
    const { job } = await genRoute('submit', { ...genInput, approval: genApproval });
    receipt.state = 'submitted';
    receipt.jobId = job.id;
    receipt.submitRequestId = requestId;
    receipt.workflowBindingId = bound.workflowBindingId;
    receipt.supportAssets = { cropAssetId: support.cropAsset.id, maskAssetId: support.maskAsset.id };
    receipt.generationFingerprint = quoted.fingerprint;
    receipt.updatedAt = now();
    receipt.providerDispatch = true;
    await saveReceipt(receipt);
    log(`[masked-edit] submitted ${editId} → job ${job.id}`);
    return {
      ok: true,
      replay: false,
      editId,
      jobId: job.id,
      job,
      quote: quoted.quote,
      fingerprint: quoted.fingerprint,
      state: receipt.state,
    };
  }

  /**
   * Offline local composite from already-decoded RGB frames (tests / post-patch recovery).
   * Writes a quarantined candidate receipt; does not attach a take or call a provider.
   */
  async function compositeFromFrames({ editId, projectId, sourceFrames, patchFrames } = {}) {
    assertUuid(projectId, 'projectId');
    const receipt = await loadReceipt(editId);
    if (receipt.projectId !== projectId) fail('Edit belongs to another project', 404);
    if (!['prepared', 'compositing', 'verifying', 'ready-for-review'].includes(receipt.state) && receipt.state !== 'failed-local') {
      fail(`Cannot composite from state ${receipt.state}`);
    }
    const dir = editDir(editId);
    const alpha = new Uint8Array(await readFile(safeEditPath(dir, 'mask.bin')));
    const crop = receipt.cropRect;
    const { width, height, frameCount } = {
      width: ELIGIBLE_WIDTH, height: ELIGIBLE_HEIGHT,
      frameCount: receipt.sourceTiming.frameCount,
    };
    if (!Array.isArray(sourceFrames) || sourceFrames.length !== frameCount) fail(`Need exactly ${frameCount} source frames`);
    if (!Array.isArray(patchFrames) || patchFrames.length !== frameCount) fail(`Need exactly ${frameCount} patch frames`);

    receipt.state = 'compositing'; receipt.updatedAt = now(); await saveReceipt(receipt);
    const composites = [];
    const report = { frames: frameCount, outsideExact: true, failedFrame: null, checkedOutside: 0 };
    for (let i = 0; i < frameCount; i++) {
      const src = Buffer.from(sourceFrames[i]);
      const patch = Buffer.from(patchFrames[i]);
      if (src.length !== width * height * 3) fail(`Source frame ${i} has wrong byte length`);
      if (patch.length !== crop.w * crop.h * 3) fail(`Patch frame ${i} has wrong byte length`);
      const out = compositeFrame(src, patch, alpha, width, height, crop);
      const check = verifyOutsideExact(src, out, alpha);
      report.checkedOutside += check.checked;
      if (!check.ok) {
        report.outsideExact = false;
        report.failedFrame = i;
        receipt.state = 'failed-local';
        receipt.preservation = report;
        receipt.updatedAt = now();
        await saveReceipt(receipt);
        await atomicJson(safeEditPath(dir, 'preservation.json'), report);
        fail(`Outside-mask preservation failed on frame ${i}`, 422, 'preservation');
      }
      composites.push(out);
    }

    receipt.state = 'verifying'; receipt.updatedAt = now(); await saveReceipt(receipt);
    // Quarantine: store raw composite frames hash (authoritative pre-encode bytes). Encoding to MP4 is optional offline.
    const flat = Buffer.concat(composites);
    const candidateSha256 = sha(flat);
    await writeFile(safeEditPath(dir, 'composite.rgb'), flat, { mode: 0o600 });
    await writeFile(safeEditPath(dir, 'candidate.sha256'), candidateSha256 + '\n', { mode: 0o600 });
    report.candidateSha256 = candidateSha256;
    report.compositeVersion = COMPOSITE_VERSION;
    await atomicJson(safeEditPath(dir, 'preservation.json'), report);

    receipt.state = 'ready-for-review';
    receipt.candidateSha256 = candidateSha256;
    receipt.preservation = report;
    receipt.updatedAt = now();
    await saveReceipt(receipt);
    log(`[masked-edit] candidate ready ${editId} (quarantined; not a take)`);
    return { editId, state: receipt.state, candidateSha256, preservation: report };
  }

  async function review(input = {}) {
    const projectId = assertUuid(input.projectId, 'projectId');
    const editId = assertUuid(input.editId, 'editId');
    const candidateSha256 = String(input.candidateSha256 || '');
    const sourceSha256 = String(input.sourceSha256 || '');
    const fingerprint = String(input.fingerprint || '');
    if (input.reviewedScope !== true) fail('reviewedScope must be true');
    if (!/^[a-f0-9]{64}$/.test(candidateSha256)) fail('candidateSha256 must be a 64-char hex digest');
    if (!/^[a-f0-9]{64}$/.test(sourceSha256)) fail('sourceSha256 must be a 64-char hex digest');

    const receipt = await loadReceipt(editId);
    if (receipt.projectId !== projectId) fail('Edit belongs to another project', 404);
    if (receipt.state !== 'ready-for-review' && receipt.state !== 'accepted') fail(`Edit is not ready for review (state: ${receipt.state})`);
    if (receipt.candidateSha256 !== candidateSha256) fail('candidateSha256 does not match the verified candidate', 409);
    if (receipt.sourceSha256 !== sourceSha256) fail('sourceSha256 does not match the prepared source', 409);
    if (fingerprint && fingerprint !== receipt.inputKey && fingerprint !== receipt.quoteFingerprint) {
      fail('fingerprint does not match the prepared edit', 409);
    }

    const reviewId = randomUUID();
    receipt.review = {
      id: reviewId,
      candidateSha256,
      sourceSha256,
      maskHash: receipt.maskHash,
      inputKey: receipt.inputKey,
      preservationReportId: receipt.preservation?.candidateSha256 || candidateSha256,
      reviewedAt: now(),
      reviewedScope: true,
    };
    receipt.updatedAt = now();
    await saveReceipt(receipt);
    return { reviewId, editId, state: receipt.state, candidateSha256, sourceSha256 };
  }

  async function accept(input = {}) {
    const projectId = assertUuid(input.projectId, 'projectId');
    const editId = assertUuid(input.editId, 'editId');
    const candidateSha256 = String(input.candidateSha256 || '');
    const reviewId = assertUuid(input.reviewId, 'reviewId');
    const acceptanceId = assertUuid(input.acceptanceId || randomUUID(), 'acceptanceId');
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) fail('expectedRevision must be a non-negative integer');
    if (!/^[a-f0-9]{64}$/.test(candidateSha256)) fail('candidateSha256 must be a 64-char hex digest');

    const receipt = await loadReceipt(editId);
    if (receipt.projectId !== projectId) fail('Edit belongs to another project', 404);

    // Idempotent replay.
    if (receipt.state === 'accepted' && receipt.acceptance?.id === acceptanceId) {
      return { accepted: true, replay: true, assetId: receipt.acceptance.assetId, editId, revision: null };
    }
    if (receipt.state === 'accepted' && receipt.acceptance?.candidateSha256 === candidateSha256) {
      return { accepted: true, replay: true, assetId: receipt.acceptance.assetId, editId, revision: null };
    }

    const project = await director.get(projectId);
    const parent = (project.assets || []).find(a => a.id === receipt.sourceAssetId);
    const check = validateAcceptanceState({
      receipt, candidateSha256, sourceSha256: receipt.sourceSha256, reviewId,
      project, shotId: receipt.shotId, parentAsset: parent,
    });
    if (!check.ok) fail(check.issues[0] || 'Acceptance refused', 409);

    if (project.revision !== expectedRevision) {
      // Unrelated revision bumps may rebase; still revalidate parent bytes.
      if (!parent || parent.sha256 !== receipt.sourceSha256) fail('The project changed. Refresh and review the saved result; nothing was overwritten.', 409, 'revision');
    }

    const dir = editDir(editId);
    const flat = await readFile(safeEditPath(dir, 'composite.rgb'));
    if (sha(flat) !== candidateSha256) fail('Candidate bytes no longer match candidateSha256', 409);

    // Encode quarantined RGB frames to a durable project MP4 (local only).
    const assetId = randomUUID();
    const frameCount = receipt.sourceTiming.frameCount;
    const tmpRaw = join(dir, 'composite.rgb');
    const outMp4 = join(dir, `${assetId}.mp4`);
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${ELIGIBLE_WIDTH}x${ELIGIBLE_HEIGHT}`, '-r', String(receipt.sourceTiming.fps || 24),
      '-i', tmpRaw,
      '-frames:v', String(frameCount),
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', outMp4,
    ]);
    const mp4 = await readFile(outMp4);
    const mp4Sha = sha(mp4);
    let encodedMeta;
    try { encodedMeta = await inspectOutputVideo(mp4, { mime: 'video/mp4' }); }
    catch (e) { fail(`Encoded candidate could not be inspected: ${e.message}`); }
    if (encodedMeta.frameCount !== frameCount) fail(`Encoded frame count ${encodedMeta.frameCount} ≠ ${frameCount}`, 422, 'timing');
    if (encodedMeta.width !== ELIGIBLE_WIDTH || encodedMeta.height !== ELIGIBLE_HEIGHT) fail('Encoded dimensions changed', 422, 'timing');
    if (encodedMeta.audio) fail('Encoded candidate must be silent', 422, 'timing');

    const maskedEdit = buildMaskedEditProvenance({
      editId,
      parent,
      rootId: rootAssetId(project, parent),
      maskHash: receipt.maskHash,
      featherPx: receipt.featherPx,
      cropRect: receipt.cropRect,
      sourceTiming: receipt.sourceTiming,
      prompt: receipt.prompt,
      negativePrompt: receipt.negativePrompt,
      seed: receipt.seed,
      compositeSha256: candidateSha256,
      inputKey: receipt.inputKey,
      quoteFingerprint: receipt.quoteFingerprint,
      estimateUsd: receipt.quote?.estimate ?? null,
      reviewId,
      preservationReportId: receipt.preservation?.candidateSha256 || candidateSha256,
      patchJobId: null,
      patchResultId: null,
      patchSha256: null,
    });
    maskedEdit.acceptedAt = now();

    // Publish project-owned bytes without touching winner/cut (no director.mjs hook in foundation).
    const fileName = `${assetId}.mp4`;
    const assetFile = `assets/${fileName}`;
    const asset = {
      id: assetId,
      kind: 'workflow-result',
      shotId: receipt.shotId,
      file: assetFile,
      mime: 'video/mp4',
      sha256: mp4Sha,
      width: encodedMeta.width,
      height: encodedMeta.height,
      fps: encodedMeta.fps,
      frameCount: encodedMeta.frameCount,
      duration: encodedMeta.duration,
      createdAt: now(),
      source: {
        sourceAssetId: parent.id,
        jobId: null,
        resultId: assetId,
        workflow: MASKED_EDIT_WORKFLOW,
        backend: 'local',
        prompt: receipt.prompt,
        cameraSource: cameraSourceForMaskedEdit(parent),
        quote: { status: 'unknown', amount: null, currency: 'USD' },
        maskedEdit,
      },
    };
    const published = await publishAcceptedTake({ projectId, asset, bytes: mp4, prior: project });

    receipt.state = 'accepted';
    receipt.acceptance = { id: acceptanceId, assetId, candidateSha256, acceptedAt: maskedEdit.acceptedAt, encodeSha256: mp4Sha };
    receipt.updatedAt = now();
    await saveReceipt(receipt);
    try { await copyFile(outMp4, safeEditPath(dir, 'candidate.mp4')); } catch { /* optional recovery copy */ }
    log(`[masked-edit] accepted ${editId} → take ${assetId} (cut unchanged)`);
    return { accepted: true, replay: false, assetId, editId, revision: published.revision, project: published.project };
  }

  /**
   * Append one workflow-result take under data/director/<id>/ and refresh the director cache.
   * Does not call winnerOps / set_edit / set_winner. Foundation-only until director gains accept-composite.
   */
  async function publishAcceptedTake({ projectId, asset, bytes, prior }) {
    assertUuid(projectId, 'projectId');
    if ((prior.assets || []).some(a => a.id === asset.id)) {
      return { project: prior, revision: prior.revision, replay: true };
    }
    const projectDir = join(root, 'director', projectId);
    const assetsDir = join(projectDir, 'assets');
    await mkdir(assetsDir, { recursive: true });
    const dest = join(assetsDir, `${asset.id}.mp4`);
    // Refuse path tricks — asset.id is a UUID from randomUUID().
    if (!UUID.test(asset.id)) fail('asset id must be a UUID');
    try { await access(dest); fail('Asset file already exists', 409); } catch (e) { if (e.status) throw e; }
    await writeFile(dest, bytes, { flag: 'wx', mode: 0o600 });

    const winnerBefore = prior.shots.find(s => s.id === asset.shotId)?.winner ?? null;
    const cutBefore = structuredClone(prior.edit?.clips || null);
    const next = structuredClone(prior);
    (next.assets ||= []).push(asset);
    next.revision = (Number(next.revision) || 0) + 1;
    next.updatedAt = now();
    await atomicJson(join(projectDir, 'project.json'), next);

    // Bust openDirector's in-memory cache without editing director.mjs (archive drops the entry).
    await director.archive(projectId);
    const restored = await director.restore(projectId);
    const p = restored.project;
    const shot = p.shots.find(s => s.id === asset.shotId);
    if ((shot?.winner ?? null) !== winnerBefore) fail('Accept must not change the winner', 500);
    if (JSON.stringify(p.edit?.clips || null) !== JSON.stringify(cutBefore)) fail('Accept must not change the cut', 500);
    if (!(p.assets || []).some(a => a.id === asset.id)) fail('Accepted take missing after publish', 500);
    return { project: p, revision: p.revision, replay: false };
  }

  async function routes(method, url, input) {
    const path = url.pathname.replace(/\/$/, '');
    const base = '/api/director/masked-edit';
    if (!path.startsWith(base)) return undefined;
    const sub = path.slice(base.length) || '/';
    if (method === 'GET' && (sub === '/status' || sub === 'status')) {
      return status({ projectId: url.searchParams.get('projectId'), editId: url.searchParams.get('editId') });
    }
    if (method !== 'POST') fail('Method not allowed', 405);
    if (sub === '/prepare' || sub === 'prepare') return prepare(input);
    if (sub === '/submit' || sub === 'submit') return submit(input);
    if (sub === '/review' || sub === 'review') return review(input);
    if (sub === '/accept' || sub === 'accept') return accept(input);
    fail('Unknown masked-edit route', 404);
  }

  return { prepare, submit, status, review, accept, compositeFromFrames, routes, editDir, loadReceipt, grayPng };
}
