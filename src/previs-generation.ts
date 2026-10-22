import './previs.css';
type Data = Record<string, any>;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const select = (id: string) => el<HTMLSelectElement>(id);
const field = (id: string) => el<HTMLInputElement>(id);
const video = (id: string) => el<HTMLVideoElement>(id);
let project: Data, state: Data, definition: Data | undefined, schema: Data = {}, prepared: Data | undefined, requestInput: Data | undefined, reviewedJob: Data | undefined;
let imported = false, busy = false;
const parameters: Record<string, HTMLInputElement | HTMLSelectElement> = {}, roles: Record<string, HTMLSelectElement> = {};
async function api(path: string, input?: unknown) { const r = await fetch('/api/' + path,input===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});const data=await r.json();if(!r.ok)throw Error(data.error);return data; }
function option(value: string,text: string) {const o=document.createElement('option');o.value=value;o.textContent=text;return o;}
function label(text: string,control: HTMLElement) {const l=document.createElement('label');l.append(document.createTextNode(text),control);return l;}
function backend() {return {kind:select('backend').value,...(select('backend').value==='local'?{url:field('endpoint').value}:{})};}
function invalidate() {prepared=undefined;requestInput=undefined;field('approve').checked=false;el<HTMLButtonElement>('submit').disabled=true;el('quote').textContent='Request changed. Prepare a fresh quote.';}
async function action(fn:()=>Promise<void>) {if(busy)return;busy=true;try{await fn();}catch(e){el('status').textContent=(e as Error).message;}finally{busy=false;}}
function pickedShot() {return project.shots.find((s:Data)=>s.id===select('shot').value);}
function pickedAsset() {return (project.assets||[]).find((a:Data)=>a.id===select('asset').value);}
function describe(a:Data) {return `${a.width}×${a.height} · ${a.frameCount} frames · ${a.fpsRational||a.fps} fps · ${a.duration.toFixed(3)} s · ${a.audio?'audio present':'silent'} · source revision ${a.requestRevision}`;}
function showSource() {
  const a=pickedAsset();if(a){video('source').src=a.url;el('asset-detail').textContent=`Version ${a.version} · ${describe(a)}${a.provenance?.recordedDuration!==undefined?` · recorded ${a.provenance.recordedDuration.toFixed(3)} s, final sample ${a.provenance.sampledEndTime.toFixed(3)} s`:''}`;}else{video('source').removeAttribute('src');el('asset-detail').textContent='Render or export a video for this shot.';}
  renderBindings();invalidate();
}
function showShot() {
  const s=pickedShot();if(!s)return;
  el('shot-detail').textContent=`${s.binding.source} owns ${s.binding.scene} / ${s.binding.camera} · frames ${s.binding.start}–${s.binding.end} · source ${s.binding.fps} fps`;
  const count=s.binding.end-s.binding.start+1;
  el('render-timing').textContent=`${count} selected source frames → ${(count/Number(field('fps').value)).toFixed(3)} s at chosen output FPS. Rebind exact scene/camera/range from Shots.`;
  el<HTMLButtonElement>('render-video').disabled=s.binding.source!=='blender';el<HTMLButtonElement>('preview').disabled=s.binding.source!=='blender';
  const previous=select('asset').value;
  select('asset').replaceChildren(...(project.assets||[]).filter((a:Data)=>a.shotId===s.id&&a.kind==='video'&&a.source!=='comfy').map((a:Data)=>option(a.id,`Version ${a.version} · ${a.source} · ${a.duration}s · ${a.width}×${a.height}`)));
  if(Array.from(select('asset').options).some(o=>o.value===previous))select('asset').value=previous;showSource();
}
function allDefinitions():Data[] {return [...(state?.presets||[]),...(project?.workflowDefinitions||[])];}
function workflowPicker() {
  const previous=select('workflow').value, list=allDefinitions().filter(d=>d.task===select('task').value);
  select('workflow').replaceChildren(...list.map(d=>option(d.id,d.title||d.id)));
  if(list.some(d=>d.id===previous))select('workflow').value=previous;
  definition=list.find(d=>d.id===select('workflow').value);imported=false;showDefinition();
}
function showDefinition() {
  el('workflow-detail').textContent=definition?`${definition.description||definition.title||''} · ${definition.verification?.status||'imported'}`:'Import a workflow for this task.';
  el('author-graph').textContent=JSON.stringify(definition?.graph||{},null,2);
  el('timing-change').hidden=!definition?.constraints?.timingChange;el('timing-description').textContent=definition?.constraints?.timingChange||'';field('accept-timing').checked=false;
  renderBindings();renderParameters();invalidate();
  el<HTMLButtonElement>('restore-binding').disabled=!savedBinding();
}
function savedBinding() { return [...(project?.workflowBindings||[])].reverse().find((b:Data)=>b.definitionId===definition?.id&&b.shotId===pickedShot()?.id); }
function restoreBinding() {
  const b=savedBinding();if(!b)return;
  field('prompt').value=b.prompt||'';
  for(const [role,asset]of Object.entries(b.assetBindings||{})as[string,Data][])if(roles[role])roles[role].value=asset.assetId?'asset:'+asset.assetId:'render:'+asset.renderId;
  for(const [name,value]of Object.entries(b.parameters||{})){const c=parameters[name];if(!c)continue;if(c.type==='checkbox')(c as HTMLInputElement).checked=Boolean(value);else c.value=String(value);}
  invalidate();el('status').textContent='Saved shot bindings and parameters restored. Prepare a fresh quote before running.';
}
function renderBindings() {
  el('asset-bindings').replaceChildren();for(const key of Object.keys(roles))delete roles[key];
  for(const [role,mapping] of Object.entries(definition?.inputs||{}) as [string,Data][]){
    if(role==='prompt')continue;const s=document.createElement('select');s.setAttribute('aria-label',role+' asset');s.append(option('','Choose explicitly'));
    const kind=['sourceVideo','controlVideo'].includes(role)?'video':role==='audio'?'audio':'image';
    for(const a of project?.assets||[])if(a.kind===kind)s.append(option('asset:'+a.id,`${a.source} · ${a.shotId===pickedShot()?.id?'this shot':'other shot'} · v${a.version||1} · ${a.width||''}×${a.height||''} · ${a.id.slice(0,8)}`));
    if(kind==='image')for(const r of project?.renders||[])s.append(option('render:'+r.id,`${r.source} preview · ${r.width}×${r.height} · ${r.id.slice(0,8)}`));
    if(['sourceVideo','controlVideo'].includes(role)&&pickedAsset())s.value='asset:'+pickedAsset().id;
    s.onchange=invalidate;roles[role]=s;el('asset-bindings').append(label(`${role}${mapping.pass?' ('+mapping.pass+')':''} → ${mapping.nodeId}.${mapping.input}`,s));
  }
}
function schemaFields(node:Data) {
  const fields:Data={};function expand(groups:Data,prefix=''){for(const group of ['required','optional'])for(const [name,spec]of Object.entries(groups?.[group]||{})as[string,any][]){fields[prefix+name]=spec;if(spec[0]==='COMFY_DYNAMICCOMBO_V3'){const branch=spec[1]?.options?.find((o:Data)=>o.key===node.inputs[prefix+name]);if(branch)expand(branch.inputs,prefix+name+'.');}}}expand(schema[node.class_type]?.input||{});return fields;
}
function renderParameters(preserve = false) {
  const old=Object.fromEntries(Object.entries(parameters).map(([k,c])=>[k,c.type==='checkbox'?(c as HTMLInputElement).checked:c.value]));
  el('parameters').replaceChildren();for(const k of Object.keys(parameters))delete parameters[k];
  for(const [name,m]of Object.entries(definition?.parameters||{})as[string,Data][]){
    const node=definition!.graph[m.nodeId], value=node.inputs[m.input], spec=schemaFields(node)[m.input];
    const choices=Array.isArray(spec?.[0])?spec[0]:spec?.[0]==='COMBO'?spec[1]?.options:spec?.[0]==='COMFY_DYNAMICCOMBO_V3'?spec[1]?.options?.map((o:Data)=>o.key):null;
    let control:HTMLInputElement|HTMLSelectElement;
    if(choices){const s=document.createElement('select');s.append(...choices.map((v:any)=>option(String(v),String(v))));if(!choices.map(String).includes(String(value)))s.append(option(String(value),`${value} — unavailable`));s.value=String(value);control=s;}
    else{const c=document.createElement('input');c.type=typeof value==='boolean'?'checkbox':typeof value==='number'?'number':'text';if(c.type==='checkbox')c.checked=value;else c.value=String(value??'');if(c.type==='number')c.step='any';control=c;}
    control.dataset.valueType=typeof value;control.setAttribute('aria-label',m.label||`${node.class_type} · ${m.input}`);
    if(preserve && old[name]!==undefined){if(control instanceof HTMLSelectElement&&!Array.from(control.options).some(o=>o.value===String(old[name])))control.append(option(String(old[name]),`${old[name]} — unavailable`));if(control.type==='checkbox')(control as HTMLInputElement).checked=Boolean(old[name]);else control.value=String(old[name]);}
    control.onchange=invalidate;parameters[name]=control;el('parameters').append(label(m.label||`${node.class_type} · ${m.input}`,control));
  }
}
function importedMapping() {
  if(!definition)return;const d=definition;el('mapping').replaceChildren();
  const targets=Object.entries(d.graph).flatMap(([id,n]:[string,any])=>Object.keys(n.inputs).map(input=>({id,input,text:`${id} · ${n.class_type}.${input}`})));
  const roleSelects:Record<string,HTMLSelectElement>={};
  for(const role of ['sourceVideo','controlVideo','firstFrame','lastFrame','referenceImage','prompt','audio']){
    const s=document.createElement('select');s.setAttribute('aria-label',role+' mapping');s.append(option('','Not used'),...targets.map(t=>option(JSON.stringify([t.id,t.input]),t.text)));
    const m=d.inputs[role];if(m)s.value=JSON.stringify([m.nodeId,m.input]);roleSelects[role]=s;el('mapping').append(label(role+' input',s));
  }
  const pass=document.createElement('select');pass.append(...['beauty','depth','pose','edge'].map(v=>option(v,v)));el('mapping').append(label('Control video pass (if used)',pass));
  const outputs:Record<string,{check:HTMLInputElement,type:HTMLSelectElement}>={};
  for(const [id,node]of Object.entries(d.graph)as[string,Data][]){const check=document.createElement('input');check.type='checkbox';check.setAttribute('aria-label',`Declare output ${id} ${node.class_type}`);const type=document.createElement('select');type.append(...['video/mp4','image/png','video/webm','video/quicktime'].map(v=>option(v,v)));outputs[id]={check,type};const l=label(`Output ${id} · ${node.class_type}`,check);l.append(type);el('mapping').append(l);}
  el<HTMLButtonElement>('save-preset').disabled=false;
  el('save-preset').onclick=()=>action(async()=>{
    const mapped:Data={},params:Data={};const occupied=new Set<string>();
    for(const [role,s]of Object.entries(roleSelects))if(s.value){const[nodeId,input]=JSON.parse(s.value);mapped[role]={nodeId,input,...(role==='controlVideo'?{pass:pass.value}:{})};occupied.add(nodeId+'/'+input);}
    for(const t of targets){const v=d.graph[t.id].inputs[t.input];if(!occupied.has(t.id+'/'+t.input)&&!Array.isArray(v)&&v!==null&&typeof v!=='object')params['p'+Object.keys(params).length]={nodeId:t.id,input:t.input,label:t.text};}
    d.title=field('preset-title').value;d.task=select('task').value;d.inputs=mapped;d.parameters=params;d.outputs=Object.entries(outputs).filter(([,o])=>o.check.checked).map(([nodeId,o])=>({nodeId,mediaType:o.type.value}));
    const result=await api('generation/preset',{revision:project.revision,definition:d});project=result.project;definition=result.definition;imported=false;workflowPicker();select('workflow').value=result.definition.id;definition=result.definition;showDefinition();el('mapping').replaceChildren();el('status').textContent='Named preset saved with author graph intact. Inspect the selected backend and map project assets.';
  });
}
async function ensurePreset() {
  if(!definition)throw Error('Choose or import a mapped workflow');if(imported)throw Error('Save the imported mappings and declared outputs first');
  if(!project.workflowDefinitions?.some((d:Data)=>d.id===definition!.id)){const saved=await api('generation/preset',{revision:project.revision,definition});project=saved.project;definition=saved.definition;}
}
function submitReady(){el<HTMLButtonElement>('submit').disabled=!prepared?.validation?.compatible||!field('approve').checked||(!(prepared.quote.status==='known'&&prepared.quote.amount===0)&&!state.paidExecutionEnabled);}
async function reload(){const r=await api('project');project=r.project;state=await api('generation');const selected=select('shot').value||new URLSearchParams(location.search).get('shot');select('shot').replaceChildren(...project.shots.map((s:Data)=>option(s.id,s.title)));if(selected)select('shot').value=selected;showShot();workflowPicker();drawJobs();el('status').textContent=`Project revision ${project.revision} · original assets retained`;}
function drawJobs(){el('jobs').replaceChildren();for(const job of state.jobs||[]){const box=document.createElement('article'),p=document.createElement('p');p.textContent=`${job.definition.title||job.definition.id} · ${job.backend.kind} · ${job.status} · request revision ${job.requestRevision} · ${job.id}`;box.append(p);const track=document.createElement('button');track.textContent='Track exact job';track.onclick=()=>action(async()=>{await api('generation/track',{jobId:job.id});await reload();});box.append(track);if(job.results?.length){const compare=document.createElement('button');compare.textContent='Compare source / result';compare.onclick=()=>compareJob(job);box.append(compare);}el('jobs').append(box);}}
function compareJob(job:Data){
  reviewedJob=job;select('comparison-output').replaceChildren(...job.results.map((r:Data)=>option(r.id,`Node ${r.nodeId} · ${r.mimeType} · ${r.id.slice(0,8)}`)));showComparison();
}
function showComparison(){
  const job=reviewedJob;if(!job)return;
  const source=job.sources.sourceVideo||job.sources.controlVideo||job.sources.firstFrame||job.sources.image||job.sources.referenceImage;
  const result=job.results.find((r:Data)=>r.id===select('comparison-output').value);if(!result)return;
  for(const [id,asset]of [['compare-source',source],['compare-result',result]]as[string,Data|undefined][]){const v=video(id),img=el<HTMLImageElement>(id+'-image');v.pause();v.hidden=asset?.kind!=='video';img.hidden=asset?.kind!=='image';v.removeAttribute('src');img.removeAttribute('src');if(asset?.kind==='video')v.src=asset.url;else if(asset?.kind==='image')img.src=asset.url||'/renders/'+asset.id+'.png';}
  field('seek').max=String(Math.max(source?.duration||0,result.duration||0));field('seek').value='0';
  const keys=source?.kind==='video'&&result.kind==='video'?['width','height','fps','frameCount','duration','audio']:['width','height'];
  el('differences').textContent=keys.map(k=>`${k}: ${source?.[k]??'none'} → ${result[k]}${source?.[k]!==result[k]?' CHANGED':''}`).join(' · ')+(source?.kind==='video'&&result.kind==='video'?'. Playback uses shared seconds; no stretching, trimming, interpolation or repeated frames. A shorter clip ends at its own duration.':'. A still image has no camera-motion timing to compare. Review the selected output; no timing fit is applied.');
  el<HTMLButtonElement>('review').disabled=false;
}
select('comparison-output').onchange=showComparison;
select('shot').onchange=showShot;select('asset').onchange=showSource;select('task').onchange=workflowPicker;select('workflow').onchange=()=>{definition=allDefinitions().find(d=>d.id===select('workflow').value);imported=false;showDefinition();};
select('backend').onchange=()=>{schema={};el('endpoint-label').hidden=select('backend').value!=='local';el('compatibility').textContent='Backend changed. Revalidate; graph and model are unchanged.';invalidate();};
field('endpoint').oninput=invalidate;field('prompt').oninput=invalidate;for(const id of ['width','height','fps'])field(id).oninput=()=>{showShot();invalidate();};
el('inspect').onclick=()=>action(async()=>{const r=await api('generation/inspect',{backend:backend()});schema=r.objectInfo;el('compatibility').textContent=`${Object.keys(schema).length} live node schemas · ${r.message}`;renderParameters(true);invalidate();});
el('preview').onclick=()=>action(async()=>{el('status').textContent='Rendering framing preview…';const r=await api('render',{revision:project.revision,shotId:pickedShot().id});project=r.project;const image=project.renders.at(-1);el<HTMLImageElement>('framing').src='/renders/'+image.id+'.png';el('framing').hidden=false;invalidate();el('status').textContent='Framing preview saved.';});
el('render-video').onclick=()=>action(async()=>{el('status').textContent='Rendering animation through Blender MCP; keep Blender idle. A lost connection does not cancel it.';const r=await api('video/blender',{revision:project.revision,shotId:pickedShot().id,width:Number(field('width').value),height:Number(field('height').value),fps:Number(field('fps').value)});project=r.project;showShot();select('asset').value=r.asset.id;showSource();el('status').textContent='Verified animation saved. '+describe(r.asset);});
field('import').onchange=()=>action(async()=>{const file=field('import').files?.[0];if(!file)return;const graph=JSON.parse(await file.text());definition={version:1,id:crypto.randomUUID(),title:file.name.replace(/\.json$/,''),task:select('task').value,graph,inputs:{},parameters:{},outputs:[],constraints:{},pricing:{status:'unknown'},provenance:{source:'User-imported API graph'},verification:{status:'imported'}};imported=true;field('preset-title').value=definition.title;el('author-graph').textContent=JSON.stringify(graph,null,2);importedMapping();invalidate();});
el('prepare').onclick=()=>action(async()=>{
  invalidate();await ensurePreset();const assetBindings:Data={},values:Data={};
  for(const [role,s]of Object.entries(roles)){if(!s.value)throw Error('Choose '+role+' explicitly');const[kind,id]=s.value.split(':');assetBindings[role]=kind==='asset'?{assetId:id}:{renderId:id};}
  for(const [name,c]of Object.entries(parameters))values[name]=c.type==='checkbox'?(c as HTMLInputElement).checked:c.dataset.valueType==='number'?Number(c.value):c.value;
  const binding=await api('generation/bind',{revision:project.revision,definitionId:definition!.id,shotId:pickedShot().id,assetBindings,prompt:field('prompt').value,parameters:values,acceptTimingChange:field('accept-timing').checked});project=binding.project;
  requestInput={requestId:crypto.randomUUID(),revision:project.revision,workflowBindingId:binding.workflowBindingId,backend:backend()};
  prepared=(await api('generation/quote',requestInput)).job;
  const pricedNode=prepared!.preparedGraph?.['2']?.inputs;
  const priced=definition!.pricing?.ratePerSecond&&pricedNode?.model_name==='kling-video-o1'&&pricedNode?.resolution==='720p';
  const estimate=priced&&pickedAsset()?`\nPublished partner estimate: $${(definition!.pricing.ratePerSecond*pickedAsset().duration).toFixed(3)} USD (${definition!.pricing.ratePerSecond}/s at 720p); ${(definition!.pricing.creditsPerSecond*pickedAsset().duration).toFixed(2)} Comfy credits. Cloud overhead/credit conversion unknown. This is not a total or provider spending cap.`:definition!.pricing?.ratePerSecond?'\nThe published estimate does not cover these model/resolution settings. Obtain a new quote.':'';
  el('quote').textContent=`${prepared!.validation.compatible?'Schema compatible':'Unavailable requirements'}\n${prepared!.validation.issues.map((i:Data)=>i.message).join('\n')}\nCost: ${prepared!.quote.status==='known'?'$'+prepared!.quote.amount+' USD': 'unknown total — quote approval required'}\n${prepared!.quote.reason}${estimate}\nApproval fingerprint: ${prepared!.fingerprint}`;
  el('request').textContent=JSON.stringify(prepared,null,2);state=await api('generation');drawJobs();submitReady();el('status').textContent='Prepared exact request. Nothing submitted.';
});
field('accept-timing').onchange=invalidate;
el('restore-binding').onclick=restoreBinding;
field('approve').onchange=submitReady;
el('submit').onclick=()=>action(async()=>{if(!prepared||!requestInput)throw Error('Prepare a fresh quote');const r=await api('generation/submit',{...requestInput,approval:{approved:field('approve').checked,fingerprint:prepared.fingerprint,allowance:{currency:'USD',maxAmount:Number(field('allowance').value),allowUnknownCharges:field('unknown').checked}}});el('status').textContent=r.job.message;state=await api('generation');drawJobs();field('approve').checked=false;submitReady();});
el('reload').onclick=()=>action(reload);
el('play-both').onclick=()=>action(async()=>{const t=Number(field('seek').value);for(const id of ['compare-source','compare-result']){const v=video(id);if(t<v.duration){v.currentTime=t;await v.play();}else v.pause();}});
el('pause-both').onclick=()=>{video('compare-source').pause();video('compare-result').pause();};
field('seek').oninput=()=>{for(const id of ['compare-source','compare-result']){const v=video(id),t=Number(field('seek').value);v.pause();if(t<=v.duration)v.currentTime=t;}};
el('review').onclick=()=>action(async()=>{if(!reviewedJob)throw Error('Choose a completed comparison');project=(await api('generation/review',{revision:project.revision,jobId:reviewedJob.id,resultIds:[select('comparison-output').value],visuallyReviewed:true,notes:field('review-notes').value})).project;el('status').textContent='Visual review saved against exact output identities.';});
el('endpoint-label').hidden=select('backend').value!=='local';
field('prompt').value='Transform the blue ceramic sphere into a luminous amber glass planet with swirling golden clouds. Keep the gold orbital ring, pedestal, camera dolly, perspective, framing, object positions and background parallax from the source video. Cinematic studio lighting, stable geometry, consistent materials, no added camera motion, no cuts, no text.';
void action(reload);
