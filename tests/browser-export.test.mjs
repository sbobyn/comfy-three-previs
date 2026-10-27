import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import ts from 'typescript';
import * as delivery from '../shared/browser-delivery.mjs';

// Simulation: execute the actual TS adapter with a small DOM/studio and fake HTTP.
// No browser, renderer, server, Blender or Comfy process runs in these tests.
const source = await readFile(new URL('../src/previs-camera.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const first = { t: 0, p: [0, 1, 4], q: [0, 0, 0, 1], mm: 35 };
const last = { t: 2 / 24, p: [4, 3, 0], q: [0, Math.SQRT1_2, 0, Math.SQRT1_2], mm: 55 };
const savedSubject = [1, 2, -11];

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.style = {}; this.dataset = {};
    this.attributes = {}; this.disabled = false; this.textContent = ''; this.value = '';
  }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelectorAll(selector) {
    const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    if (selector === '*') return all;
    if (selector === 'input[type=number]') return all.filter(child => child.tag === 'input' && child.type === 'number');
    assert.ok(['input,button','input,button,select'].includes(selector));
    return all.filter(child => ['input','button',...(selector.endsWith('select')?['select']:[])].includes(child.tag));
  }
  click() { if (!this.disabled) return this.onclick?.(); }
  input(value) { if (!this.disabled) { this.value = String(value); return this.oninput?.(); } }
}
function deferred() {
  let resolve;
  const promise = new Promise(done => resolve = done);
  return { promise, resolve };
}
function close(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-10, `${value} != ${expected[i]}`));
}
function samePose(actual, expected) {
  close(actual.p, expected.p); close(actual.q, expected.q); close([actual.mm], [expected.mm]);
}

async function fixture({ frames = [first, last], onFrame, failAt, abortFails = false, settings } = {}) {
  const body = new Element('body'), pov = new THREE.PerspectiveCamera();
  let subject = [0, 0, 0], now = 0, reads = 0;
  const captures = [], requests = [], adopted = [];
  const snapshot = () => ({ p: pov.position.toArray(), q: pov.quaternion.toArray(), mm: pov.getFocalLength() });
  const studio = {
    pov,
    subjectPosition: () => [...subject],
    setSubjectPosition: value => { subject = [...value]; },
    setCameraPosition: value => pov.position.copy(value),
    setFocalLength: value => pov.setFocalLength(value),
    capture(width, height) {
      const capture = { ...snapshot(), subject: [...subject], width, height };
      captures.push(capture);
      return 'data:image/png;base64,' + Buffer.from(JSON.stringify(capture)).toString('base64');
    },
  };
  const project = { revision: 7, shots: [{ id: 'saved', title: 'Saved camera', binding: { source: 'three' }, browser: { camera: first, frames, subject: savedSubject, sceneVersion: 1, ...(settings?{delivery:settings}:{}) } }] };
  const exportProject = structuredClone(project);
  const response = (data, ok = true) => ({ ok, json: async () => data });
  const fetch = async (path, options) => {
    if (path === '/api/project') {
      reads++;
      if (reads > 1 && failAt === 'project') throw Error('simulated project failure');
      return response({ project: reads === 1 ? structuredClone(project) : exportProject });
    }
    assert.equal(options.method, 'POST');
    const input = JSON.parse(options.body), action = path.split('/').at(-1);
    requests.push({ path, action, input });
    assert.ok(path.startsWith('/api/video/browser/'), path);
    if (action === 'abort' && abortFails) throw Error('simulated abort network failure');
    if (action === failAt) return response({ error: `simulated ${action} failure` }, false);
    if (action === 'start') return response({ stage: { id: 'stage-1' } });
    if (action === 'frame') { await onFrame?.(input); return response({ index: input.index }); }
    if (action === 'finish') return response({ asset: { frameCount: captures.length, duration: captures.length / 24 } });
    assert.equal(action, 'abort');
    return response({ retained: true });
  };
  const exports = {};
  runInNewContext(compiled, {
    exports,
    require(name) { if(name==='../shared/browser-delivery.mjs')return delivery;assert.equal(name, 'three'); return THREE; },
    document: { body, createElement: tag => new Element(tag),querySelectorAll:selector=>body.querySelectorAll(selector) },
    performance: { now: () => now }, location: { search: '?shot=saved' },
    URLSearchParams, structuredClone, fetch,
  }, { filename: 'previs-camera.simulation.cjs' });
  const tick = exports.installPrevisCamera(studio, pose => adopted.push(structuredClone(pose)));
  await new Promise(resolve => setImmediate(resolve));
  const elements = body.querySelectorAll('*'), panel = body.children[0];
  const button = text => elements.find(element => element.tag === 'button' && element.textContent === text);
  const status = elements.find(element => element.tag === 'span');
  assert.equal(status.textContent, 'Restored browser shot');
  return {
    studio, tick, snapshot, captures, requests, adopted, exportProject, status,shortMove:exports.shortCameraMove,
    controls: panel.querySelectorAll('input,button,select'),
    record: button('Record shot'), play: button('Replay motion'), exportVideo: button('Export saved motion video'),
    title: elements.find(element => element.attributes['aria-label'] === 'Previs shot title'),
    timeline: elements.find(element => element.type === 'range'),
    subjectInput: elements.find(element => element.attributes['aria-label'] === 'Subject X'),
    resolution:elements.find(element=>element.attributes['aria-label']==='Delivery resolution'),
    plan:elements.find(element=>element.attributes['aria-label']==='Delivery plan'),
    setTime: value => { now = value; },
  };
}
function setPose(h, pose) {
  h.studio.setCameraPosition(new THREE.Vector3().fromArray(pose.p));
  h.studio.pov.quaternion.fromArray(pose.q); h.studio.setFocalLength(pose.mm);
}

