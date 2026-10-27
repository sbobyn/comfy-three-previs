import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {request} from 'node:https';
import {once} from 'node:events';
import * as THREE from 'three';
import ts from 'typescript';
import WebSocket from 'ws';
import {startPhoneLan} from '../server/previs/phone-lan.mjs';
const require=createRequire(import.meta.url),root=resolve(dirname(new URL(import.meta.url).pathname),'..');
function load(relative,extra={}){
  const file=resolve(root,relative),exports={};
  const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  runInNewContext(code,{exports,require:id=>id.startsWith('.')?load(resolve(dirname(file),id+'.ts'),extra):require(id),console,URL,Buffer,...extra});return exports;
}
const game=load('src/gamepad.ts'),flight=load('src/flight.ts'),protocol=load('server/phone-protocol.ts');
function pad(){return{connected:true,index:0,id:'Xbox One',mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};}
const settings=game.defaultStickSettings();
test('Xbox mapping preserves movement, pitch, triggers, slow/fast and radial limits',()=>{
  const p=pad();p.axes=[1,-1,1,-1];p.buttons[7].value=1;
  let value=game.readGamepad(settings,p,'game');assert.ok(value.forward>0&&value.lateral>0&&value.pitch>0&&value.yaw>0);assert.ok(Math.hypot(value.forward,value.lateral)<=1.00001);assert.equal(value.vertical,1);
  p.buttons[5].pressed=true;value=game.readGamepad(settings,p);assert.equal(value.vertical,2.5);assert.ok(value.yaw<1);
  p.buttons[4].pressed=true;assert.equal(game.readGamepad(settings,p).vertical,0.3);
  p.buttons[7].value=0;p.buttons[6].value=1;assert.equal(game.readGamepad(settings,p).vertical,-0.3);
  assert.equal(game.readGamepad(settings,{...p,mapping:''}),null);
});
test('arming waits for neutral, disconnect never selects another controller',()=>{
  const session=new game.GamepadSession(),p=pad();p.axes[0]=0.6;assert.equal(session.start(p),true);assert.equal(session.read([p],settings,'game'),null);
  p.axes[0]=0;p.buttons[6].value=0.5;assert.equal(session.read([p],settings,'game'),null);
  p.buttons[6].value=0;assert.equal(Math.abs(session.read([p],settings,'game').forward),0);
  const second={...pad(),index:1,id:'Other pad'};assert.equal(session.read([second],settings,'game'),null);assert.match(session.status,/disconnected/);
  assert.equal(session.read([p],settings,'game'),null);
});
test('flight adopts current camera pose; pause clears velocity and time steps are bounded',()=>{
  const drone=new flight.Drone(),position=new THREE.Vector3(12,4,-8),q=new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4,0.7,0,'YXZ')),config=flight.defaultFlightSettings();
  drone.adopt(position,q);assert.ok(drone.position.distanceTo(position)<1e-10);assert.ok(drone.orientation(new THREE.Quaternion(),config).angleTo(q)<1e-7);
  drone.update({forward:1,lateral:0,vertical:0,yaw:0,pitch:1},10,config);assert.ok(drone.position.distanceTo(position)<1);assert.ok(drone.speed>0);drone.halt();assert.equal(drone.speed,0);
});
test('phone input cannot relay arbitrary commands, invalid quaternions or unbounded numbers',()=>{
  for(const message of [{t:'kick'},{t:'rig'},{t:'q',q:[0,0,0,0]},{t:'q',q:[0,0,0,2]},{t:'lens',mm:999},{t:'control',active:true,input:{forward:3,lateral:0,vertical:0,yaw:0,pitch:0}}])assert.equal(protocol.validPhoneMessage(JSON.stringify(message)),false);
  assert.equal(protocol.validPhoneMessage('{'),false);
  assert.equal(protocol.validPhoneMessage(JSON.stringify({t:'q',q:[0,0,0,1]})),true);
  assert.equal(protocol.validPhoneMessage(JSON.stringify({t:'control',active:true,input:{forward:2.5,lateral:0,vertical:0,yaw:1,pitch:0}})),true);
});

