// Apply the authored animation pass to imported source projects, then export with starters:export.
// Never edits bundles or cameras. Regenerate the GLBs first.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { blendPose, applyBlockoutPose } from '../../shared/blockout-pose.mjs';
import { entityAt, normalizePath } from '../../shared/director.mjs';
import { SOURCES } from '../export-starters.mjs';
const [dir] = process.argv.slice(2);
if (!dir) throw Error('Usage: animate-starters.mjs <imported-data-dir>');
const round = v => Math.round(v * 1000) / 1000;
const smooth = x => { const u = Math.max(0, Math.min(1, x)); return u*u*(3-2*u); };
const v = (x=0,y=0,z=0) => [x,y,z];
const neutral = { body:v(), head:v(), armL:v(), armR:v(), forearmL:v(), forearmR:v(), thighL:v(), thighR:v(), shinL:v(), shinR:v() };
const rigBytes = await readFile(new URL('../../public/models/blockouts/player.glb', import.meta.url));
const player = (await new GLTFLoader().parseAsync(rigBytes.buffer.slice(rigBytes.byteOffset,rigBytes.byteOffset+rigBytes.byteLength),'')).scene;
const feetY = pose => { applyBlockoutPose(player,pose); player.updateMatrixWorld(true); return new Box3().setFromObject(player,true).min.y; };
const key = (t,p,pose={},extra={}) => ({ t:round(t), p:p.map(round), pose, ease:'linear', ...extra });
const set = (e,keys) => { if(keys.length>64) throw Error(`${e.name}: ${keys.length} keys`); e.path=normalizePath(keys); e.position=[...e.path[0].p]; if(e.path[0].r!==undefined)e.rotation=e.path[0].r; };
const walk = (phase, defending=false) => {
  const swing=Math.cos(phase), bend=Math.max(0,Math.sin(phase));
  return { ...neutral, body:v(defending?-5:7), head:v(-3), thighL:v(-30*swing), thighR:v(30*swing), shinL:v(8+48*bend), shinR:v(8+48*Math.max(0,-Math.sin(phase))), armL:v(defending?-58:23*swing,0,defending?-24:-8), armR:v(defending?-58:-28*swing,0,defending?24:8), forearmL:v(-35), forearmR:v(-48) };
};
const descriptions = {
 'breaking-news': [
  '@news-anchor settles at the desk in the first second, lifts the chin, then opens one palm briefly and rests it again. Breathing is subtle; suit, face and studio graphics stay consistent.',
  '@news-anchor delivers the headline: a small nod in second one, one measured hand emphasis in seconds two to three, then stillness. Keep the same face and suit; shoulders follow the gesture softly.',
  '@news-anchor finishes speaking, lowers both hands, settles the shoulders and gives a restrained nod in the last second. Hold the same face, suit and studio graphics.'
 ],
 'final-lap': [
  '@comfy-car drafts for 1s, then eases inside @rival-car. Tires grip; the body leans outward and settles as steering unwinds. Slow-motion replay; keep liveries.',
  '@comfy-car closes for 1s, draws level with @rival-car at 3s, then edges ahead. Tires grip; steering unwinds and suspension settles. Slow-motion; keep liveries.',
  '@comfy-car gains half a length on @rival-car over four seconds. Both hold separate lanes; wheels roll continuously and bodywork vibrates subtly. Slow-motion race replay; preserve colors and numbers.',
  '@comfy-car crosses at 2s, then @rival-car. The blue car gains a full length; both accelerate, tires planted. Slow-motion replay; keep colors and numbers.'
 ],
 'posterized': [
  '@comfy-guard strides with four dribbles; @rival-defender retreats. Feet push off; the ball rebounds sharply. Half-speed; same uniforms.',
  '@comfy-guard drives low, protecting the ball. @rival-defender shuffles back, plants and raises both arms by 4s. Half-speed; same uniforms.',
  '@comfy-guard gathers 1s, plants 2s, dunks 3s; @rival-defender contests late. Ball drops through; knees cushion landing. Half-speed; same uniforms.'
 ],
 'wingspan': [
  '@bald-eagle glides for one second, makes two deep wing beats, then spreads its wings again. Feather tips lag the shoulders; the head stays steady. Elk graze on shore. Keep the same bird, plumage and landscape.',
  '@bald-eagle draws its wings inward in second one and descends, then opens them progressively to arrest the dive by second five. The tail fans and body levels under lift. Preserve the bird and shoreline.',
  '@bald-eagle skims above the lake with broad wings, gives one slow recovery beat in seconds two to three and settles into a glide. Tips flex after the shoulders; elk lift their heads. Preserve plumage and waterline.'
 ]
};
for (const source of SOURCES) {
 const file=join(dir,'director',source.id,'project.json'), p=JSON.parse(await readFile(file,'utf8'));
 const named=n=>p.scene.entities.find(e=>e.name===n);
 const cast = {
  'News anchor':'News anchor: navy suit, white shirt, blue tie, yellow Comfy pin, neat dark hair and warm expression.',
  'Comfy car':'Blue/yellow Comfy stock car, number 1, yellow rims.',
  'Rival car':'Black stock car, neon green accents, number 7; no real-world logos.',
  'Comfy guard':'Athletic guard: blue/yellow Comfy uniform, number 1.',
  'Rival defender':'Tall defender: black/neon green uniform, number 7.',
  'Bald eagle':'Wild bald eagle: broad brown feathered wings, white head and tail, yellow beak and talons; no clothing.',
 };
 for(const e of p.scene.entities) if(cast[e.name]) e.notes=cast[e.name];

 for(const [i,s] of p.shots.entries()) { s.description=descriptions[source.slug][i]; s.prompts={}; }
 if(source.slug==='final-lap') {
  for(const [name,speed,x0,lane] of [['Comfy car',5.4,-57.5,38],['Rival car',4.8,-51,42]]) {
   const e=named(name), hero=name==='Comfy car', keys=[];
   const x=t=>x0+speed*t+(hero?2.5*smooth(t/6):0);
   const z=t=>hero?41.7-3.7*smooth((t-.6)/3.8):lane+.12*Math.sin(t*.6);
   for(let t=0;t<=18;t+=.3) {
    const dx=(x(t+.01)-x(t-.01))/.02, dz=(z(t+.01)-z(t-.01))/.02;
    const yaw=Math.atan2(dx,dz)*180/Math.PI, steering=(90-yaw)*.32;
    const spin=(x(t)-x(0))/.36*180/Math.PI;
    keys.push(key(t,[x(t),.08,z(t)],{ body:v(0,0,hero?1.6*Math.sin(Math.PI*Math.max(0,Math.min(1,(t-.6)/3.8))):.15*Math.sin(t)), steerL:v(0,steering),steerR:v(0,steering),wheelFL:v(spin),wheelFR:v(spin),wheelRL:v(spin),wheelRR:v(spin) },{r:round(yaw)}));
   }
   set(e,keys);
  }
 }
 if(source.slug==='posterized') {
  const guard=named('Comfy guard'), defender=named('Rival defender'), ball=named('Basketball');
  const oldGuard={...guard,path:[[0,-5,1.4],[2,-1.5,1.4],[4,2,1.3],[6,5.2,1.1],[8,8,.7],[9,9.3,.5],[9.8,10.2,.25]].map(([t,x,z])=>({t,p:[x,0,z],r:90}))};
  const oldDefender={...defender,path:[[0,1],[4,6],[8,10.7],[9.5,11.1]].map(([t,x])=>({t,p:[x,0,t<8?0:-.45],r:270}))};
  const g=[],d=[],b=[];
  // Quarter-cycle contacts give pose interpolation a readable passing position instead of a foot slide.
  for(let i=0;i<=48;i++) {
   const t=i*.1875, phase=t*Math.PI*2/1.5, gp=entityAt(oldGuard,t).position, dp=entityAt(oldDefender,t).position;
   const pose=walk(phase), defense=walk(phase+Math.PI*.5,true);
   gp[1]=.07-feetY(pose)*guard.scale[1]; dp[1]=.07-feetY(defense)*defender.scale[1];
   g.push(key(t,gp,pose,{r:90})); d.push(key(t,dp,defense,{r:270}));
  }
  const gather={...neutral, body:v(8),thighL:v(-18),thighR:v(-18),shinL:v(36),shinR:v(36),armL:v(-65),armR:v(-75),forearmL:v(-70),forearmR:v(-70)};
  const crouch={...gather,body:v(16),thighL:v(-40),thighR:v(-40),shinL:v(72),shinR:v(72)};
  const reach={...neutral,body:v(-5),armL:v(-55,0,-25),armR:v(-158,0,6),forearmL:v(-40),forearmR:v(-12),thighL:v(-20),thighR:v(15),shinL:v(35),shinR:v(65)};
  const dunk={...reach,body:v(6),armR:v(-140,0,4),forearmR:v(-15)};
  const land={...crouch,armL:v(-25,0,-18),armR:v(-35,0,15)};
  for(const [t,x,z,pose,h] of [[9.3,9.65,.4,gather,0],[9.7,10.15,.24,crouch,0],[10.05,10.6,.12,crouch,0],[10.25,11,.05,reach,.65],[10.6,11.55,0,reach,1.13],[10.85,11.9,0,dunk,1.18],[11.1,12.05,0,dunk,1.05],[11.4,12.2,.15,reach,.55],[11.65,12.3,.3,land,0],[11.9,12.38,.4,land,0],[12,12.4,.44,blendPose(land,neutral,.15625),0],[12.1,12.42,.48,blendPose(land,neutral,.5),0],[12.2,12.44,.52,blendPose(land,neutral,.84375),0],[12.3,12.45,.55,neutral,0],[13,12.5,.7,neutral,0]]) {
   // Airborne roots describe a rounded jump; grounded poses compensate knee flexion exactly.
   const y=h ? .055+h : .07-feetY(pose)*guard.scale[1];
   g.push(key(t,[x,y,z],pose,{r:90,ease:h?'linear':'smoothstep'}));
  }
  const defend={...neutral,body:v(-4),armL:v(-120,0,-25),armR:v(-120,0,25),forearmL:v(-25),forearmR:v(-25),thighL:v(-22),thighR:v(-22),shinL:v(44),shinR:v(44)};
  for(const [t,x,z,h,pose] of [[9.4,11.1,-.65,0,defend],[10.1,11.2,-.65,0,defend],[10.4,11.25,-.65,.35,defend],[10.7,11.3,-.65,.2,defend],[10.95,11.3,-.65,0,land],[11.25,11.3,-.7,0,land],[11.7,11.25,-.8,0,defend],[12.4,11.2,-.85,0,neutral],[13,11.2,-.85,0,neutral]]) d.push(key(t,[x,.07+h-feetY(pose)*defender.scale[1],z],pose,{r:270,ease:'smoothstep'}));
  set(guard,g);set(defender,d);
  // Four dribbles per four-second shot: contact at the ball's bottom, quick rebound, relaxed hand at the top.
  for(let i=0;i<=36;i++) {
   const t=i*.25, gp=entityAt(guard,t).position, phase=t%1;
   const y=phase===.5?.055:phase===0?1.02:.78;
   b.push(key(t,[gp[0]+.30,y,gp[2]-.22],{}, {pitch:t*260}));
  }
  for(const [t,x,y,z] of [[9.3,10,1.3,.1],[9.7,10.65,1.45,.05],[10.05,11.05,1.65,.02],[10.25,11.4,2.8,0],[10.6,11.92,3.48,0],[10.85,12.25,3.36,0],[11.1,12.25,3.08,0],[11.25,12.25,2.72,0],[11.55,12.25,1.75,0],[11.85,12.25,.055,.04],[12.1,12.38,.68,.15],[12.35,12.5,.84,.26],[12.65,12.65,.055,.4],[12.85,12.75,.36,.5],[13,12.82,.38,.58]]) b.push(key(t,[x,y,z],{}, {pitch:t*260}));
  set(ball,b);
 }
 if(source.slug==='wingspan') {
  const e=named('Bald eagle'), original={...e,path:[[0,20,22,28],[2.5,16,18,15],[5,12,13,2],[7.5,8.5,8,-10.5],[10,5,4,-23],[12.5,.5,3.6,-31.5],[15,-4,4,-40],[17,-8,6,-47]].map(([t,x,y,z])=>({t,p:[x,y,z]}))}, keys=[];
  for(let i=0;i<=60;i++) {
   const t=i*.25, pos=entityAt(original,t).position;
   // Broad strokes, long gliding holds. Positive left-wing roll raises the left tip.
   let flap=0;
   if(t>=1&&t<=3.5) flap=30*Math.sin((t-1)*Math.PI*2/1.25);
   if(t>=11.25&&t<=13) flap=22*Math.sin((t-11.25)*Math.PI*2/1.75);
   const tuck=50*smooth((t-5)/1.2)*(1-smooth((t-8)/2));
   const bank=-8-5*Math.sin(t*.35), pitch=t<9?16:16*(1-smooth((t-9)/2))-3;
   keys.push(key(t,pos,{wingL:v(0,-tuck,-flap-tuck*.3),wingR:v(0,tuck,flap+tuck*.3),tipL:v(0,0,-8*Math.sin(t*5-1)),tipR:v(0,0,8*Math.sin(t*5-1)),tail:v(-pitch*.3)}, {pitch:round(pitch),roll:round(bank),r:round(t<10?198:208),ease:'linear'}));
  }
  set(e,keys);
  for(const [i,elk] of p.scene.entities.filter(e=>e.model==='elk').entries()) set(elk,[key(0,elk.position,{head:v(28)}, {r:elk.rotation,ease:'smoothstep'}),key(3+i,elk.position,{head:v(34,4)}, {r:elk.rotation,ease:'smoothstep'}),key(7+i,elk.position,{head:v(25,-3)}, {r:elk.rotation,ease:'smoothstep'}),key(11+i*.3,elk.position,{head:v(-6,8)}, {r:elk.rotation,ease:'smoothstep'}),key(15,elk.position,{head:v(0,5)}, {r:elk.rotation})]);
 }
 if(source.slug==='breaking-news') {
  const anchor=named('News anchor'), operator=named('Camera operator');
  const seated={...neutral,thighL:v(-75),thighR:v(-75),shinL:v(80),shinR:v(80),armL:v(-10),armR:v(-10),forearmL:v(-45),forearmR:v(-45)};
  set(anchor,[[0,0,4],[.8,0,0],[1.6,12,-2],[2.3,18,1],[3.4,0,0],[5,0,0],[5.6,0,4],[6.2,0,0],[7.1,24,-1],[7.7,16,1],[8.8,0,0],[10,0,0],[11.1,10,0],[12.2,0,0],[13.7,0,3],[14.3,0,0],[15,0,0]].map(([t,gesture,nod])=>key(t,anchor.position,{...seated,body:v(0,Math.sin(t)*1.2),head:v(nod),armR:v(-10-gesture,0,gesture*.35),forearmR:v(-45-gesture*.3)}, {r:0,ease:'smoothstep'})));
  set(operator,[0,2,3,4,7,8,10,12,13,15].map((t,i)=>key(t,operator.position,{...neutral,body:v(i%3===1?2:0),head:v(0,i%3===1?4:0),armL:v(-22),armR:v(-25),forearmL:v(-20),forearmR:v(i%3===1?-35:-20)}, {r:180,ease:'smoothstep'})));
 }
 await writeFile(file,JSON.stringify(p,null,2)+'\n');
 console.log(`${source.slug}: ${p.scene.entities.filter(e=>e.path).length} animated objects`);
}
