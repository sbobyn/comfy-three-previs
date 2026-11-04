import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Quaternion, Euler, Vector3 } from 'three';
import { cameraTransfer, projectTarget, verifyTransfer } from '../server/previs/transfer.mjs';
const pose={t:0,p:[0,2,4],q:[0,0,0,1],mm:35};
const shot={binding:{source:'three'},browser:{camera:pose,subject:[1,2,-11],frames:[pose,{...pose,t:1,p:[2,3,2],mm:50}]}};
test('camera-only transfer resamples exact endpoints, axes, lens and framing checks',()=>{
 const payload=cameraTransfer(shot);assert.equal(payload.end,25);assert.deepEqual(payload.checks,[1,13,25]);assert.deepEqual(payload.poses[12].p,[1,2.5,3]);assert.equal(payload.poses[12].mm,42.5);assert.equal(payload.scope,'camera-only');assert.equal(payload.poses.at(-1).t,1);
 const k=Math.SQRT1_2;
 const result={ok:true,fps:24,start:1,end:25,fileSaved:false,sensorWidth:36,sensorFit:'HORIZONTAL',unitScale:1,resolution:[640,360],checks:payload.checks.map(frame=>{const p=payload.poses[frame-1];return{frame,p:[p.p[0],-p.p[2],p.p[1]],q:[k,0,0,k],mm:p.mm,projected:payload.targets.map(t=>projectTarget(p,t))};})};
 assert.equal(verifyTransfer(payload,result).maximumProjectionError,0);
 assert.throws(()=>verifyTransfer(payload,{...result,fps:30}));
 const invalid=structuredClone(result);invalid.checks[0].p[0]=NaN;assert.throws(()=>verifyTransfer(payload,invalid));
 const mirrored=structuredClone(result);mirrored.checks[1].projected[0][0]+=0.1;assert.throws(()=>verifyTransfer(payload,mirrored));
 assert.equal(cameraTransfer({...shot,browser:{...shot.browser,frames:[]}}).end,1);
 const nonaligned=cameraTransfer({...shot,browser:{...shot.browser,frames:[pose,{...pose,t:1.01,p:[9,8,7]}]}});
 assert.equal(nonaligned.end,26);assert.equal(nonaligned.poses.at(-1).t,1.01);assert.deepEqual(nonaligned.poses.at(-1).p,[9,8,7]);
});
test('projection comparison matches the actual Three camera at nontrivial orientation and lens',()=>{
 const q=new Quaternion().setFromEuler(new Euler(-0.2,0.4,0.1,'YXZ'));
 const p={...pose,p:[2,3,4],q:q.toArray(),mm:50};
 const camera=new PerspectiveCamera();camera.aspect=16/9;camera.filmGauge=36;camera.setFocalLength(p.mm);camera.position.fromArray(p.p);camera.quaternion.copy(q);camera.updateMatrixWorld(true);
 for(const target of [[0,2,-11],[-5,2,-15],[5,2,-15]]){
  const projected=new Vector3().fromArray(target).project(camera), depth=-new Vector3().fromArray(target).applyMatrix4(camera.matrixWorldInverse).z;
  const expected=[(projected.x+1)/2,(projected.y+1)/2,depth], actual=projectTarget(p,target);
  expected.forEach((v,i)=>assert.ok(Math.abs(v-actual[i])<1e-10));
 }
});
