import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { normalizePose, applyBlockoutPose } from '../shared/blockout-pose.mjs';
import { makeEntity, entityAt, setKeyframes, upsertKey, shotSignature, videoReferences } from '../shared/director.mjs';
import { createProjectDocument, applyOps } from '../server/previs/director.mjs';
import { loadStarters } from '../server/previs/starters.mjs';
import { videoPromptPlan } from '../shared/prompt-plan.mjs';
import { autoPromptCap } from '../shared/model-params.mjs';
import { cameraSourceOf } from '../shared/camera-source.mjs';
import { maxReferences } from '../shared/video-refs.mjs';
import { builtInPresets } from '../server/previs/presets.mjs';
const starters = await loadStarters();
const loadRig = async name => { const b = readFileSync(new URL(`../public/models/blockouts/${name}.glb`, import.meta.url)); return (await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset+b.byteLength), '')).scene; };

test('pose keys sanitize, blend, ease, retain unwrapped spins and survive partial edits and reverse seeks', () => {
  assert.deepEqual(normalizePose({ head: [1,2,3], evil: [1,2,3], armL: [Infinity,0,0] }), { head: [1,2,3] });
  const e = makeEntity({ shape: 'person', model: 'player' }, 'player');
  e.path = setKeyframes(e, [{ t: 0, position: [0,0,0], pose: { head: [0,0,0], wheelFL: [0,0,0] }, ease: 'smoothstep' }, { t: 2, position: [2,0,0], pose: { head: [20,0,0], wheelFL: [720,0,0] } }]);
  assert.equal(entityAt(e,.5).position[0], .3125);
  assert.equal(entityAt(e,1).pose.wheelFL[0], 360);
  assert.equal(entityAt(e,2).pose.head[0], 20);
  assert.equal(entityAt(e,.5).pose.head[0], 3.125);
  e.path = upsertKey(e.path,0,[0,0,0],90);
  assert.deepEqual(e.path[0].pose.head,[0,0,0]);
  assert.equal(e.path[0].ease,'smoothstep');
  e.path = setKeyframes(e,[{t:2,pose:{}}]);
  assert.deepEqual(entityAt(e,2).pose,{});
});

test('agent edit ops persist poses and invalidate media; unposed legacy mesh fidelity stays compatible', () => {
  const p = createProjectDocument({template:'empty'});
  applyOps(p,[{op:'add_entity',entity:{name:'Actor',shape:'person',model:'player',pose:{armR:[-90,0,0]}}},{op:'add_shot',shot:{title:'Pose'}}]);
  const e=p.scene.entities[0],s=p.shots[0],sig=shotSignature(p,s);
  applyOps(p,[{op:'set_keyframes',id:e.id,keys:[{t:0,pose:{armR:[-90,0,0]},ease:'smoothstep'},{t:1,pose:{armR:[-150,0,0]}}]}]);
  assert.equal(entityAt(e,.5).pose.armR[0],-120);
  assert.notEqual(shotSignature(p,s),sig);
  applyOps(p,[{op:'clear_animation',id:e.id},{op:'update_entity',id:e.id,patch:{pose:null}}]);
  assert.equal(e.pose,undefined);
  const legacy=shotSignature(p,s); delete e.model;
  assert.equal(shotSignature(p,s),legacy);
});

test('authored GLB joints move geometry and reset deterministically without resizing the rig', async () => {
  for (const [name,joint,pose] of [['player','joint_armR',{armR:[-150,0,0]}],['eagle','joint_wingL',{wingL:[0,0,-35]}],['race-car','joint_wheelFL',{wheelFL:[100,0,0]}],['elk','joint_head',{head:[25,0,0]}]]) {
    const rig=await loadRig(name), node=rig.getObjectByName(joint);
    assert.ok(node,`${name}: named pivot present`);
    const scale=rig.scale.toArray(); rig.updateMatrixWorld(true);
    let mesh; node.traverse(o=>{if(o.isMesh)mesh=o;});
    const vertex=()=>new Vector3().fromBufferAttribute(mesh.geometry.attributes.position,0).applyMatrix4(mesh.matrixWorld);
    const start=vertex();applyBlockoutPose(rig,pose);rig.updateMatrixWorld(true);assert.ok(vertex().distanceTo(start)>.01,`${name}: vertex moves`);
    applyBlockoutPose(rig,{});rig.updateMatrixWorld(true);assert.ok(vertex().distanceTo(start)<1e-6,`${name}: reverse seek restores rest`);
    assert.deepEqual(rig.scale.toArray(),scale);
  }
});