test('simulation: actual TS export isolates saved trajectory and subject across async upload mutations', { timeout: 5000 }, async () => {
  const entered = deferred(), resume = deferred();
  const h = await fixture({ onFrame: async ({ index }) => { if (index === 0) { entered.resolve(); await resume.promise; } } });
  const liveFirst = { ...first, p: [30, 31, 32], mm: 68 }, liveLast = { ...last, p: [40, 41, 42], mm: 85 };
  const liveSubject = [8, 9, 10];
  setPose(h, liveFirst); h.studio.setSubjectPosition(liveSubject);
  // Live posing stays distinct from saved motion. A replacement recording now
  // invalidates the saved export selection and is covered by its own regression.
  h.setTime(100); setPose(h, liveLast); h.tick();
  h.title.disabled = true;
  const disabled = h.controls.map(control => control.disabled), original = h.snapshot();
  const exporting = h.exportVideo.click();
  try {
    await entered.promise;
    assert.ok(h.controls.every(control => control.disabled));
    h.record.click(); h.subjectInput.input(999); h.timeline.input(0);
    assert.equal(h.record.textContent, 'Record shot');

    // Controller updates and changes to the fetched object occur during an await.
    setPose(h, liveFirst); h.studio.setSubjectPosition([99, 98, 97]);
    h.setTime(20000); h.tick(); samePose(h.snapshot(), liveFirst);
    const fetched = h.exportProject.shots[0].browser;
    fetched.frames[0].p[0] = -500; fetched.frames[1].q[1] = 0;
    fetched.frames[1].mm = 500; fetched.subject[0] = -100;
  } finally { resume.resolve(); await exporting; }

  const expected = [first, { p: [2, 2, 2], q: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)], mm: 45 }, last];
  assert.equal(h.captures.length, 3);
  h.captures.forEach((capture, i) => {
    samePose(capture, expected[i]); assert.deepEqual(capture.subject, savedSubject);
    assert.equal(capture.width, 640); assert.equal(capture.height, 360);
  });
  assert.deepEqual(h.requests.map(request => request.action), ['start', 'frame', 'frame', 'frame', 'finish', 'abort']);
  assert.deepEqual(h.requests[0].input, { revision: 7, shotId: 'saved', width: 640, height: 360, fps: 24, frameCount: 3 });
  const uploads = h.requests.filter(request => request.action === 'frame');
  assert.deepEqual(uploads.map(request => request.input.index), [0, 1, 2]);
  uploads.forEach((request, i) => assert.deepEqual(JSON.parse(Buffer.from(request.input.png, 'base64')), h.captures[i]));
  assert.ok(h.requests.slice(1).every(request => request.input.stageId === 'stage-1'));
  samePose(h.snapshot(), original); samePose(h.adopted.at(-1), original);
  assert.deepEqual(h.studio.subjectPosition(), liveSubject);
  assert.deepEqual(h.controls.map(control => control.disabled), disabled);
  assert.match(h.status.textContent, /Video saved: 3 frames/);
  h.play.click(); h.tick(); samePose(h.snapshot(), first);
  h.setTime(20100); h.tick(); samePose(h.snapshot(), last);
});

