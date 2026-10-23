import test from 'node:test';
import assert from 'node:assert/strict';
import { browserDelivery, browserVideoPlan } from '../shared/browser-delivery.mjs';
import { validateBrowser, openProject } from '../server/previs/store.mjs';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('browser delivery persists exact supported settings and survives restart without modifying legacy snapshots',async()=>{
  const camera={t:0,p:[0,1,4],q:[0,0,0,1],mm:35},input={camera,subject:[0,2,-11],frames:[camera,{...camera,t:71/24}],delivery:{width:1280,height:720,fps:24}};
  const browser=validateBrowser(input);assert.deepEqual(browser.delivery,{width:1280,height:720,fps:24,aspect:'16:9'});
  const root=await mkdtemp(join(tmpdir(),'previs-delivery-')),store=await openProject(root);
  await store.mutate(store.get().revision,p=>p.shots.push({id:'capture',browser}));
  assert.deepEqual((await openProject(root)).get().shots[0].browser,browser);
  const {delivery,...legacy}=input;assert.equal(validateBrowser(legacy).delivery,undefined);
  assert.deepEqual(browserDelivery(),{width:640,height:360,fps:24,aspect:'16:9'});
  for(const bad of [{width:1920,height:1080},{width:1280,height:360},{fps:30},{width:'1280',height:720}])assert.throws(()=>validateBrowser({...input,delivery:bad}),/Choose 640/);
});

test('delivery plan exposes final sample and encoded duration; never silently trims or changes FPS',()=>{
  const plan=browserVideoPlan([{t:0},{t:71/24}],{width:1280,height:720,fps:24});
  assert.equal(plan.frameCount,72);assert.equal(plan.duration,3);assert.equal(plan.sampledEndTime,71/24);
  const offGrid=browserVideoPlan([{t:0},{t:2.99}],{fps:24});assert.equal(offGrid.recordedDuration,2.99);assert.equal(offGrid.sampledEndTime,71/24);assert.equal(offGrid.duration,3);
  assert.throws(()=>browserVideoPlan([{t:5}],{}),/121 frames/);assert.throws(()=>browserVideoPlan([{t:1}],{fps:12}),/24 fps/);
});
