import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import * as THREE from 'three';
import ts from 'typescript';
const root=resolve(dirname(new URL(import.meta.url).pathname),'..'),req=createRequire(resolve(root,'package.json'));
class Element {
 constructor(){this.value='';this.type='';this.tagName='DIV';this.checked=false;this.disabled=false;this.dataset={};this.style={};this.children=[];this.events={};this.classList={toggle(){}};}
 addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
 dispatch(name,data={}){for(const fn of this.events[name]??[])fn({target:this,preventDefault(){},...data});}
 click(){if(!this.disabled)this.dispatch('click');}
 append(child){this.children.push(child);}setAttribute(){}setPointerCapture(){}querySelectorAll(){return [];}
}
function fixture(){
const html=readFileSync(resolve(root,'index.html'),'utf8'),elements={};
for(const match of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)){let e=new Element();e.tagName=match[1].toUpperCase();e.value=/\bvalue="([^"]*)"/.exec(match[0])?.[1]??'';e.checked=/\bchecked\b/.test(match[0]);e.type=/\btype="([^"]*)"/.exec(match[0])?.[1]??'';elements[match[2]]=e;}
elements.deviceSource.value='keyboard';elements.padLayout.value='game';elements.format.value='1.77778';
let now=0,raf=null,adopt,update=()=>{};
const win=new Element(),body=new Element(),doc=new Element();doc.body=body;doc.hidden=false;doc.hasFocus=()=>true;doc.getElementById=id=>elements[id]??null;doc.createElement=()=>new Element();
const position=new THREE.Vector3(10,5,20),pov=new THREE.PerspectiveCamera();pov.position.copy(position);pov.setFocalLength(35);
const studio={pov,rawPov:new THREE.PerspectiveCamera(),setCameraPosition:p=>pov.position.copy(p),setFocalLength:mm=>pov.setFocalLength(mm),setFormat(){},setDemo(){},setDollyProgress(){},setRawVisible(){},render(){},subjectPosition:()=>[0,0,0]};
const pads=[];const sockets=[];const sent=[];elements.previsRecord=new Element();elements.previsRecord.dataset.recording='false';elements.previsRecord.click=()=>{elements.previsRecord.dataset.recording=String(elements.previsRecord.dataset.recording!=='true');};
class Socket extends Element{static OPEN=1;constructor(){super();this.readyState=1;sockets.push(this);}send(text){sent.push(JSON.parse(text));} }
const context={console,HTMLElement:Element,window:win,document:doc,performance:{now:()=>now},navigator:{getGamepads:()=>pads},location:{protocol:'http:',host:'localhost:5190'},WebSocket:Socket,setInterval(){},setTimeout(){},requestAnimationFrame:fn=>raf=fn,fetch:()=>Promise.reject(Error('Unexpected HTTP')),Event:class{constructor(type){this.type=type;}}};
const cache={};
function load(file){file=resolve(root,file);if(cache[file])return cache[file];const exports={};cache[file]=exports;runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{...context,exports,require:id=>{
 if(id==='./dom')return{element:id=>elements[id]??(()=>{throw Error('missing '+id)})()};
 if(id==='./scene')return{createStudio:()=>studio};
 if(id==='./previs-camera')return{installPrevisCamera:(_s,callback)=>{adopt=callback;return()=>update();}};
 return id.startsWith('.')?load(resolve(dirname(file),id+'.ts')):req(id);
}});return exports;}
load('src/main.ts');
const tick=(ms=16)=>{now+=ms;raf();};
const enable=()=>elements.deviceEnable.dispatch('click');
const message=value=>sockets[0].dispatch('message',{data:JSON.stringify(value)});
return {elements,win,doc,studio,pads,sockets,sent,tick,enable,message,setUpdate:fn=>update=fn,adopt:pose=>adopt(pose)};
}
test('actual main simulation: socket loss disarms; reconnect cannot resume without explicit enable',()=>{
 const h=fixture();h.elements.deviceSource.value='phone';h.message({t:'presence',controller:true});h.enable();
 const move={t:'control',active:true,input:{forward:1,lateral:0,vertical:0,yaw:0,pitch:0}};
 h.message(move);for(let i=0;i<10;i++)h.tick();
 h.sockets[0].dispatch('close');const before=h.studio.pov.position.clone();
 h.message({t:'presence',controller:true});h.message(move);for(let i=0;i<10;i++)h.tick();
 assert.equal(h.studio.pov.position.distanceTo(before),0);assert.match(h.elements.deviceStatus.textContent,/explicitly enable/);
 h.enable();h.message(move);for(let i=0;i<10;i++)h.tick();assert.ok(h.studio.pov.position.distanceTo(before)>0);
});
test('actual main simulation: phone receives resolved replay pose and lens, not live drone pose',()=>{
 const h=fixture();h.elements.deviceSource.value='phone';h.message({t:'presence',controller:true});h.enable();
 h.win.dispatch('previs:pause-controls');h.doc.body.dataset.previsPlayback='true';
 const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2,0.4,0));
 h.setUpdate(()=>{h.studio.pov.position.set(4,5,6);h.studio.pov.quaternion.copy(q);h.studio.pov.setFocalLength(85);});h.tick();
 const rig=h.sent.filter(m=>m.t==='rig').at(-1);assert.deepEqual(Array.from(rig.pos),[4,5,6]);assert.ok(new THREE.Quaternion().fromArray(rig.aim).angleTo(q)<1e-7);assert.ok(Math.abs(rig.mm-85)<1e-7);
 h.enable();assert.match(h.elements.deviceStatus.textContent,/Pause replay/);
});
test('actual main simulation: Xbox A arms then records/stops, held button never repeats',()=>{
 const h=fixture();h.elements.deviceSource.value='gamepad';
 const pad={connected:true,index:0,id:'Xbox',mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({value:0,pressed:false}))};h.pads.push(pad);h.tick();
 const press=index=>{pad.buttons[index].pressed=true;h.tick();pad.buttons[index].pressed=false;h.tick();};
 press(0);assert.equal(h.elements.previsRecord.dataset.recording,'false');
 press(0);assert.equal(h.elements.previsRecord.dataset.recording,'true');
 pad.buttons[0].pressed=true;h.tick();h.tick();assert.equal(h.elements.previsRecord.dataset.recording,'false');
 pad.buttons[0].pressed=false;h.tick();press(0);assert.equal(h.elements.previsRecord.dataset.recording,'true');
 h.win.dispatch('blur');assert.equal(h.elements.previsRecord.dataset.recording,'false');
});

test('actual main simulation: stale phone control stops the take and requires rearming',()=>{
 const h=fixture();h.elements.deviceSource.value='phone';h.message({t:'presence',controller:true});h.enable();
 h.message({t:'control',active:true,input:{forward:1,lateral:0,vertical:0,yaw:0,pitch:0}});h.elements.previsRecord.click();h.tick(16);h.tick(400);
 assert.equal(h.elements.previsRecord.dataset.recording,'false');assert.match(h.elements.deviceStatus.textContent,/Phone input stopped/);
 const position=h.studio.pov.position.clone();h.message({t:'control',active:true,input:{forward:1,lateral:0,vertical:0,yaw:0,pitch:0}});h.tick();assert.equal(h.studio.pov.position.distanceTo(position),0);
});
