import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as THREE from 'three';
const source=await readFile(new URL('../src/phone.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
class Element {
 constructor(){this.events={};this.style={};this.value='portrait';this.disabled=false;}
 addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
 emit(name,event={}){for(const fn of this.events[name]??[])fn({preventDefault(){},...event});}
 setPointerCapture(){}
}
function fixture(permission=Promise.resolve(true)){
 const fields={},element=id=>fields[id]??=new Element(),win=new Element(),doc=new Element();doc.hidden=false;
 const sent=[],intervals=[];let now=100,socket,sample;
 class Socket {static OPEN=1;constructor(){this.readyState=1;socket=this;}send(text){sent.push(JSON.parse(text));}close(){}}
 const viewfinder={camera:new THREE.PerspectiveCamera(),setPosition(){},setFormat(){},setFocalLength(){},setSubjectPosition(){},render(){}};
 runInNewContext(compiled,{exports:{},require:id=>{
  if(id==='./dom')return{element};
  if(id==='./lens')return{mmToSlider:()=>0.5,sliderToMm:()=>35};
  if(id==='./orientation')return{applyGrip:()=>{},requestMotionPermission:()=>permission,onDeviceQuaternion:fn=>{sample=fn;return()=>sample=null;}};
  if(id==='./protocol')return{relayUrl:()=>'/vcam',EVICTED_BY_VIEWER:4001,REPLACED_BY_NEWER:4000};
  if(id==='./scene')return{createViewfinder:()=>viewfinder};throw Error(id);
 },performance:{now:()=>now},WebSocket:Socket,window:win,document:doc,navigator:{},requestAnimationFrame(){},setTimeout(){},clearTimeout(){},setInterval:fn=>intervals.push(fn)});
 socket.onopen();
 const rig=()=>socket.onmessage({data:JSON.stringify({t:'rig',pos:[0,0,0],aim:[0,0,0,1],format:16/9,controls:{enabled:true,recording:false}})});rig();
 return{fields,sent,win,doc,rig,get sample(){return sample;},tick:ms=>{now+=ms;intervals.forEach(fn=>fn());},async enable(){fields.enable.onclick();await new Promise(r=>setImmediate(r));},async touch(){fields.touchOnly.onclick();await new Promise(r=>setImmediate(r));},move(){fields.movePad.emit('pointerdown',{pointerId:1,clientX:0,clientY:0});fields.movePad.emit('pointermove',{pointerId:1,clientX:0,clientY:-50});}};
}
test('actual phone simulation: permission alone never enables movement; stalled samples pause',async()=>{
 const h=fixture();await h.enable();h.move();h.tick(33);
 assert.equal(h.sent.some(m=>m.t==='control'&&m.active),false);
 h.sample(new THREE.Quaternion());h.move();h.tick(33);assert.equal(h.sent.at(-1).active,true);assert.equal(h.sent.at(-1).input.forward,1);
 h.tick(600);assert.equal(h.sent.filter(m=>m.t==='control').at(-1).active,false);assert.equal(h.sent.at(-1).t,'pause');assert.match(h.fields.sensor.textContent,/Motion samples unavailable/);assert.equal(h.sample,null);
});
test('actual phone simulation: touch-only needs no motion sample and cancels movement on focus loss',async()=>{
 const h=fixture();await h.touch();h.move();h.tick(33);assert.equal(h.sent.at(-1).input.forward,1);
 h.win.emit('blur');assert.equal(h.sent.at(-1).t,'pause');const control=h.sent.filter(m=>m.t==='control').at(-1);assert.equal(control.active,false);assert.equal(control.input.forward,0);h.tick(33);assert.equal(h.sent.at(-1).t,'pause');
});
test('actual phone simulation: hidden page cancels a pending permission grant',async()=>{
 let grant;const permission=new Promise(resolve=>grant=resolve),h=fixture(permission);h.fields.enable.onclick();h.doc.hidden=true;h.doc.emit('visibilitychange');grant(true);await new Promise(r=>setImmediate(r));
 assert.equal(h.sample,undefined);assert.equal(h.fields.start.hidden,false);assert.equal(h.sent.some(m=>m.t==='recenter'),false);
});
