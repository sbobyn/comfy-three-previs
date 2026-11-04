import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectOutputVideo } from '../server/previs/media-inspect.mjs';

test('real output probe reports returned audio and timing without fitting to capture limits',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'previs-output-test-')), file=join(dir,'result.mp4');
  const run=spawnSync(process.env.PREVIS_FFMPEG||'ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=32x18:r=12:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',file],{encoding:'utf8'});
  assert.equal(run.status,0,run.error?.message||run.stderr);
  const bytes=await readFile(file), metadata=await inspectOutputVideo(bytes,{mime:'video/mp4'});
  assert.equal(metadata.audio,true);assert.equal(metadata.audioStreams.length,1);
  assert.equal(metadata.width,32);assert.equal(metadata.height,18);
  assert.equal(metadata.frameCount,12);assert.equal(metadata.fps,12);assert.equal(metadata.duration,1);
  assert.deepEqual(await readFile(file),bytes);
  await assert.rejects(inspectOutputVideo(bytes,{mime:'application/octet-stream'}),/Unsupported/);
});
