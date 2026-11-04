import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Inspect returned media without fitting timing, dropping audio or transcoding.
export async function inspectOutputVideo(bytes, { mime }) {
  const extension = ({'video/mp4':'.mp4','video/webm':'.webm','video/quicktime':'.mov','video/x-matroska':'.mkv'})[mime];
  if (!extension || bytes.length > 512*1024*1024) throw Error('Unsupported output container or output exceeds 512 MB');
  const directory = await mkdtemp(join(tmpdir(),'previs-output-probe-')), file=join(directory,'output'+extension);
  await writeFile(file,bytes,{flag:'wx'});
  const raw=await new Promise((resolve,reject)=>{
    const child=spawn(process.env.PREVIS_FFPROBE || 'ffprobe',['-v','error','-protocol_whitelist','file','-count_frames','-show_streams','-show_format','-of','json',file],{stdio:['ignore','pipe','pipe']});
    let output=''; const timer=setTimeout(()=>{child.kill();reject(Error('Output media probe timed out; file retained'));},120000);
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>1024*1024){child.kill();reject(Error('Output probe too large'));}});child.stderr.resume();
    child.once('error',()=>{clearTimeout(timer);reject(Error('ffprobe unavailable for returned video'));});
    child.once('close',code=>{clearTimeout(timer);code?reject(Error('Returned video could not be decoded')):resolve(output);});
  });
  const info=JSON.parse(raw), video=info.streams?.filter(s=>s.codec_type==='video') || [];
  if(video.length!==1)throw Error('Returned video must contain exactly one video stream');
  const v=video[0], [n,d]=String(v.avg_frame_rate).split('/').map(Number), fps=n/d, frameCount=Number(v.nb_read_frames), duration=Number(v.duration || info.format?.duration);
  if(!Number.isFinite(fps)||fps<=0||!Number.isInteger(frameCount)||frameCount<1||!Number.isFinite(duration)||duration<=0)throw Error('Returned video has unverifiable timing');
  return {kind:'video',width:v.width,height:v.height,fps,fpsRational:v.avg_frame_rate,frameCount,duration,codec:v.codec_name,audio:info.streams.some(s=>s.codec_type==='audio'),audioStreams:info.streams.filter(s=>s.codec_type==='audio').map(s=>({codec:s.codec_name,sampleRate:s.sample_rate,channels:s.channels,duration:Number(s.duration||duration)})),variableRate:v.avg_frame_rate!==v.r_frame_rate,mimeType:mime,bytes:bytes.length};
}
