import { randomUUID } from 'node:crypto';
import { openGeneration } from './generation.mjs';
import { validateWorkflowDefinition, assertNoSecrets, validateGraph } from './workflows.mjs';
import { inspectOutputVideo } from './media-inspect.mjs';
import { builtInPresets } from './presets.mjs';

export async function generationRoutes(data, project) {
  const generation = await openGeneration(data,project,{probeVideo:inspectOutputVideo,allowPaid:process.env.PREVIS_ALLOW_PAID === '1'});
  const state = () => ({presets:builtInPresets,definitions:project.get().workflowDefinitions || [],jobs:generation.list(),paidExecutionEnabled:process.env.PREVIS_ALLOW_PAID === '1'});
  async function attach(job) {
    const p=project.get(), results=job.results.filter(r=>!(p.assets || []).some(a=>a.generationJobId===job.id&&a.key===r.key));
    if (!results.length) return;
    await project.mutate(p.revision,next=>{
      for(const result of results)(next.assets ||= []).push({...result,version:1,source:'comfy',binding:(job.sources.sourceVideo||job.sources.controlVideo||job.sources.firstFrame||job.sources.image||job.sources.referenceImage)?.binding||job.shot.binding,pass:job.definition.task,provenance:{requestShot:job.shot,generationJobId:job.id,sourceAssets:job.sources,definitionHash:job.definitionHash,backend:job.backend,prompt:job.binding.prompt,parameters:job.binding.parameters}});
    });
  }
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
      const saved=await project.mutate(input.revision,p=>{(p.workflowDefinitions ||= []).push(definition);});
      return {project:saved,definition};
    }
    if(path==='/api/generation/bind') {
      const id=randomUUID();
      const saved=await project.mutate(input.revision,p=>{
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
    if(path==='/api/generation/submit')return {job:await generation.submit(input)};
    if(path==='/api/generation/track'){const job=await generation.track(input.jobId);await attach(job);return {job,project:project.get()};}
    if(path==='/api/generation/reconcile')return {job:await generation.reconcile(input)};
    if(path==='/api/generation/review'){
      const job=generation.get(input.jobId);
      if(job.status!=='completed'||input.visuallyReviewed!==true||!String(input.notes||'').trim())throw Error('Review the completed output and record observations first');
      if(!Array.isArray(input.resultIds)||!input.resultIds.length||input.resultIds.some(id=>!job.results.some(r=>r.id===id)))throw Error('Select the exact collected output being reviewed');
      const saved=await project.mutate(input.revision,p=>{(p.reviews ||= []).push({id:randomUUID(),jobId:job.id,definitionHash:job.definitionHash,resultIds:[...new Set(input.resultIds)],status:'visually-reviewed',notes:String(input.notes).slice(0,4000),createdAt:new Date().toISOString()});});return {project:saved};
    }
    throw Error('Unknown generation operation');
  }
  return {state,route};
}
