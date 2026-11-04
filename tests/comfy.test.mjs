// Simulated local Comfy HTTP server; no GPU, model or actual Comfy execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openProject } from '../server/previs/store.mjs';
import { openComfy, validateWorkflow, localComfyUrl } from '../server/previs/comfy.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
const graph = { '1': {class_type:'LoadImage',inputs:{image:'author-image.png'},_meta:{title:'Keep my label'}}, '2':{class_type:'SaveImage',inputs:{images:['1',0],filename_prefix:'previs/test'}} };
test('local-only graph boundary refuses custom/paid/model nodes, unbound inputs and undeclared outputs', () => {
  assert.deepEqual(validateWorkflow(graph,'1',['2']).graph,graph);
  for(const url of ['https://cloud.example','http://192.168.1.2:8188','http://user:password@localhost:8000','http://localhost:8000/path']) assert.throws(()=>localComfyUrl(url));
  for(const bad of [{...graph,'3':{class_type:'KSampler',inputs:{}}},{...graph,'1':{class_type:'API_Node',inputs:{}}},{...graph,'2':{class_type:'SaveImage',inputs:{images:['9',0],filename_prefix:'test'}}},{...graph,'2':{class_type:'SaveImage',inputs:{images:['1',0],filename_prefix:'../escape'}}}]) assert.throws(()=>validateWorkflow(bad,'1',['2']));
  assert.throws(()=>validateWorkflow(graph,'wrong',['2'])); assert.throws(()=>validateWorkflow(graph,'1',[]));
});
test('simulated Comfy: ambiguous acceptance, restart, exact identity and declared output collection never resubmit', {timeout:15000}, async()=>{
  let submitted, submissions=0, historyVisible=false, uploadCount=0, imageGets=0, queueBusy=false, mismatch=false;
  const server=createServer(async(req,res)=>{
    const send=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    if(req.url==='/system_stats') return send({system:{comfyui_version:'SIMULATED'}});
    if(req.url==='/object_info/LoadImage')return send({LoadImage:{python_module:'nodes',input:{required:{image:[[]]}},output:['IMAGE','MASK']}});
    if(req.url==='/object_info/SaveImage')return send({SaveImage:{python_module:'nodes',input:{required:{images:['IMAGE'],filename_prefix:['STRING']}},output_node:true}});
    if(req.url==='/queue')return send({queue_running:queueBusy?[[0,'someone-else']]:[],queue_pending:[]});
    if(req.url==='/upload/image'){
      uploadCount++;const chunks=[];for await(const c of req)chunks.push(c);
      const form=await new Response(Buffer.concat(chunks),{headers:req.headers}).formData();
      return send({name:form.get('image').name,subfolder:form.get('subfolder'),type:'input'});
    }
    if(req.url==='/prompt'){
      submissions++;const chunks=[];for await(const c of req)chunks.push(c);submitted=JSON.parse(Buffer.concat(chunks));
      // Backend accepts it, but the response is lost. Never repeat this POST.
      req.socket.destroy(); return;
    }
    if(req.url.startsWith('/history/')) return send(historyVisible?{[submitted.prompt_id]:{prompt:[0,submitted.prompt_id,submitted.prompt,{previs:{...submitted.extra_data.previs,jobId:mismatch?'wrong':submitted.extra_data.previs.jobId}}],status:{status_str:'success',completed:true},outputs:{'2':{images:[{filename:'out.png',subfolder:'previs',type:'output'}]},'99':{images:[{filename:'unrelated.png',subfolder:'private',type:'output'}]}}}}:{});
    if(req.url.startsWith('/view?')){imageGets++;assert.ok(!req.url.includes('unrelated'));res.setHeader('Content-Type','image/png');res.end(png);return;}
    res.writeHead(404);res.end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const root=await mkdtemp(join(tmpdir(),'previs-comfy-')), project=await openProject(root), image=await project.image(png);
    const binding={source:'blender',file:'fixture.blend',scene:'Scene',camera:'Camera',fps:24,start:1,end:24,frame:1};
    const workflow={id:randomUUID(),renderId:image.id,shotId:'shot',...validateWorkflow(graph,'1',['2'])};
    await project.mutate(1,p=>{p.shots.push({id:'shot',title:'fixture',binding,renders:[image.id]});p.renders.push({...image,shotId:'shot',source:'blender',pass:'beauty',binding});p.workflowBindings.push(workflow);});
    const options={url:`http://127.0.0.1:${server.address().port}`,timeout:1000};let comfy=await openComfy(root,project,options);
    const requestId=randomUUID().toUpperCase(), input={revision:2,workflowBindingId:workflow.id,requestId};
    queueBusy=true;await assert.rejects(comfy.submit(input),/queue is busy/);assert.equal(uploadCount,0);queueBusy=false;
    const accepted=await comfy.submit(input);assert.equal(accepted.status,'uncertain');assert.equal(submissions,1);assert.equal(accepted.id,requestId.toLowerCase());
    assert.deepEqual(project.get().workflowBindings[0].graph,graph);assert.notEqual(submitted.prompt['1'].inputs.image,graph['1'].inputs.image);assert.deepEqual(submitted.prompt['2'],graph['2']);
    comfy=await openComfy(root,project,options);assert.equal(comfy.list().length,1);
    assert.equal((await comfy.submit(input)).status,'uncertain');assert.equal(submissions,1);
    await assert.rejects(comfy.submit({...input,requestId:randomUUID()}),/Resolve the existing/);
    assert.equal((await comfy.track(requestId)).status,'uncertain');assert.equal(submissions,1);
    await assert.rejects(comfy.reconcile({jobId:requestId,backendIdle:true}),/Confirm the exact/);
    queueBusy=true; await assert.rejects(comfy.reconcile({jobId:requestId,backendIdle:true,historyReviewed:true}),/queue must/); queueBusy=false;
    await project.mutate(2,p=>{p.shots[0].binding={...binding,camera:'New camera',frame:20};});
    historyVisible=true;mismatch=true;const refused=await comfy.track(requestId);assert.match(refused.message,/does not match/);assert.equal(imageGets,0);
    mismatch=false;const completed=await comfy.track(requestId);assert.equal(completed.status,'completed');assert.equal(imageGets,1);assert.equal(completed.results.length,1);
    const saved=project.get(), result=saved.renders.find(r=>r.comfyJobId===completed.id);assert.equal(result.requestRevision,2);assert.equal(result.binding.camera,'Camera');assert.equal(result.binding.frame,1);assert.equal(result.sourceRenderId,image.id);assert.equal(saved.shots[0].binding.camera,'New camera');
    comfy=await openComfy(root,project,options);await comfy.track(requestId);assert.equal(project.get().revision,saved.revision);assert.equal(submissions,1);assert.equal(imageGets,1);
    assert.ok(JSON.parse(await readFile(join(root,'comfy-jobs',completed.id+'.json'),'utf8')).submittedGraph);
    historyVisible=false;
    const second=await comfy.submit({...input,revision:project.get().revision,requestId:randomUUID()});
    assert.equal(second.status,'uncertain');
    const closed=await comfy.reconcile({jobId:second.id,backendIdle:true,historyReviewed:true});
    assert.equal(closed.status,'closed'); assert.match(closed.message,/Outcome remains unknown/);
    assert.equal(submissions,2); assert.equal((await comfy.submit({...input,requestId:second.id})).status,'closed'); assert.equal(submissions,2);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