for (const failAt of ['project', 'start', 'frame', 'finish']) {
  test(`simulation: actual TS export restores controls, camera and subject after ${failAt} failure`, async () => {
    const h = await fixture({ failAt, abortFails: true });
    const live = { ...last, p: [6, 7, 8], mm: 73 }, subject = [-1, -2, -3];
    setPose(h, live); h.studio.setSubjectPosition(subject); h.title.disabled = true;
    const disabled = h.controls.map(control => control.disabled);
    await h.exportVideo.click();
    assert.equal(h.status.textContent, `simulated ${failAt} failure`);
    samePose(h.snapshot(), live); samePose(h.adopted.at(-1), live);
    assert.deepEqual(h.studio.subjectPosition(), subject);
    assert.deepEqual(h.controls.map(control => control.disabled), disabled);
    assert.equal(h.requests.filter(request => request.action === 'abort').length, ['frame', 'finish'].includes(failAt) ? 1 : 0);
    if (failAt !== 'finish') assert.equal(h.requests.filter(request => request.action === 'finish').length, 0);
    h.record.click(); h.setTime(100); h.tick();
    assert.match(h.status.textContent, /Recording 0.1 s/, 'adapter resumes after its export guard is cleared');
  });
}

test('simulation: actual TS export clamps samples before the first saved pose and includes the final grid endpoint', async () => {
  const h = await fixture({ frames: [{ ...first, t: 1 / 24 }, last] });
  await h.exportVideo.click();
  assert.equal(h.captures.length, 3);
  [first, first, last].forEach((pose, i) => samePose(h.captures[i], pose));
  assert.match(h.status.textContent, /Video saved/);
});

test('simulation: actual TS export supports a single saved pose and restores already-disabled replay', async () => {
  const h = await fixture({ frames: [first] });
  const disabled = h.controls.map(control => control.disabled);
  await h.exportVideo.click();
  assert.equal(h.captures.length, 1); samePose(h.captures[0], first);
  assert.deepEqual(h.captures[0].subject, savedSubject);
  assert.deepEqual(h.controls.map(control => control.disabled), disabled);
  assert.equal(h.requests[0].input.frameCount, 1);
  assert.match(h.status.textContent, /Video saved: 1 frames/);
});

test('simulation: scrubbing applies the selected time before transport synchronization', async () => {
  const h = await fixture();
  h.timeline.input(1 / 24);
  samePose(h.snapshot(), { p:[2,2,2], q:[0,Math.sin(Math.PI/8),0,Math.cos(Math.PI/8)], mm:45 });
  assert.equal(Number(h.timeline.value), 1 / 24);
  h.timeline.input(2 / 24);
  samePose(h.snapshot(), last);
});

test('simulation: saved 720p delivery renders each saved pose at native target dimensions', async()=>{
  const h=await fixture({settings:{width:1280,height:720,fps:24,aspect:'16:9'}});
  assert.equal(h.resolution.value,'1280');assert.match(h.plan.textContent,/1280×720/);
  await h.exportVideo.click();
  assert.equal(h.requests[0].input.width,1280);assert.equal(h.requests[0].input.height,720);
  assert.equal(h.captures.length,3);assert.ok(h.captures.every(c=>c.width===1280&&c.height===720));
  samePose(h.captures[0],first);samePose(h.captures.at(-1),last);
});

test('simulation: changed delivery or unsupported recording length fails before capture/stage allocation',async()=>{
  const changed=await fixture();changed.resolution.value='1280';await changed.exportVideo.click();
  assert.match(changed.status.textContent,/Save a new shot/);assert.equal(changed.requests.length,0);assert.equal(changed.captures.length,0);
  const long=await fixture({frames:[first,{...last,t:5}]});await long.exportVideo.click();
  assert.match(long.status.textContent,/121 frames.*three-second preset/);assert.equal(long.requests.length,0);assert.equal(long.captures.length,0);
});

test('short camera moves have 72 exact delivery samples, normalized poses and a three-second video plan',async()=>{
  const h=await fixture();
  for(const kind of ['dolly','crane']){
    const samples=h.shortMove(kind,[0,2.2,-11],35);
    assert.equal(samples.length,72);assert.equal(samples[0].t,0);assert.equal(samples.at(-1).t,71/24);
    assert.equal(delivery.browserVideoPlan(samples,{width:1280,height:720,fps:24}).duration,3);
    assert.notDeepEqual(samples[0].p,samples.at(-1).p);
    samples.forEach((f,i)=>{assert.equal(f.t,i/24);assert.ok(Math.abs(Math.hypot(...f.q)-1)<1e-10);assert.equal(f.mm,35);});
  }
});


test('simulation: recording after restore prioritizes saving the new take over the old saved export',async()=>{
  const h=await fixture();
  assert.equal(h.exportVideo.className,'primary');
  h.record.click();
  assert.equal(h.exportVideo.className,'export-action');
  const save=h.controls.find(c=>c.textContent==='Save new shot & beauty');
  assert.equal(save.className,'primary');
});


test('simulation: starting a new recording refuses export of the previously saved shot',async()=>{
 const h=await fixture();h.record.click();await h.exportVideo.click();
 assert.match(h.status.textContent,/Save a short recorded shot first/);
 assert.equal(h.requests.length,0);assert.equal(h.captures.length,0);
});
