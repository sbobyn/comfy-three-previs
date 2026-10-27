import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

// Exercise the actual keyboard listeners without creating a renderer or device.
const source=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
const listeners=source.slice(source.indexOf('const typingInto ='),source.indexOf('const deviceSource ='));
const compiled=ts.transpileModule(listeners,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
test('pilot movement survives button focus while Space/Enter keep native control activation',()=>{
  class Element {constructor(tagName,type){this.tagName=tagName;this.type=type;}}
  const handlers={},heldKeys=new Set(),PILOT_KEYS=new Set(['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','Space','ShiftLeft']);
  runInNewContext(compiled,{HTMLElement:Element,heldKeys,PILOT_KEYS,isPiloting:()=>true,window:{addEventListener:(name,handler)=>handlers[name]=handler}});
  function down(tag,code,type){let prevented=false;handlers.keydown({target:new Element(tag,type),code,preventDefault(){prevented=true;}});return prevented;}
  for(const tag of ['BUTTON','SUMMARY','A']){
    assert.equal(down(tag,'KeyW'),true);assert.equal(heldKeys.has('KeyW'),true);handlers.keyup({code:'KeyW'});
    assert.equal(down(tag,'Space'),false);assert.equal(heldKeys.has('Space'),false);
    assert.equal(down(tag,'Enter'),false);
  }
  for(const tag of ['INPUT','SELECT','TEXTAREA']){assert.equal(down(tag,'KeyW'),false);assert.equal(heldKeys.has('KeyW'),false);}
  for(const type of ['range','checkbox']){assert.equal(down('INPUT','KeyW',type),true);assert.equal(heldKeys.has('KeyW'),true);handlers.keyup({code:'KeyW'});}
  assert.equal(down('INPUT','ArrowLeft','range'),false);assert.equal(heldKeys.has('ArrowLeft'),false);
  assert.equal(down('INPUT','Space','checkbox'),false);assert.equal(heldKeys.has('Space'),false);
  assert.equal(down('DIV','Space'),true);assert.equal(heldKeys.has('Space'),true);handlers.blur();assert.equal(heldKeys.size,0);
});
