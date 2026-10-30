import { validateBrowser } from './store.mjs';
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
function slerp(a, b, t) {
  let dot = a.reduce((sum, x, i) => sum + x * b[i], 0);
  if (dot < 0) { b = b.map(x => -x); dot = -dot; }
  if (dot > 0.9995) { const q = mix(a,b,t), n = Math.hypot(...q); return q.map(x => x/n); }
  const angle = Math.acos(Math.min(1,dot)), sine = Math.sin(angle);
  return a.map((x,i) => (x*Math.sin((1-t)*angle)+b[i]*Math.sin(t*angle))/sine);
}
function poseAt(frames, t) {
  const index = frames.findIndex(f => f.t >= t);
  if (index === 0) return frames[0]; if (index < 0) return frames.at(-1);
  const a = frames[index-1], b = frames[index], u = (t-a.t)/(b.t-a.t);
  return { t, p: mix(a.p,b.p,u), q: slerp(a.q,b.q,u), mm: a.mm+(b.mm-a.mm)*u };
}
export function cameraTransfer(shot) {
  if (shot?.binding.source !== 'three') throw Error('Choose a saved browser shot');
  const browser = validateBrowser(shot.browser);
  if (browser.frames.length && browser.frames[0].t !== 0) throw Error('Recording must start at zero');
  const motion = browser.frames.length > 1, duration = motion ? browser.frames.at(-1).t : 0;
  const end = Math.max(1, Math.ceil(duration*24)+1);
  const poses = Array.from({length:end}, (_,i) => ({ ...(motion ? poseAt(browser.frames, Math.min(duration,i/24)) : browser.camera), frame:i+1 }));
  const checks = [...new Set([1,Math.round((end+1)/2),end])];
  return { version:1, scope:'camera-only', fps:24, start:1, end, sensorWidth:36, aspect:16/9, units:'meters', axisMapping:'Three (x,y,z) → Blender (x,-z,y)', source:motion?'recorded-motion':'captured-pose', poses, checks, targets:[browser.subject,[-5,2,-15],[5,2,-15]], omitted:['All geometry, including the camera-study subject and landmarks','Materials, lighting, fog, helpers, physics and audio','Phone/gamepad device signals; only resolved camera poses transfer'], sourceDuration:duration };
}
// Project a world-space point through the same -Z-forward / +Y-up camera basis.
export function projectTarget(pose, point) {
  const [x,y,z,w]=pose.q, v=point.map((p,i)=>p-pose.p[i]);
  const q=[-x,-y,-z];
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const uv=cross(q,v), uuv=cross(q,uv), local=v.map((value,i)=>value+2*(w*uv[i]+uuv[i]));
  const depth=-local[2];
  if(Math.abs(depth)<1e-6) return null;
  return [0.5+local[0]*pose.mm/(36*depth),0.5+local[1]*pose.mm/(20.25*depth),depth];
}
export function verifyTransfer(payload, result) {
  if (!result.ok) throw Error(result.error || 'Blender transfer failed');
  if (result.fps !== 24 || result.start !== 1 || result.end !== payload.end || result.fileSaved !== false || result.sensorWidth !== 36 || result.sensorFit !== 'HORIZONTAL' || result.unitScale !== 1 || JSON.stringify(result.resolution) !== '[640,360]') throw Error('Blender camera units, lens, timing or format did not match the transfer');
  if (!Array.isArray(result.checks) || result.checks.length !== payload.checks.length) throw Error('Blender returned incomplete camera checks');
  let maximumProjectionError=0, maximumPoseError=0, maximumDepthError=0;
  for(const frame of payload.checks){
    const pose=payload.poses[frame-1], check=result.checks.find(c=>c.frame===frame);
    if(!check || !Array.isArray(check.p) || check.p.length !== 3 || !check.p.every(Number.isFinite) || !Array.isArray(check.q) || check.q.length !== 4 || !check.q.every(Number.isFinite) || !Number.isFinite(check.mm)) throw Error('Blender omitted a valid checked camera pose');
    const p=[pose.p[0],-pose.p[2],pose.p[1]], q=pose.q, k=Math.SQRT1_2;
    const expectedQ=[k*(q[0]+q[3]),k*(q[1]-q[2]),k*(q[2]+q[1]),k*(q[3]-q[0])];
    maximumPoseError=Math.max(maximumPoseError,...p.map((v,i)=>Math.abs(v-check.p[i])),Math.abs(pose.mm-check.mm),1-Math.abs(expectedQ.reduce((sum,v,i)=>sum+v*check.q[i],0)));
    for(let i=0;i<payload.targets.length;i++){
      const expected=projectTarget(pose,payload.targets[i]); if(!expected) continue;
      if(!Array.isArray(check.projected?.[i]) || check.projected[i].length !== 3 || !check.projected[i].every(Number.isFinite)) throw Error('Invalid Blender framing check');
      maximumProjectionError=Math.max(maximumProjectionError,...expected.slice(0,2).map((v,j)=>Math.abs(v-check.projected[i][j])));
      maximumDepthError=Math.max(maximumDepthError,Math.abs(expected[2]-check.projected[i][2]));
    }
  }
  if(maximumProjectionError>0.001 || maximumPoseError>0.001 || maximumDepthError>0.001) throw Error('Transferred camera verification failed. Inspect the new scene; it was retained, not retried.');
  return { checkedFrames:payload.checks, maximumProjectionError, maximumPoseError, maximumDepthError, comparison:'Normalized optical projections of subject position and two reference positions; geometry and lighting are not transferred.' };
}
export function transferCode(payload, identity) {
  return `import bpy,json,math
from mathutils import Quaternion,Vector
from bpy_extras.object_utils import world_to_camera_view
p=json.loads(${JSON.stringify(JSON.stringify(payload))})
identity=json.loads(${JSON.stringify(JSON.stringify(identity))})
def previs_transfer():
    if bpy.data.filepath != identity['file']: return {'ok':False,'error':'Blender file changed; refresh before transfer'}
    name='Previs Camera '+identity['requestId']
    if bpy.data.scenes.get(name): return {'ok':False,'error':'This transfer scene already exists. Inspect it; no duplicate was created','scene':name}
    s=bpy.data.scenes.new(name)
    s['previs_transfer_id']=identity['requestId']
    s['previs_source_shot']=identity['shotId']
    s['previs_request_revision']=identity['revision']
    old_scene,old_view_layer=bpy.context.window.scene,bpy.context.window.view_layer
    try:
        bpy.context.window.scene=s
        s.unit_settings.system='METRIC'
        s.unit_settings.scale_length=1.0
        s.render.fps=p['fps']
        s.render.fps_base=1.0
        s.frame_start=p['start']
        s.frame_end=p['end']
        s.render.resolution_x=640
        s.render.resolution_y=360
        s.render.resolution_percentage=100
        s.render.pixel_aspect_x=1
        s.render.pixel_aspect_y=1
        camera=bpy.data.objects.new('Previs Camera',bpy.data.cameras.new('Previs Camera'))
        s.collection.objects.link(camera)
        s.camera=camera
        camera.rotation_mode='QUATERNION'
        camera.data.type='PERSP'
        camera.data.sensor_fit='HORIZONTAL'
        camera.data.sensor_width=36
        camera.data.sensor_height=20.25
        camera.data.clip_start=0.5
        camera.data.clip_end=300
        basis=Quaternion((1,0,0),math.pi/2)
        for pose in p['poses']:
            camera.location=(pose['p'][0],-pose['p'][2],pose['p'][1])
            q=pose['q']
            camera.rotation_quaternion=basis @ Quaternion((q[3],q[0],q[1],q[2]))
            camera.data.lens=pose['mm']
            camera.keyframe_insert(data_path='location',frame=pose['frame'])
            camera.keyframe_insert(data_path='rotation_quaternion',frame=pose['frame'])
            camera.data.keyframe_insert(data_path='lens',frame=pose['frame'])
        checks=[]
        for frame in p['checks']:
            s.frame_set(frame)
            bpy.context.view_layer.update()
            q=camera.rotation_quaternion
            projected=[]
            for target in p['targets']:
                v=world_to_camera_view(s,camera,Vector((target[0],-target[2],target[1])))
                projected.append(list(v))
            checks.append({'frame':frame,'p':list(camera.location),'q':[q.x,q.y,q.z,q.w],'mm':camera.data.lens,'projected':projected})
        s.frame_set(1)
        return {'ok':True,'scene':s.name,'camera':camera.name,'fps':s.render.fps,'start':s.frame_start,'end':s.frame_end,'checks':checks,'fileSaved':False,'sensorWidth':camera.data.sensor_width,'sensorFit':camera.data.sensor_fit,'unitScale':s.unit_settings.scale_length,'resolution':[s.render.resolution_x,s.render.resolution_y]}
    except Exception as error:
        return {'ok':False,'error':'Transfer incomplete: '+str(error)[:400]+'. Inspect retained new scene; no retry or cleanup was performed.','scene':s.name}
    finally:
        bpy.context.window.scene=old_scene
        bpy.context.window.view_layer=old_view_layer
print('PREVIS_JSON:'+json.dumps(previs_transfer()))
`;
}
