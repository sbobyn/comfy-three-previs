import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {createServer} from 'node:http';
import {once} from 'node:events';
import * as THREE from 'three';
import ts from 'typescript';
import WebSocket from 'ws';
const require=createRequire(import.meta.url),root=resolve(dirname(new URL(import.meta.url).pathname),'..');
const cache={};
function load(relative){
  const file=resolve(root,relative);if(cache[file])return cache[file];const exports={};cache[file]=exports;
  const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  runInNewContext(code,{exports,require:id=>id.startsWith('.')?load(resolve(dirname(file),id+'.ts')):id==='three'?THREE:require(id),console,URL,Buffer,TextEncoder});return exports;
}
const core=load('src/director-phone-core.ts'),orientation=load('src/orientation.ts'),qr=load('src/qr.ts');
const R=Math.PI/180;
const euler=q=>new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...q),'YXZ');
const camQ=(yaw,pitch=0,roll=0)=>new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch*R,yaw*R,roll*R,'YXZ')).toArray();
const msg=(o)=>JSON.stringify(o);
const same=(a,b)=>assert.deepEqual(JSON.parse(JSON.stringify(a)),b); // vm objects come from another realm
function phone(){const aim=new core.PhoneAim();aim.socketOpen=true;aim.receive(msg({t:'presence',controller:true}),0);return aim;}
/** Streams a constant pose at 60 Hz from `from` for `ms`; returns the time reached. */
function stream(aim,q,from,ms){let t=from;for(;t<from+ms;t+=1000/60){aim.receive(msg({t:'q',q}),t);aim.orientation(t);}return t;}

test('phone message parsing accepts only relay presence and validated phone input',()=>{
  same(core.parseInbound(msg({t:'presence',controller:true})),{t:'presence',controller:true,owner:null});
  assert.equal(core.parseInbound(msg({t:'presence',controller:true,owner:false})).owner,false);
  assert.equal(core.parseInbound(msg({t:'presence'})),null);
  same(core.parseInbound(msg({t:'q',q:[0,0,0,1]})),{t:'q',q:[0,0,0,1]});
  assert.equal(core.parseInbound(msg({t:'q',q:[0,0,0,2]})),null,'non-unit quaternion');
  assert.equal(core.parseInbound(msg({t:'q',q:[0,0,1]})),null);
  assert.equal(core.parseInbound(msg({t:'lens',mm:500})),null);
  same(core.parseInbound(msg({t:'lens',mm:50})),{t:'lens',mm:50});
  assert.equal(core.parseInbound(msg({t:'rig',pos:[0,0,0]})),null,'viewer messages are not phone input');
  assert.equal(core.parseInbound('not json'),null);
  assert.equal(core.parseInbound('null'),null);
  for(const t of ['record','recenter','pause'])assert.equal(core.parseInbound(msg({t})).t,t);
});

test('device orientation maps an upright phone to a level camera looking down -Z, turning left yaws left',()=>{
  const q=orientation.deviceQuaternion(new THREE.Quaternion(),0,90,0);
  const forward=new THREE.Vector3(0,0,-1).applyQuaternion(q),up=new THREE.Vector3(0,1,0).applyQuaternion(q);
  assert.ok(forward.distanceTo(new THREE.Vector3(0,0,-1))<1e-9);assert.ok(up.distanceTo(new THREE.Vector3(0,1,0))<1e-9);
  const left=new THREE.Vector3(0,0,-1).applyQuaternion(orientation.deviceQuaternion(new THREE.Quaternion(),90,90,0));
  assert.ok(left.distanceTo(new THREE.Vector3(-1,0,0))<1e-9,'alpha +90 looks toward -X');
  const tilted=new THREE.Vector3(0,0,-1).applyQuaternion(orientation.deviceQuaternion(new THREE.Quaternion(),0,120,0));
  assert.ok(tilted.y>0.4,'tilting the top back past vertical looks up');
});

