import { randomUUID } from 'node:crypto';
import { openGeneration } from './generation.mjs';
import { validateWorkflowDefinition, assertNoSecrets, validateGraph } from './workflows.mjs';
import { inspectOutputVideo } from './media-inspect.mjs';
import { builtInPresets } from './presets.mjs';

export async function generationRoutes(data, project, options = {}) {
  const generation = await openGeneration(data,project,{probeVideo:inspectOutputVideo,allowPaid:process.env.PREVIS_ALLOW_PAID === '1',...options,requireAttachment:true});
  const state = () => ({presets:builtInPresets,definitions:project.get().workflowDefinitions || [],jobs:generation.list(),paidExecutionEnabled:process.env.PREVIS_ALLOW_PAID === '1'});
  let tracker=null, attaching=Promise.resolve();
  // The tracker and HTTP routes can both attach one job: serialize, and re-check inside the engine write queue
  // (project.append), so a concurrent bind, video-refs registration or edit never fails the attach with "Project changed".
  const attach=job=>{const task=attaching.then(()=>attachNow(job));attaching=task.catch(()=>{});return task;};
  async function attachNow(job) {
    const missing=assets=>(job.results||[]).filter(r=>!(assets || []).some(a=>a.generationJobId===job.id&&a.key===r.key));
    if(!missing(project.get().assets).length)return;
    await project.append(next=>{
      const add=missing(next.assets); if(!add.length)return false;
      for(const result of add)(next.assets ||= []).push({...result,version:1,source:'comfy',binding:(job.sources.sourceVideo||job.sources.controlVideo||job.sources.firstFrame||job.sources.image||job.sources.referenceImage)?.binding||job.shot.binding,pass:job.definition.task,provenance:{requestShot:job.shot,generationJobId:job.id,sourceAssets:job.sources,definitionHash:job.definitionHash,backend:job.backend,prompt:job.binding.prompt,parameters:job.binding.parameters}});
    });
  }
  // Presets and bindings are additive and validated against the latest project inside the write queue, so a revision
  // moved by another writer (a batch on another shot, the tracker attaching a result) no longer refuses them.
  // A revision from the future is still a client bug.
  const additive=(revision,fn)=>{if(revision!==undefined&&(!Number.isInteger(revision)||revision>project.get().revision)){const e=Error('Unknown project revision; refresh first');e.status=409;throw e;}return project.append(fn);};
  let resultDirector;
  generation.setAttachment(async job=>{
    await attach(job);
    const id=job.shot?.browser?.director?.projectId;
    if(id){
      if(!resultDirector)throw Error('Director attachment handler is unavailable');
      const synced=await resultDirector.syncResults(id);
      if((job.results||[]).some(r=>!synced.project.assets?.some(a=>a.source?.jobId===job.id&&a.source?.resultId===r.id)))throw Error('Director result attachment is incomplete');
    }
  });
  const track=id=>tracker?tracker.trackNow('generation',id):generation.track(id);
  // Attachment runs inside the durable job lifecycle, before completed; the tracker's best-effort onTerminal is not used.
  const trackerSource=({director}={})=>{resultDirector=director;return ({
    name:'generation',list:generation.list,get:id=>generation.get(id),isActive:generation.isActive,track:(id,tracking)=>generation.track(id,tracking),
    expectedSeconds:generation.expectedSeconds,label:generation.label,kindOf:generation.kindOf,
    projectIdOf:job=>job.shot?.browser?.director?.projectId||null,costOf:job=>job.quote?.amount??job.quote?.estimate??null,
    resultsOf:job=>(job.results||[]).map(r=>({id:r.id,kind:r.kind,url:r.url})),
  });};
  async function route(path,input) {
    assertNoSecrets(input);
    if(path==='/api/generation/inspect')return generation.inspect(input.backend);
    if(path==='/api/generation/validate'){
      const definition=validateWorkflowDefinition(input.definition), inspected=await generation.inspect(input.backend);
      const deferredInputs=Object.entries(definition.inputs).filter(([role])=>role!=='prompt').map(([role,m])=>({...m,kind:['sourceVideo','controlVideo'].includes(role)?'video':role==='audio'?'audio':'image'}));
      return {definition,backend:inspected.backend,validation:validateGraph(definition.graph,inspected.objectInfo,{deferredInputs})};
    }
    if(path==='/api/generation/preset') {
      const definition=validateWorkflowDefinition({...input.definition,id:randomUUID(),verification:{status:'imported'}});
      const saved=await additive(input.revision,p=>{(p.workflowDefinitions ||= []).push(definition);});
      return {project:saved,definition};
    }
    if(path==='/api/generation/bind') {
      const id=randomUUID();
      const saved=await additive(input.revision,p=>{
        if(!p.shots.some(s=>s.id===input.shotId))throw Error('Choose a saved originating shot');
        const definition=p.workflowDefinitions?.find(d=>d.id===input.definitionId);
        if(!definition)throw Error('Save the mapped workflow preset first');
        for(const role of ['sourceVideo','controlVideo','firstFrame']){
          const b=input.assetBindings?.[role]; if(!b)continue;
          const asset=b.assetId?p.assets?.find(a=>a.id===b.assetId):p.renders.find(r=>r.id===b.renderId);
          if(!asset||asset.shotId!==input.shotId)throw Error('The primary input must belong to the originating shot');
        }
        p.workflowBindings.push({id,definitionId:definition.id,shotId:input.shotId,assetBindings:input.assetBindings || {},prompt:String(input.prompt || ''),parameters:input.parameters || {},acceptTimingChange:input.acceptTimingChange===true,createdAt:new Date().toISOString()});
      });return {project:saved,workflowBindingId:id};
    }
    if(path==='/api/generation/prepare')return {job:await generation.prepare(input)};
    if(path==='/api/generation/quote')return {job:await generation.quote(input)};
    if(path==='/api/generation/submit'){const job=await generation.submit(input);tracker?.watch('generation',job.id);return {job};}
    if(path==='/api/generation/track'){const job=await track(input.jobId);await attach(job);return {job,project:project.get()};}
    if(path==='/api/generation/reconcile'){const job=await generation.reconcile(input);await attach(job);return {job,project:project.get()};}
    if(path==='/api/generation/review'){
      const job=generation.get(input.jobId);
      if(job.status!=='completed'||input.visuallyReviewed!==true||!String(input.notes||'').trim())throw Error('Review the completed output and record observations first');
      if(!Array.isArray(input.resultIds)||!input.resultIds.length||input.resultIds.some(id=>!job.results.some(r=>r.id===id)))throw Error('Select the exact collected output being reviewed');
      const saved=await project.mutate(input.revision,p=>{(p.reviews ||= []).push({id:randomUUID(),jobId:job.id,definitionHash:job.definitionHash,resultIds:[...new Set(input.resultIds)],status:'visually-reviewed',notes:String(input.notes).slice(0,4000),createdAt:new Date().toISOString()});});return {project:saved};
    }
    throw Error('Unknown generation operation');
  }
  return {state,route,attach,trackerSource,useTracker:t=>{tracker=t;}};
}
