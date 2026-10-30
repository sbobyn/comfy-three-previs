import { createFrameStage, writeFrame, encodeFrames, saveVideoAsset, releaseFrameStage, videoReadiness } from './video.mjs';
import { animationCode } from './video-blender.mjs';
import { browserVideoPlan } from '../../shared/browser-delivery.mjs';

export function videoRoutes({ data, project, blender, operations, refreshBlender }) {
  const browserStages = new Map();
  function release(id) {
    const record=browserStages.get(id); if(!record)return {retained:true};
    releaseFrameStage(record.stage.directory); browserStages.delete(id); return {retained:true};
  }
  function expire() {for(const [id,record]of browserStages)if(Date.now()-record.touched>300000)release(id);}
  return async function route(path, input) {
    expire();
    if (path === '/api/video/browser/abort') return release(input.stageId);
    if (path === '/api/video/readiness') return videoReadiness();
    if (path === '/api/video/blender') {
      const p = project.get(), shot = p.shots.find(s => s.id === input.shotId);
      if (input.revision !== p.revision) throw Error('Project changed. Refresh before rendering video.');
      if (shot?.binding.source !== 'blender') throw Error('Choose a saved Blender shot');
      const { catalog } = await refreshBlender();
      if (catalog.file !== shot.binding.file) throw Error('Blender source file changed; refresh and rebind deliberately.');
      const stage = await createFrameStage({ width: input.width, height: input.height, fps: input.fps ?? shot.binding.fps, frameCount: shot.binding.end - shot.binding.start + 1 });
      let operationId;
      try {
        operationId = await operations.begin('render-video', { shotId: shot.id, requestRevision: p.revision, binding: shot.binding, stage });
        const render = await blender.execute(animationCode(shot.binding, { ...stage, outputDir: stage.directory }));
        if (render.ok !== true) throw Error(render.error || 'Blender refused animation');
        const { file, metadata } = await encodeFrames(stage);
        const result = await saveVideoAsset({ root:data, project, revision:p.revision, shotId:shot.id, file, metadata, binding:shot.binding, provenance:{ operationId, render, renderer:'Blender MCP', pass:'beauty' } });
        await operations.finish(operationId,'completed',{assetId:result.asset.id,savedRevision:result.project.revision});
        releaseFrameStage(stage.directory);
        return result;
      } catch (error) {
        if (operationId && operations.get()?.status === 'running') await operations.finish(operationId,blender.uncertain?'uncertain':'failed',{reason:error.message,retainedDirectory:stage.directory});
        if (!blender.uncertain) releaseFrameStage(stage.directory);
        throw error;
      }
    }
    if (path === '/api/video/browser/start') {
      const p = project.get(), shot = p.shots.find(s => s.id === input.shotId);
      if (input.revision !== p.revision) throw Error('Project changed. Reopen the saved browser shot.');
      if (shot?.binding.source !== 'three' || !shot.browser?.frames?.length) throw Error('Choose a saved browser recording');
      const plan = browserVideoPlan(shot.browser.frames, shot.browser.delivery);
      if (input.frameCount !== plan.frameCount) throw Error('Frame count must sample the complete saved motion on the selected FPS grid');
      if (['width','height','fps'].some(key => input[key] !== plan[key])) throw Error('Delivery differs from the saved shot. Save a new shot with the selected delivery settings before exporting.');
      const stage = await createFrameStage(input);
      browserStages.set(stage.id,{stage,shot,revision:p.revision,touched:Date.now()});
      return {stage:{id:stage.id,...plan}};
    }
    if (path.startsWith('/api/video/browser/')) {
      const record = browserStages.get(input.stageId);
      if (!record) throw Error('Unknown browser export stage; reopen the saved shot. No previous export is retried.');
      const {stage,shot,revision}=record; record.touched=Date.now();
      if (path.endsWith('/frame')) {try{return await writeFrame({directory:stage.directory,index:input.index,bytes:Buffer.from(String(input.png),'base64')});}catch(error){release(stage.id);throw error;}}
      if (path.endsWith('/finish')) {
        try {
        const {file,metadata}=await encodeFrames(stage);
        const result=await saveVideoAsset({root:data,project,revision,shotId:shot.id,file,metadata,binding:shot.binding,provenance:{browserSnapshot:shot.browser,sceneVersion:shot.browser.sceneVersion,delivery:browserVideoPlan(shot.browser.frames,shot.browser.delivery),renderer:'Three.js native-resolution render',pass:'beauty',recordedDuration:shot.browser.frames.at(-1).t,sampledEndTime:(stage.frameCount-1)/stage.fps,sampling:'fixed-time saved-motion interpolation; no real-time recording'}});
        return result;
        } finally { release(stage.id); }
      }
    }
    throw Error('Unknown video operation');
  };
}