test('first sample zeroes yaw only; pitch and roll stay absolute; recenter re-zeroes and reports a button',()=>{
  const aim=phone();
  let t=stream(aim,camQ(40,20,10),0,300);
  let e=euler(aim.orientation(t));
  assert.ok(Math.abs(e.y)<1e-6,'yaw zeroed');assert.ok(Math.abs(e.x/R-20)<1e-4);assert.ok(Math.abs(e.z/R-10)<1e-4);
  t=stream(aim,camQ(70,20,10),t,1500);
  e=euler(aim.orientation(t));assert.ok(Math.abs(e.y/R-30)<0.5,`turned 30° from zero, got ${e.y/R}`);
  assert.equal(aim.receive(msg({t:'recenter'}),t),'rezero');
  e=euler(aim.orientation(t+1));assert.ok(Math.abs(e.y/R)<0.01,'recenter snaps heading to zero');assert.ok(Math.abs(e.x/R-20)<0.5,'pitch untouched');
  aim.rezero();assert.ok(Math.abs(euler(aim.orientation(t+20)).y)<0.01);
});

test('smoothing removes hand tremor while holding and still converges on a whip',()=>{
  const aim=phone();let t=0,seed=7;const rand=()=>((seed=(seed*16807)%2147483647)/2147483647-0.5);
  const inYaw=[],outYaw=[];
  for(let i=0;i<240;i++,t+=1000/60){const noisy=rand()*1.0;inYaw.push(noisy);aim.receive(msg({t:'q',q:camQ(10+noisy,0,0)}),t);if(i>30)outYaw.push(euler(aim.orientation(t)).y/R);else aim.orientation(t);}
  const sd=a=>{const m=a.reduce((s,v)=>s+v,0)/a.length;return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/a.length);};
  assert.ok(sd(outYaw)<sd(inYaw.slice(31))/3,`deshake: ${sd(outYaw)} vs ${sd(inYaw)}`);
  t=stream(aim,camQ(100,0,0),t,800);
  assert.ok(Math.abs(euler(aim.orientation(t)).y/R-90)<1,'whip of 90° converges within 0.8 s');
});

test('watchdogs: hold while paused, stop aiming when silent or the phone leaves',()=>{
  const aim=phone();
  assert.equal(aim.motion(0),'none');assert.equal(aim.orientation(0),null);assert.match(aim.status(0),/Enable motion/);
  const t=stream(aim,camQ(0,5,0),0,200);
  assert.equal(aim.motion(t),'streaming');assert.match(aim.status(t),/Streaming motion/);
  assert.equal(aim.motion(t+1500),'paused');assert.notEqual(aim.orientation(t+1500),null);
  assert.equal(aim.motion(t+2500),'silent');assert.equal(aim.orientation(t+2500),null);
  stream(aim,camQ(0,5,0),t+3000,100);assert.equal(aim.motion(t+3100),'streaming');
  aim.receive(msg({t:'presence',controller:false}),t+3200);assert.equal(aim.orientation(t+3200),null);assert.equal(aim.connected(),false);assert.match(aim.status(t+3200),/No phone/);
  const other=phone();other.receive(msg({t:'presence',controller:true,owner:false}),0);assert.match(other.status(0),/Another Comfy Previs window/);
  other.disconnected();assert.match(other.status(0),/offline/);
});

test('phone buttons and lens: record, lens and ping round trip',()=>{
  const aim=phone();
  assert.equal(aim.receive(msg({t:'record'}),0),'record');
  assert.equal(aim.lensMm(),null);aim.receive(msg({t:'lens',mm:85}),0);assert.equal(aim.lensMm(),85);
  const id=aim.ping(100);aim.receive(msg({t:'pong',id}),140);assert.equal(aim.stats(140).halfRtt,20);
  assert.equal(aim.receive(msg({t:'control',active:true,input:{forward:0,lateral:0,vertical:0,yaw:0,pitch:0}}),0),null);
});

