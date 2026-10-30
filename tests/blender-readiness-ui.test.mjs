// Simulation: actual workspace adapter with fake readiness; no Blender process or network.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const source=await readFile(new URL('../src/previs.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.style={};this.disabled=false;this.value='';}
 append(...x){this.children.push(...x);}
 replaceChildren(...x){this.children=[];this.append(...x);}
 click(){if(!this.disabled)return this.onclick?.();}
}
class Select extends Element{
 constructor(){super('select');}
 get options(){return this.children;}
 get value(){return this.selected?.value||'';}
 set value(v){this.selected=this.children.find(x=>x.value===v);}
 append(...x){super.append(...x);if(!this.selected)this.selected=this.children[0];}
 replaceChildren(...x){this.selected=undefined;super.replaceChildren(...x);}
}
const descendants=e=>e.children.flatMap(x=>[x,...descendants(x)]);
async function fixture(){
 const elements=new Map();
 const el=id=>{if(!elements.has(id))elements.set(id,['scene','camera'].includes(id)?new Select():new Element(['save','connect','refresh','reconcile','cancel-binding'].includes(id)?'button':'div'));return elements.get(id);};
 el('save').dataset.blenderLive='';
 const all=()=>[...elements.values()].flatMap(x=>[x,...descendants(x)]);
 let interval;
 let blender={configured:true,process:{name:'fixture'},addon:'inspected',error:null,operation:null};
 let failConnect=false;
 const project={revision:1,shots:[{id:'shot',title:'Saved',binding:{source:'blender',scene:'Scene',camera:'Camera',start:1,end:24,frame:1,fps:24},renders:[]}],renders:[]};
 const fetch=async(path)=>{
  let value;
  if(path==='/api/project')value={project};
  else if(path==='/api/generation')value={jobs:[]};
  else if(path==='/api/readiness')value={blender};
  else if(path==='/api/blender/refresh'){
   if(failConnect)return {ok:false,json:async()=>({error:'simulated disconnected'})};
   value={serverInfo:{name:'fixture'},catalog:{file:'fixture.blend',token:'token',scenes:[{name:'Scene',fps:24,start:1,end:24,cameras:['Camera']}]}};
  }else throw Error('Unexpected path '+path);
  return {ok:true,json:async()=>structuredClone(value)};
 };
 runInNewContext(compiled,{exports:{},require:()=>({}),document:{getElementById:el,createElement:tag=>new Element(tag),querySelectorAll:selector=>all().filter(x=>x.tag==='button'&&(selector==='button'||x.dataset.blenderLive!==undefined))},fetch,setInterval:fn=>{interval=fn;}});
 const settle=()=>new Promise(r=>setImmediate(r));await settle();
 return {el,blender,setFail:v=>{failConnect=v;},tick:async()=>{interval();await settle();}};
}
test('review simulation: connect, failed reconnect, successful reconnect, running and uncertain gate controls',async()=>{
 const h=await fixture();assert.equal(h.el('save').disabled,true);
 await h.el('connect').click();assert.equal(h.el('save').disabled,false);
 h.setFail(true);await h.el('connect').click();assert.equal(h.el('save').disabled,true);
 h.setFail(false);await h.el('connect').click();assert.equal(h.el('save').disabled,false);
 h.blender.operation={status:'running'};await h.tick();assert.equal(h.el('save').disabled,true);
 h.blender.operation={status:'uncertain',reason:'fixture'};await h.tick();assert.equal(h.el('save').disabled,true);
 h.blender.operation=null;await h.tick();assert.equal(h.el('save').disabled,false);
});
test('review reproducer: MCP process exit disables live controls',async()=>{
 const h=await fixture();await h.el('connect').click();assert.equal(h.el('save').disabled,false);
 // Matches BlenderMcp.start fail(): serverInfo becomes null; connectionError and catalog are untouched.
 h.blender.process=null;await h.tick();
 console.log('After MCP process exit:',JSON.stringify({process:h.blender.process,error:h.blender.error,saveDisabled:h.el('save').disabled}));
 assert.equal(h.el('save').disabled,true,'known absent MCP process must disable live controls');
});