test('real TLS phone listener keeps project APIs private and requires exact pairing/origin',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'previs-phone-transport-')),certs=join(directory,'certs');
  execFileSync(process.execPath,[join(root,'scripts/phone-certificate.mjs'),certs,'localhost'],{stdio:'pipe'});
  const {mkdir,writeFile}=await import('node:fs/promises');await mkdir(join(directory,'dist/.vite'),{recursive:true});await mkdir(join(directory,'dist/assets'));
  await writeFile(join(directory,'dist/phone.html'),'phone');await writeFile(join(directory,'dist/assets/phone.js'),'phone JS');
  await writeFile(join(directory,'dist/.vite/manifest.json'),JSON.stringify({'phone.html':{file:'assets/phone.js'}}));
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const {attachRelay}=load('server/relay.ts');const relay=attachRelay(server);
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const ca=await readFile(join(certs,'ca.crt'));
  const lan=await startPhoneLan({root:directory,relay,env:{PREVIS_PHONE_PORT:String(port),PREVIS_PHONE_HOST:'LOCALHOST',PREVIS_PHONE_CERT:join(certs,'server.crt'),PREVIS_PHONE_KEY:join(certs,'server.key'),PREVIS_PHONE_CA:join(certs,'ca.crt')}});
  let viewer,phone;
  try{
    assert.equal(lan.readiness().available,true,lan.readiness().error);
    const get=path=>new Promise((done,fail)=>{const req=request(`https://localhost:${port}${path}`,{ca,family:4},res=>{res.resume();res.on('end',()=>done(res.statusCode));});req.on('error',fail);req.end();});
    assert.equal(await get('/phone.html'),200);assert.equal(await get('/assets/phone.js'),200);assert.equal(await get('/api/project'),404);assert.equal(await get('/generation.html'),404);assert.equal(await get('/assets/other.js'),404);assert.equal(await get('/phone-ca.crt'),200);
    const old=lan.pair(),current=lan.pair();
    const connect=async(token,origin=`https://localhost:${port}`,role='phone')=>{const ws=new WebSocket(`wss://localhost:${port}/vcam?role=${role}&token=${token}`,{ca,origin,family:4});await once(ws,'open');return ws;};
    await assert.rejects(connect(new URL(old.url).hash.slice(1)));
    await assert.rejects(connect(new URL(current.url).hash.slice(1),'https://evil.invalid'));
    await assert.rejects(connect(new URL(current.url).hash.slice(1),undefined,'viewer'));
    viewer=new WebSocket(`ws://127.0.0.1:${server.address().port}/vcam?role=viewer`,{origin:`http://127.0.0.1:${server.address().port}`});await once(viewer,'open');
    phone=await connect(new URL(current.url).hash.slice(1));
    const message=new Promise(resolve=>{viewer.on('message',raw=>{const value=JSON.parse(raw.toString());if(value.t==='q')resolve(value);});});phone.send(JSON.stringify({t:'q',q:[0,0,0,1]}));assert.deepEqual((await message).q,[0,0,0,1]);
    const closed=once(phone,'close');lan.revoke();assert.equal((await closed)[0],4001);
    await assert.rejects(connect(new URL(current.url).hash.slice(1)));
  }finally{viewer?.terminate();phone?.terminate();lan.close();relay.close();await new Promise(r=>server.close(r));}
});

test('gamepad button edges ignore held connect buttons and require a new press',()=>{
 const edges=new game.GamepadButtons(),p=pad();p.buttons[0].pressed=true;
 assert.equal(edges.read(p).length,0);assert.equal(edges.read(p).length,0);
 p.buttons[0].pressed=false;edges.read(p);p.buttons[0].pressed=true;assert.deepEqual(Array.from(edges.read(p)),[0]);assert.equal(edges.read(p).length,0);
 p.id='Replacement';assert.equal(edges.read(p).length,0);
});