test('every basketball frame keeps shoes above the floor; dribbles touch down and the dunk clears the rim', async () => {
  const p=starters.find(s=>s.slug==='posterized'),rig=await loadRig('player');
  for(const e of p.scene.entities.filter(e=>e.model==='player'&&e.path))for(let frame=0;frame<13*24;frame++){
    const a=entityAt(e,frame/24);applyBlockoutPose(rig,a.pose);rig.updateMatrixWorld(true);
    const feet=new Box3().setFromObject(rig,true).min.y*e.scale[1]+a.position[1];
    assert.ok(feet>=.045,`${e.name}: shoe penetrates the court at frame ${frame}: ${feet}`);
  }
  const ball=p.scene.entities.find(e=>e.name==='Basketball');
  for(let t=.5;t<9;t++)assert.ok(Math.abs(entityAt(ball,t).position[1]-.055)<1e-9,'ball bottom contacts court at each bounce');
  assert.ok(entityAt(ball,10.85).position[1]>3.05);
  assert.ok(entityAt(ball,11.25).position[1]+.24<3.05);
});

test('all starter video prompt plans fit each model cap with action, lead identity and camera rule intact', () => {
  for(const p of structuredClone(starters))for(const s of p.shots)for(const media of ['existing', 'regenerated'])for(const model of builtInPresets.filter(d=>d.inputs?.prompt)){
    if(media==='regenerated')for(const r of s.references||[])if(r.generated)r.generated.signature=shotSignature(p,s);
    const cameraSource=cameraSourceOf(model), refs=model.task==='first-frame'?[]:videoReferences(p,s,maxReferences(model),{stills:cameraSource==='blockout'});
    const plan=videoPromptPlan(p,s,{cameraSource,refs,cap:autoPromptCap(model),maxLength:model.constraints?.promptMaxLength});
    const where=`${p.slug}/${s.title}/${model.id}`;
    assert.ok(plan.length<=autoPromptCap(model),`${where}: ${plan.length}`);
    assert.equal(plan.cameraWarning,'',where);
    assert.equal(plan.cut,false,where);
    for(const key of ['action','camera',`obj:${s.camera.target}`])assert.ok(plan.sections.some(r=>r.key===key&&['included','shortened'].includes(r.status)),`${where}: missing ${key}`);
    assert.ok(plan.sections.filter(r=>!r.system).every(r=>!r.cameraWords?.length),where);
  }
});

test('the eagle soars: near-level wings with a slight dihedral, six fingered primaries per hand, mirrored wings and a tail', async () => {
  const rig = await loadRig('eagle'); rig.updateMatrixWorld(true);
  const at = name => rig.getObjectByName(name).getWorldPosition(new Vector3());
  for (const side of ['L', 'R']) {
    const shoulder = at(`joint_wing${side}`), wrist = at(`joint_tip${side}`);
    const dihedral = Math.atan2(wrist.y - shoulder.y, Math.abs(wrist.x - shoulder.x)) * 180 / Math.PI;
    assert.ok(dihedral > 2 && dihedral < 10, `${side}: shoulder-to-wrist dihedral ${dihedral.toFixed(1)}° is a soaring glide, not a V`);
    const tip = rig.getObjectByName(`joint_tip${side}`), meshes = []; tip.traverse(o => { if (o.isMesh) meshes.push(o); });
    assert.ok(meshes.length >= 7, `${side}: the hand and six separate primaries`);
  }
  const l = at('joint_tipL'), r = at('joint_tipR');
  assert.ok(Math.abs(l.x + r.x) < 1e-6 && Math.abs(l.y - r.y) < 1e-6 && Math.abs(l.z - r.z) < 1e-6, 'wings mirror each other');
  assert.ok(rig.getObjectByName('joint_tail'), 'tail pivot');
  // Every wing part sits in the outer half of the proxy span: the wings, not the body, set the silhouette's width.
  const wing = new Box3().setFromObject(rig.getObjectByName('joint_wingR'), true);
  assert.ok(wing.max.x > 1.15 && wing.min.x < 0.15, 'right wing spans from the body to the proxy edge');
});