test('base yaw helpers point a zeroed phone along a shot',()=>{
  assert.ok(Math.abs(core.yawToward([0,1,5],[0,1,0]))<1e-12,'looking down -Z is yaw 0');
  assert.ok(Math.abs(core.yawToward([0,0,0],[-3,0,0])-Math.PI/2)<1e-12,'looking toward -X is +90°');
  const q=core.withBaseYaw(camQ(0,-10,0),Math.PI/2),e=euler(q);
  assert.ok(Math.abs(e.y-Math.PI/2)<1e-9&&Math.abs(e.x/R+10)<1e-6);
});

test('QR encoder: sizes, finder patterns and a valid level-M format word',()=>{
  const url='https://192.168.1.23:5443/phone.html#'+'x'.repeat(32);
  const m=qr.qrMatrix(url);assert.equal(m.length,37,'version 5 for a pairing link');
  assert.equal(qr.qrMatrix('hi').length,21);assert.throws(()=>qr.qrMatrix('a'.repeat(300)));
  const finder=[[1,1,1,1,1,1,1],[1,0,0,0,0,0,1],[1,0,1,1,1,0,1],[1,0,1,1,1,0,1],[1,0,1,1,1,0,1],[1,0,0,0,0,0,1],[1,1,1,1,1,1,1]];
  for(const [ox,oy] of [[0,0],[m.length-7,0],[0,m.length-7]])for(let y=0;y<7;y++)for(let x=0;x<7;x++)assert.equal(m[oy+y][ox+x],!!finder[y][x]);
  let f=0;for(let i=0;i<=5;i++)f|=(m[i][8]?1:0)<<i;f|=(m[7][8]?1:0)<<6;f|=(m[8][8]?1:0)<<7;f|=(m[8][7]?1:0)<<8;for(let i=9;i<15;i++)f|=(m[8][14-i]?1:0)<<i;
  f^=0x5412;const data=f>>>10;let rem=data;for(let i=0;i<10;i++)rem=(rem<<1)^((rem>>>9)*0x537);
  assert.equal(((data<<10)|rem)&0x7fff,f,'BCH check');assert.equal(data>>>3,0,'level M');
  assert.match(qr.qrSvg(url),/^<svg[^>]+viewBox="0 0 45 45"/);
});

test('relay: a claiming viewer is the only one that steers the phone; ownership ends when it leaves',async()=>{
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const {attachRelay}=load('server/relay.ts');const relay=attachRelay(server);const base=`ws://127.0.0.1:${server.address().port}/vcam`;
  const open=async role=>{const ws=new WebSocket(`${base}?role=${role}`);ws.inbox=[];ws.on('message',raw=>ws.inbox.push(JSON.parse(raw.toString())));await once(ws,'open');return ws;};
  const settle=()=>new Promise(r=>setTimeout(r,60));
  const a=await open('viewer'),b=await open('viewer'),p=await open('phone');
  try{
    a.send(msg({t:'claim'}));await settle();
    assert.equal(a.inbox.filter(m=>m.t==='presence').at(-1).owner,true);assert.equal(b.inbox.filter(m=>m.t==='presence').at(-1).owner,false);
    b.send(msg({t:'rig',from:'b'}));a.send(msg({t:'rig',from:'a'}));await settle();
    assert.deepEqual(p.inbox.map(m=>m.from),['a']);
    p.send(msg({t:'q',q:[0,0,0,1]}));await settle();assert.ok(a.inbox.some(m=>m.t==='q')&&b.inbox.some(m=>m.t==='q'),'phone samples still reach every viewer');
    a.close();await settle();
    assert.equal(b.inbox.filter(m=>m.t==='presence').at(-1).owner,undefined);
    b.send(msg({t:'rig',from:'b'}));await settle();assert.deepEqual(p.inbox.map(m=>m.from),['a','b']);
  }finally{for(const ws of [a,b,p])ws.terminate();relay.close();await new Promise(r=>server.close(r));}
});
