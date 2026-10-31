// Source truth (launch blocker L3): stills made for an earlier blocking are never sent as current, on any path; free
// text that directs the camera is surfaced. The browser, batch and agent share shared/director.mjs videoReferences /
// keyStillState and the /api/director/video-refs route, so these checks cover all of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDirector, directorRoutes } from '../server/previs/director.mjs';
import { keyStillState, shotSignature, videoReferences } from '../shared/director.mjs';
import { cameraMotionWords, cameraMotionWarning, CAMERA_LINES, withCameraLine } from '../shared/camera-source.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';

test('a camera edit makes generated start/end stills stale: readiness says so and no path sends them', async () => {
  const director = await openDirector(await mkdtemp(join(tmpdir(), 'previs-source-truth-')));
  let p = await director.create({ template: 'street' });
  const s0 = p.shots[0], made = shotSignature(p, s0);
  // Generated key frames, made for the current blocking (as refgen records them), plus an uploaded mid-shot still.
  for (const at of ['start', 'end']) p = (await director.reference(p.id, { shotId: s0.id, role: 'frame', note: `key frame ${at}`, data: PNG, generated: { requestId: `req-${at}`, outputKey: 'o1', signature: made, model: 'FLUX 3' } })).project;
  let s = p.shots[0];
  assert.deepEqual([keyStillState(p, s).startState, keyStillState(p, s).endState], ['ready', 'ready']);
  assert.deepEqual(videoReferences(p, s, 4, { stills: true }).filter(r => r.role === 'frame').map(r => r.label), ['start still', 'end still']);

  // The review's repro: move the camera. Both stills now show the old framing.
  p = (await director.edit(p.id, [{ op: 'update_shot', id: s.id, patch: { camera: { angle: s.camera.angle + 40 } } }])).project; s = p.shots[0];
  const st = keyStillState(p, s);
  assert.deepEqual([st.startState, st.endState], ['stale', 'stale'], 'readiness reports stale, not "Start still ready"');
  assert.deepEqual(videoReferences(p, s, 4, { stills: true }).filter(r => r.role === 'frame'), [], 'stale stills never lead the look references');
  assert.deepEqual(videoReferences(p, s, 4).filter(r => r.role === 'frame'), [], 'nor ride along as the key-frame reference');

  // The shared route refuses them for start-frame models (browser, batch and agent all prepare through it).
  const engine = { get: () => ({ shots: [{ id: 'ps1', browser: { director: { shotId: s.id } } }], renders: [] }), append: () => { throw Error('nothing may be registered'); } };
  const route = directorRoutes(director, engine);
  const post = (path, body) => route('POST', new URL('http://x' + path), body);
  await assert.rejects(post('/api/director/video-refs', { projectId: p.id, shotId: s.id, previsShotId: 'ps1', max: 2, firstFrame: true, lastFrame: true }),
    e => e.status === 409 && e.apiCode === 'stale-still' && /start and end stills were made before the shot’s camera, timing or scene changed.*nothing was sent/.test(e.message));
  await assert.rejects(post('/api/director/video-refs', { projectId: p.id, shotId: s.id, previsShotId: 'ps1', max: 2, firstFrame: true, lastFrame: false }), e => e.apiCode === 'stale-still' && /The start still was/.test(e.message), 'a start-only model checks only the start');
  assert.deepEqual((await post('/api/director/video-refs', { projectId: p.id, shotId: s.id, previsShotId: 'ps1', max: 4, stills: true })).references.filter(r => r.role === 'frame'), [], 'a blockout model gets no stale look stills');

  // An uploaded still is the artist's choice and never stale; a new generated still for the new blocking is ready.
  p = (await director.reference(p.id, { shotId: s.id, role: 'frame', note: 'key frame end', data: PNG })).project;
  p = (await director.reference(p.id, { shotId: s.id, role: 'frame', note: 'key frame start', data: PNG, generated: { requestId: 'req-new', outputKey: 'o1', signature: shotSignature(p, p.shots[0]), model: 'FLUX 3' } })).project;
  assert.deepEqual([keyStillState(p, p.shots[0]).startState, keyStillState(p, p.shots[0]).endState], ['ready', 'ready']);
});

test('camera-motion words in free text are found outside the camera line; object motion is not', () => {
  assert.deepEqual(cameraMotionWords('Slow dolly left, whip pan to the car.'), ['dolly left', 'whip pan']);
  assert.deepEqual(cameraMotionWords('The runner sprints. Crane down as the camera pushes in; tracking shot.'), ['Crane down', 'camera pushes', 'tracking shot']);
  assert.deepEqual(cameraMotionWords('Zoom in on the badge, pan left across the street, handheld'), ['Zoom in', 'pan left', 'handheld']);
  for (const line of Object.values(CAMERA_LINES)) assert.deepEqual(cameraMotionWords(withCameraLine('The actor turns, the car speeds across the frame and a frying pan sizzles; the crane swings the cargo.', line === CAMERA_LINES.blockout ? 'blockout' : line === CAMERA_LINES.keyframes ? 'keyframes' : 'still')), [], 'camera lines and object motion are fine');
  assert.equal(cameraMotionWarning('A quiet street.'), '');
  assert.match(cameraMotionWarning('Whip pan to the car.', 'blockout'), /“Whip pan”.*camera comes from the blockout clip/);
  assert.match(cameraMotionWarning('Dolly in.', 'keyframes'), /start and end stills/);
});
