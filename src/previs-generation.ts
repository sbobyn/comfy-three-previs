import './previs.css';
type Data = Record<string, any>;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const select = (id: string) => el<HTMLSelectElement>(id);
const field = (id: string) => el<HTMLInputElement>(id);
const video = (id: string) => el<HTMLVideoElement>(id);
let project: Data, state: Data, definition: Data | undefined, schema: Data = {}, prepared: Data | undefined, requestInput: Data | undefined, reviewedJob: Data | undefined;
let imported = false, busy = false, editVersion = 0;
const parameters: Record<string, HTMLInputElement | HTMLSelectElement> = {}, roles: Record<string, HTMLSelectElement> = {};
async function api(path: string, input?: unknown) { const r = await fetch('/api/' + path,input===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});const data=await r.json();if(!r.ok)throw Error(data.error);return data; }
function option(value: string,text: string) {const o=document.createElement('option');o.value=value;o.textContent=text;return o;}
function label(text: string,control: HTMLElement) {const l=document.createElement('label');l.append(document.createTextNode(text),control);return l;}
function backend() {return {kind:select('backend').value,...(select('backend').value==='local'?{url:field('endpoint').value}:{})};}
function invalidate() {editVersion++;prepared=undefined;requestInput=undefined;field('approve').checked=false;el<HTMLButtonElement>('submit').disabled=true;el('quote').textContent='Request changed. Prepare a fresh quote.';el('prepared-source').textContent='';el('prepared-source').hidden=true;el('request').textContent='';}
async function action(fn:()=>Promise<void>) {if(busy)return;busy=true;el('status').dataset.state='busy';el<HTMLFieldSetElement>('workspace-controls').disabled=true;try{await fn();el('status').dataset.state='ready';}catch(e){el('status').dataset.state='error';el('status').textContent=(e as Error).message;}finally{busy=false;el<HTMLFieldSetElement>('workspace-controls').disabled=false;}}
function workbenchView(compare:boolean) {el('source-panel').hidden=compare;el('request-panel').hidden=compare;el('comparison-panel').hidden=!compare;el('source-view').setAttribute('aria-pressed',String(!compare));el('compare-view').setAttribute('aria-pressed',String(compare));}
el('source-view').onclick=()=>workbenchView(false);el('compare-view').onclick=()=>workbenchView(true);
function remember(values: Record<string,string|undefined>) {const query=new URLSearchParams(location.search);for(const [key,value]of Object.entries(values)){if(value)query.set(key,value);else query.delete(key);}history.replaceState(null,'','?'+query.toString());}
function pickedShot() {return project.shots.find((s:Data)=>s.id===select('shot').value);}
function pickedAsset() {return (project.assets||[]).find((a:Data)=>a.id===select('asset').value);}
function describe(a:Data) {return `${a.width}×${a.height} · ${a.frameCount} frames · ${a.fpsRational||a.fps} fps · ${a.duration.toFixed(3)} s · ${a.audio?'audio present':'silent'} · source revision ${a.requestRevision}`;}
function ownership(binding:Data={},snapshot?:Data,lenses?:Data[]){const mm=snapshot?.camera?.mm;const values=lenses?.map(l=>l.mm).filter(Number.isFinite)||[];const lens=values.length?`${Math.min(...values)}–${Math.max(...values)} mm across captured frames`:mm?`${mm} mm at saved pose; recorded lenses may vary`:'lens not captured in this asset';return `${binding.source==='blender'?'Blender':'Browser'} owns ${binding.scene||'camera-study set'} / ${binding.camera||'camera'} · frames ${binding.start??'?'}–${binding.end??'?'} · source ${binding.fps??'?'} fps · ${lens}${binding.file?' · '+binding.file:''}`;}
function showSource(updateBindings = true) {
  const a=pickedAsset();el('source-empty').textContent='Choose an exact saved source version to review it here. New browser captures export from the camera studio.';el('capture-origin').textContent=a?'Captured origin · '+ownership({...a.binding,file:undefined},a.provenance?.browserSnapshot,a.provenance?.render?.cameraLenses):'';el('source-empty').hidden=Boolean(a);el('capture-summary').textContent=a?`Captured v${a.version} · ${describe(a)} · ${a.id.slice(0,8)}`:'';video('source').hidden=!a;if(a){video('source').src=a.url;el('asset-detail').textContent=`Selected ${a.source==='comfy'?'Comfy result':'capture'} · version ${a.version} · ${describe(a)}. Authored origin: ${ownership(a.binding,a.provenance?.browserSnapshot,a.provenance?.render?.cameraLenses)}${a.provenance?.recordedDuration!==undefined?` · recorded ${a.provenance.recordedDuration.toFixed(3)} s, final sample ${a.provenance.sampledEndTime.toFixed(3)} s`:''}`;}else{video('source').removeAttribute('src');el('asset-detail').textContent='Choose a saved video version above, or render/export a new capture.';}
  const download=el<HTMLAnchorElement>('capture-download');download.hidden=!a;download.href=a?.url||'';download.download=a?.filename||a?.id||'';
  if(updateBindings)renderBindings();invalidate();
}
function syncPrimarySource(){const value=(roles.sourceVideo||roles.controlVideo)?.value;if(value?.startsWith('asset:')&&Array.from(select('asset').options).some(o=>o.value===value.slice(6))){select('asset').value=value.slice(6);showSource(false);remember({shot:select('shot').value,asset:select('asset').value});}}
function showRenderTiming(){const s=pickedShot();if(!s)return;const count=s.binding.end-s.binding.start+1;el('render-timing').textContent=s.binding.source==='three'?`Browser shot: open the saved camera studio to render its recorded motion at the saved delivery settings. Choose the exact exported version below.`:`${count} selected source frames → ${(count/Number(field('fps').value)).toFixed(3)} s at chosen output FPS. Rebind exact scene/camera/range from Shots.`;}
function showShot() {
  const s=pickedShot();el('empty-author').hidden=Boolean(s);if(!s){el('source-empty').textContent='No saved shots yet. Start a browser dolly without Blender, or bind an existing Blender scene from Scenes & shots.';el('render-controls').hidden=true;return;}
  const author=el<HTMLAnchorElement>('author-shot');author.href=s.binding.source==='three'?'/index.html?shot='+s.id:'/#shot-'+s.id;author.textContent=s.binding.source==='three'?'Open saved camera motion →':'Inspect or rebind this Blender shot →';el('render-controls').hidden=s.binding.source!=='blender';
  el('scene-owner').textContent=s.binding.source==='three'?'Browser scene · camera-study set':'Blender scene · original file is authoritative';
  el('current-binding').textContent='Current shot · '+ownership({...s.binding,file:undefined},s.browser);
  el('shot-detail').textContent=`Current shot · ${s.title}. ${ownership(s.binding,s.browser)}. Blender-authored content stays in Blender; browser shots use the camera-study set.`;
  el('framing').hidden=true;el('framing').removeAttribute('src');
  showRenderTiming();
  el<HTMLButtonElement>('render-video').disabled=s.binding.source!=='blender';el<HTMLButtonElement>('preview').disabled=s.binding.source!=='blender';
  const previous=select('asset').value||new URLSearchParams(location.search).get('asset');
  select('asset').replaceChildren(option('','Choose a saved source version'),...(project.assets||[]).filter((a:Data)=>a.shotId===s.id&&a.kind==='video').map((a:Data)=>option(a.id,`Version ${a.version} · ${a.source} · ${a.duration}s · ${a.width}×${a.height} · ${a.id.slice(0,8)}`)));
  if(previous&&Array.from(select('asset').options).some(o=>o.value===previous))select('asset').value=previous;showSource();if(previous&&!pickedAsset()){el('asset-detail').textContent='The requested source is unavailable for this shot. Choose its exact saved version; no other capture was substituted.';el('source-empty').textContent=el('asset-detail').textContent;}
}
function allDefinitions():Data[] {return [...(state?.presets||[]),...(project?.workflowDefinitions||[])];}
function workflowPicker() {
  const previous=select('workflow').value, list=allDefinitions().filter(d=>d.task===select('task').value);
  select('workflow').replaceChildren(...list.map(d=>option(d.id,`${d.title||d.id} · ${state.presets.some((s:Data)=>s.id===d.id)?'built-in':'saved preset '+d.id.slice(0,8)}`)));
  if(list.some(d=>d.id===previous))select('workflow').value=previous;
  definition=list.find(d=>d.id===select('workflow').value);imported=false;showDefinition();
}
function showDefinition() {
  el('task-detail').textContent=({'transform-video':'Edit the whole supplied clip. A frame-by-frame image workflow may flicker; temporal consistency and camera adherence must be reviewed.','control-video':'Generate using motion or structure guides, such as edge, depth or pose video. Appearance may change.','first-frame':'Animate a still image. The original camera-motion clip is not supplied.','passthrough':'Transport or native processing only; this does not establish AI generation.'}as Data)[select('task').value]||'';
  el('workflow-detail').textContent=definition?`${definition.description||definition.title||''} · ${definition.verification?.status||'imported'}`:'Import a workflow for this task.';
  el('author-graph').textContent=JSON.stringify(definition?.graph||{},null,2);
  el('timing-change').hidden=!definition?.constraints?.timingChange;el('timing-description').textContent=definition?.constraints?.timingChange||'';field('accept-timing').checked=false;
  renderBindings();renderParameters();showTiming();invalidate();
  el<HTMLButtonElement>('restore-binding').disabled=!savedBinding();el<HTMLButtonElement>('prepare').disabled=!pickedShot()||!definition;
}
function savedBinding() { return [...(project?.workflowBindings||[])].reverse().find((b:Data)=>b.definitionId===definition?.id&&b.shotId===pickedShot()?.id); }
function restoreBinding() {
  const b=savedBinding();if(!b)return;
  field('prompt').value=b.prompt||'';
  for(const [role,asset]of Object.entries(b.assetBindings||{})as[string,Data][])if(roles[role])roles[role].value=asset.assetId?'asset:'+asset.assetId:'render:'+asset.renderId;
  for(const [name,value]of Object.entries(b.parameters||{})){const c=parameters[name];if(!c)continue;if(c instanceof HTMLSelectElement&&!Array.from(c.options).some(o=>o.value===String(value)))c.append(option(String(value),`${value} — unavailable`));if(c.type==='checkbox')(c as HTMLInputElement).checked=Boolean(value);else c.value=String(value);}
  field('accept-timing').checked=false;showTiming();syncPrimarySource();invalidate();el('status').textContent='Saved shot bindings and parameters restored. Prepare a fresh quote before running.';
}
function renderBindings() {
  el('asset-bindings').replaceChildren();for(const key of Object.keys(roles))delete roles[key];
  el('binding-mappings').textContent=JSON.stringify({inputs:definition?.inputs||{},parameters:definition?.parameters||{},outputs:definition?.outputs||[]},null,2);
  for(const [role,mapping] of Object.entries(definition?.inputs||{}) as [string,Data][]){
    if(role==='prompt')continue;const s=document.createElement('select');s.setAttribute('aria-label',role+' asset');s.append(option('','Choose explicitly'));
    const kind=['sourceVideo','controlVideo'].includes(role)?'video':role==='audio'?'audio':'image';
    for(const a of project?.assets||[])if(a.kind===kind&&(!['sourceVideo','controlVideo','firstFrame'].includes(role)||a.shotId===pickedShot()?.id))s.append(option('asset:'+a.id,`${a.source} · ${a.shotId===pickedShot()?.id?'this shot':'other shot'} · v${a.version||1} · ${a.width||''}×${a.height||''} · ${a.id.slice(0,8)}`));
    if(kind==='image')for(const r of project?.renders||[])s.append(option('render:'+r.id,`${r.source} preview · ${r.width}×${r.height} · ${r.id.slice(0,8)}`));
    if(['sourceVideo','controlVideo'].includes(role)&&pickedAsset())s.value='asset:'+pickedAsset().id;
    s.onchange=()=>{syncPrimarySource();invalidate();};roles[role]=s;el('asset-bindings').append(label(`${({sourceVideo:'Source video',controlVideo:'Control video',firstFrame:'First frame',lastFrame:'Last frame',referenceImage:'Reference image',image:'Image',audio:'Audio'}as Data)[role]||role}${mapping.pass?' ('+mapping.pass+')':''}`,s));
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
    const readable=m.label&&!/^\d+ · /.test(m.label)?m.label:m.input.replaceAll('_',' ');control.title=`${node.class_type} · ${m.input}`;
    control.onchange=()=>{field('accept-timing').checked=false;showTiming();invalidate();};parameters[name]=control;el('parameters').append(label(readable,control));
  }
}
function showTiming(graph?:Data){const timing=definition?.constraints?.outputTiming;let text=definition?.constraints?.timingChange||'';if(timing){const value=(key:string)=>{const m=timing[key];if(!m)return NaN;const entry=Object.entries(definition?.parameters||{}).find(([,p])=>(p as Data).nodeId===m.nodeId&&(p as Data).input===m.input);return Number(graph?.[m.nodeId]?.inputs[m.input]??(entry&&parameters[entry[0]]?.value)??definition?.graph[m.nodeId]?.inputs[m.input]);};const frames=value('frameCount'),fps=value('fps');text+=` Configured output: ${value('width')}×${value('height')}, ${frames} frames / ${fps} fps = ${(frames/fps).toFixed(6)} s.`;}el('timing-description').textContent=text;}
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
function checkEdits(version:number){if(version!==editVersion)throw Error('Inputs changed during preparation. Nothing submitted; prepare the current settings again.');}
async function ensurePreset(version:number) {
  if(!definition)throw Error('Choose or import a mapped workflow');if(imported)throw Error('Save the imported mappings and declared outputs first');
  if(!project.workflowDefinitions?.some((d:Data)=>d.id===definition!.id)){const saved=await api('generation/preset',{revision:project.revision,definition});project=saved.project;checkEdits(version);definition=saved.definition;select('workflow').append(option(definition!.id,`${definition!.title||definition!.id} · saved preset ${definition!.id.slice(0,8)}`));select('workflow').value=definition!.id;}
}
function submitReady(){el<HTMLButtonElement>('submit').disabled=!prepared?.validation?.compatible||!field('approve').checked||(!(prepared.quote.status==='known'&&prepared.quote.amount===0)&&!state.paidExecutionEnabled);}
async function reload(){invalidate();const r=await api('project');project=r.project;state=await api('generation');const query=new URLSearchParams(location.search),selected=select('shot').value||query.get('shot');select('shot').replaceChildren(...project.shots.map((s:Data)=>option(s.id,s.title)));if(selected)select('shot').value=selected;showShot();workflowPicker();drawJobs();const requestedJob=reviewedJob?.id||query.get('job'),restored=state.jobs.find((j:Data)=>j.id===requestedJob&&j.results?.length);if(restored)compareJob(restored);el('status').textContent=requestedJob&&!state.jobs.some((j:Data)=>j.id===requestedJob)?'This saved comparison is not in the open project. Open its complete project folder, including assets and generation receipts; your current shots remain available.':`Project revision ${project.revision} · original assets retained`;}
function drawJobs(){const uncertain=(state.jobs||[]).filter((j:Data)=>j.status==='uncertain').length;el('unknown-jobs').hidden=!uncertain;el('unknown-jobs').textContent=uncertain?`${uncertain} request(s) have an UNKNOWN OUTCOME. Do not submit again. Open Job history & recovery below; inspect the backend queue/history before acknowledging an idle backend. No retry is performed.`:'';el('job-summary').textContent=`Job history & recovery · ${(state.jobs||[]).length} receipts${uncertain?' · '+uncertain+' UNKNOWN OUTCOME':''}`;if(uncertain)el<HTMLDetailsElement>('job-history').open=true;el('jobs').replaceChildren();for(const job of state.jobs||[]){
  const box=document.createElement('article'),p=document.createElement('p'),message=document.createElement('p');p.textContent=`${job.definition.title||job.definition.id} · ${job.backend.kind} · ${job.status} · request revision ${job.requestRevision} · ${job.id}`;message.textContent=`${job.message||''}${job.failure?' · '+job.failure.phase+': '+(job.failure.message||'Inspect backend and track this identity'):''} · Backend job: ${job.promptId||'not known'}`;box.append(p,message);
  const track=document.createElement('button');track.textContent='Track exact job';track.onclick=()=>action(async()=>{const r=await api('generation/track',{jobId:job.id});await reload();el('status').textContent=r.job.message||r.job.status;});if(!['failed','closed'].includes(job.status))box.append(track);
  if(job.status==='uncertain'){const recovery=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Recover an unknown outcome · no retry';recovery.append(summary);const idle=document.createElement('input'),history=document.createElement('input');idle.type=history.type='checkbox';recovery.append(label('I confirmed the backend is idle',idle),label('I reviewed backend history and outputs; the outcome may remain unknown',history));const close=document.createElement('button');close.textContent='Close this receipt · no retry';close.onclick=()=>action(async()=>{const r=await api('generation/reconcile',{jobId:job.id,backendIdle:idle.checked,historyReviewed:history.checked});await reload();el('status').textContent=r.job.message;});recovery.append(close);box.append(recovery);}
  if(job.results?.length){const compare=document.createElement('button');compare.textContent='Compare source / result';compare.onclick=()=>compareJob(job);box.append(compare);}el('jobs').append(box);
}}
function compareJob(job:Data){
  const query=new URLSearchParams(location.search);const previous=reviewedJob?.id===job.id?(select('comparison-output').value||(query.get('job')===job.id?query.get('output'):undefined)):query.get('job')===job.id?query.get('output'):undefined;
  reviewedJob=job;select('comparison-output').replaceChildren(...job.results.map((r:Data)=>option(r.id,`${r.mimeType} · ${r.id.slice(0,8)}`)));if(previous){if(job.results.some((r:Data)=>r.id===previous))select('comparison-output').value=previous;else select('comparison-output').replaceChildren(option('','Requested output unavailable — choose explicitly'),...Array.from(select('comparison-output').options));}showComparison();workbenchView(true);
}
function showComparison(){
  const job=reviewedJob;if(!job)return;
  const source=job.sources.sourceVideo||job.sources.controlVideo||job.sources.firstFrame||job.sources.image||job.sources.referenceImage;
  const result=job.results.find((r:Data)=>r.id===select('comparison-output').value);if(!result){el('comparison-empty').hidden=false;el('comparison-empty').textContent='This output is not in the saved request. Choose a declared output explicitly; no candidate was substituted.';for(const id of ['compare-source','compare-result']){video(id).pause();video(id).removeAttribute('src');video(id).hidden=true;el(id+'-image').hidden=true;}for(const id of ['comparison-summary','comparison-detail','comparison-prompt','comparison-request','differences','saved-review'])el(id).textContent='';for(const id of ['source-download','result-download'])el(id).hidden=true;for(const id of ['play-both','pause-both','seek','review'])field(id).disabled=true;field('review-notes').value='';return;}
  remember({job:job.id,output:result.id});
  el('comparison-empty').hidden=true;
  el('comparison-summary').textContent=`${job.definition.title||job.definition.id} · ${job.backend.kind} · request revision ${job.requestRevision}. Saved input v${source?.version||1} · capture revision ${source?.requestRevision??'unknown'}. ${ownership({...source?.binding,file:undefined},source?.provenance?.browserSnapshot,source?.provenance?.render?.cameraLenses)}.`;
  el('comparison-detail').textContent=`${job.definition.title||job.definition.id} · ${job.backend.kind} · saved request ${job.id.slice(0,8)} · request revision ${job.requestRevision}. Selected output ${result.id.slice(0,8)} (${result.mimeType}). Original input v${source?.version||1}, capture revision ${source?.requestRevision??'unknown'}: ${ownership(source?.binding,source?.provenance?.browserSnapshot,source?.provenance?.render?.cameraLenses)}.`;
  el('comparison-prompt').textContent='Saved prompt: '+(job.binding?.prompt||'No prompt used.');el('comparison-request').textContent=JSON.stringify(job,null,2);
  for(const [id,asset]of [['compare-source',source],['compare-result',result]]as[string,Data|undefined][]){const v=video(id),img=el<HTMLImageElement>(id+'-image');v.pause();v.hidden=asset?.kind!=='video';img.hidden=asset?.kind!=='image';v.removeAttribute('src');img.removeAttribute('src');if(asset?.kind==='video')v.src=asset.url;else if(asset?.kind==='image')img.src=asset.url||'/renders/'+asset.id+'.png';}
  field('seek').max=String(Math.max(source?.duration||0,result.duration||0));field('seek').value='0';
  const hasVideo=source?.kind==='video'||result.kind==='video';for(const id of ['play-both','pause-both','seek'])field(id).disabled=!hasVideo;
  for(const [id,asset]of [['source-download',source],['result-download',result]]as[string,Data|undefined][]){const a=el<HTMLAnchorElement>(id);a.hidden=!asset;a.href=asset?.url||(asset?'/renders/'+asset.id+'.png':'');a.download=asset?.filename||asset?.id||'';}
  const review=[...(project.reviews||[])].reverse().find((r:Data)=>r.jobId===job.id&&r.resultIds.includes(result.id));field('review-notes').value=review?.notes||'';el('saved-review').textContent=review?`Saved review · ${review.createdAt}`:'No saved review for this output.';
  el('playback-position').textContent='Aligned playback starts at 0 seconds; each clip retains its own end.';
  const keys=source?.kind==='video'&&result.kind==='video'?['width','height','fps','frameCount','duration','audio']:['width','height'];
  el('differences').textContent=keys.map(k=>`${k}: ${source?.[k]??'none'} → ${result[k]}${source?.[k]!==result[k]?' CHANGED':''}`).join(' · ')+(source?.kind==='video'&&result.kind==='video'?'. Playback uses shared seconds; no stretching, trimming, interpolation or repeated frames. A shorter clip ends at its own duration.':'. A still image has no camera-motion timing to compare. Review the selected output; no timing fit is applied.');
  el<HTMLButtonElement>('review').disabled=false;
}
select('comparison-output').onchange=showComparison;
select('shot').onchange=()=>{remember({shot:select('shot').value,asset:undefined});select('asset').value='';showShot();};select('asset').onchange=()=>{remember({shot:select('shot').value,asset:select('asset').value});for(const role of ['sourceVideo','controlVideo'])if(roles[role])roles[role].value=select('asset').value?'asset:'+select('asset').value:'';showSource(false);};select('task').onchange=workflowPicker;select('workflow').onchange=()=>{definition=allDefinitions().find(d=>d.id===select('workflow').value);imported=false;showDefinition();};
select('backend').onchange=()=>{schema={};el('endpoint-label').hidden=select('backend').value!=='local';el('compatibility').textContent='Backend changed. Revalidate; graph and model are unchanged.';invalidate();};
field('endpoint').oninput=invalidate;field('prompt').oninput=invalidate;for(const id of ['width','height','fps'])field(id).oninput=()=>{showRenderTiming();invalidate();};
el('inspect').onclick=()=>action(async()=>{const r=await api('generation/inspect',{backend:backend()});schema=r.objectInfo;el('compatibility').textContent=`${Object.keys(schema).length} live node schemas · ${r.message}`;renderParameters(true);invalidate();});
el('preview').onclick=()=>action(async()=>{el('status').textContent='Rendering framing preview…';const r=await api('render',{revision:project.revision,shotId:pickedShot().id});project=r.project;const image=project.renders.at(-1);el<HTMLImageElement>('framing').src='/renders/'+image.id+'.png';el('framing').hidden=false;invalidate();el('status').textContent='Framing preview saved.';});
el('render-video').onclick=()=>action(async()=>{el('status').textContent='Rendering animation through Blender MCP; keep Blender idle. A lost connection does not cancel it.';const r=await api('video/blender',{revision:project.revision,shotId:pickedShot().id,width:Number(field('width').value),height:Number(field('height').value),fps:Number(field('fps').value)});project=r.project;showShot();select('asset').value=r.asset.id;showSource();remember({shot:pickedShot().id,asset:r.asset.id});el('status').textContent='Verified animation saved. '+describe(r.asset);});
field('import').onchange=()=>action(async()=>{const file=field('import').files?.[0];if(!file)return;el<HTMLDetailsElement>('import-mappings').open=true;const graph=JSON.parse(await file.text());definition={version:1,id:crypto.randomUUID(),title:file.name.replace(/\.json$/,''),task:select('task').value,graph,inputs:{},parameters:{},outputs:[],constraints:{},pricing:{status:'unknown'},provenance:{source:'User-imported API graph'},verification:{status:'imported'}};imported=true;field('preset-title').value=definition.title;el('author-graph').textContent=JSON.stringify(graph,null,2);importedMapping();invalidate();});
el('prepare').onclick=()=>action(async()=>{
  invalidate();syncPrimarySource();const version=editVersion;await ensurePreset(version);checkEdits(version);const assetBindings:Data={},values:Data={};
  for(const [role,s]of Object.entries(roles)){if(!s.value)throw Error('Choose '+role+' explicitly');const[kind,id]=s.value.split(':');assetBindings[role]=kind==='asset'?{assetId:id}:{renderId:id};}
  for(const [name,c]of Object.entries(parameters))values[name]=c.type==='checkbox'?(c as HTMLInputElement).checked:c.dataset.valueType==='number'?Number(c.value):c.value;
  const binding=await api('generation/bind',{revision:project.revision,definitionId:definition!.id,shotId:pickedShot().id,assetBindings,prompt:field('prompt').value,parameters:values,acceptTimingChange:field('accept-timing').checked});project=binding.project;checkEdits(version);
  requestInput={requestId:crypto.randomUUID(),revision:project.revision,workflowBindingId:binding.workflowBindingId,backend:backend()};
  const quoted=(await api('generation/quote',requestInput)).job;checkEdits(version);prepared=quoted;
  showTiming(prepared!.preparedGraph);
  const pricedNode=prepared!.preparedGraph?.['2']?.inputs;
  const priced=definition!.pricing?.ratePerSecond&&pricedNode?.model_name==='kling-video-o1'&&pricedNode?.resolution==='720p';
  const pricedSource=prepared!.sources.sourceVideo;
  el('prepared-source').hidden=false;if(pricedSource){select('asset').value=pricedSource.id;video('source').src=pricedSource.url;el('prepared-source').textContent=`Prepared source: ${pricedSource.id} · v${pricedSource.version} · capture revision ${pricedSource.requestRevision} · ${describe(pricedSource)} · SHA-256 ${pricedSource.sha256}`;}else el('prepared-source').textContent='Prepared media inputs are listed in the exact request below.';
  const estimate=priced&&pricedSource?`\nBound source v${pricedSource.version}: ${describe(pricedSource)}.\nPublished partner estimate: $${(definition!.pricing.ratePerSecond*pricedSource.duration).toFixed(3)} USD (${definition!.pricing.ratePerSecond}/s at 720p); ${(definition!.pricing.creditsPerSecond*pricedSource.duration).toFixed(2)} Comfy credits. Cloud overhead/credit conversion unknown. This is not a total or provider spending cap.`:definition!.pricing?.ratePerSecond?'\nThe published estimate does not cover these model/resolution settings. Obtain a new quote.':'';
  el('quote').textContent=`${prepared!.validation.compatible?'Schema compatible':'Unavailable requirements'}\n${prepared!.validation.issues.map((i:Data)=>i.message+(i.value!==undefined?' · Required: '+JSON.stringify(i.value):'')).join('\n')}\nCost: ${prepared!.quote.status==='known'?'$'+prepared!.quote.amount+' USD': 'unknown total — quote approval required'}\n${prepared!.quote.reason}${estimate}\nApproval fingerprint: ${prepared!.fingerprint}`;
  el('request').textContent=JSON.stringify(prepared,null,2);state=await api('generation');checkEdits(version);drawJobs();submitReady();el('status').textContent='Prepared exact request. Nothing submitted.';
});
field('accept-timing').onchange=invalidate;
el('restore-binding').onclick=restoreBinding;
field('approve').onchange=submitReady;
el('submit').onclick=()=>action(async()=>{if(!prepared||!requestInput)throw Error('Prepare a fresh quote');const r=await api('generation/submit',{...requestInput,approval:{approved:field('approve').checked,fingerprint:prepared.fingerprint,allowance:{currency:'USD',maxAmount:Number(field('allowance').value),allowUnknownCharges:field('unknown').checked}}});el('status').textContent=r.job.message;state=await api('generation');drawJobs();field('approve').checked=false;submitReady();});
el('reload').onclick=()=>action(reload);
function seekComparison(){const t=Number(field('seek').value),positions:string[]=[];for(const id of ['compare-source','compare-result']){const v=video(id);v.pause();if(!v.hidden&&Number.isFinite(v.duration)){v.currentTime=Math.min(t,v.duration);positions.push(`${id==='compare-source'?'Source':'Result'} ${v.currentTime.toFixed(3)} s${t>=v.duration?' · ended':''}`);}}el('playback-position').textContent=positions.join(' / ');}
el('play-both').onclick=()=>action(async()=>{seekComparison();const t=Number(field('seek').value);for(const id of ['compare-source','compare-result']){const v=video(id);if(!v.hidden&&t<v.duration)await v.play();}});
el('pause-both').onclick=()=>{video('compare-source').pause();video('compare-result').pause();};
field('seek').oninput=seekComparison;
for(const id of ['compare-source','compare-result'])video(id).onended=()=>{el('playback-position').textContent=`${id==='compare-source'?'Source':'Result'} ended at ${video(id).duration.toFixed(3)} s. Each clip stops at its own duration.`;};
el('review').onclick=()=>action(async()=>{if(!reviewedJob)throw Error('Choose a completed comparison');project=(await api('generation/review',{revision:project.revision,jobId:reviewedJob.id,resultIds:[select('comparison-output').value],visuallyReviewed:true,notes:field('review-notes').value})).project;el('status').textContent='Visual review saved against exact output identities.';el('saved-review').textContent='Saved review · '+project.reviews.at(-1).createdAt;});
el('endpoint-label').hidden=select('backend').value!=='local';
field('prompt').value='Transform the main blue subject into luminous amber glass with swirling golden clouds. Preserve its silhouette, the supplied camera motion, perspective, framing, object positions and background parallax. Cinematic studio lighting, stable geometry, consistent materials, no added camera motion, no cuts, no text.';
void action(reload);
