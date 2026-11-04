import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

// Optional phone-only listener. Project APIs and managed assets stay loopback.
export async function startPhoneLan({ root, relay, env = process.env }) {
  let token=null, expires=0, server=null;
  const config={port:Number(env.PREVIS_PHONE_PORT),host:env.PREVIS_PHONE_HOST?.toLowerCase(),cert:env.PREVIS_PHONE_CERT,key:env.PREVIS_PHONE_KEY};
  let error=null;
  const revoke=()=>{token=null;expires=0;relay.revoke();};
  const matches=value=>typeof value==='string'&&token&&Date.now()<expires&&Buffer.byteLength(value)===Buffer.byteLength(token)&&timingSafeEqual(Buffer.from(value),Buffer.from(token));
  const readiness=()=>({available:!!server,error,paired:!!token&&Date.now()<expires,expiresAt:token&&Date.now()<expires?new Date(expires).toISOString():null,ca:!!env.PREVIS_PHONE_CA,/* [director-phone] */scope:'Phone controller only; same LAN and trusted HTTPS required.'});
  if(!config.port || !config.host || !config.cert || !config.key)error='Phone HTTPS not configured. Set PREVIS_PHONE_HOST, PREVIS_PHONE_PORT, PREVIS_PHONE_CERT and PREVIS_PHONE_KEY; see docs/device-controls.md.';
  else if(!Number.isInteger(config.port)||config.port<1024||config.port>65535||!/^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$/.test(config.host))error='Invalid phone host/port.';
  else try{
    const manifest=JSON.parse(await readFile(join(root,'dist/.vite/manifest.json'),'utf8'));
    const allowed=new Set(['/phone.html']);
    const visited=new Set();
    function include(key){if(visited.has(key))return;visited.add(key);const entry=manifest[key];if(!entry)throw Error('Phone build manifest incomplete; rebuild.');for(const file of [entry.file,...(entry.css||[]),...(entry.assets||[])]){if(file.startsWith('assets/')&&!file.includes('..'))allowed.add('/'+file);}for(const item of [...(entry.imports||[]),...(entry.dynamicImports||[])])include(item);}
    include('phone.html');
    const host=`${config.host}:${config.port}`;
    server=createServer({cert:await readFile(config.cert),key:await readFile(config.key)},async(req,res)=>{
      const reply=(code,text,type='text/plain')=>{res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end(text);};
      try{
        if(req.headers.host!==host || req.method!=='GET')return reply(403,'Phone host required');
        const url=new URL(req.url,`https://${host}`);
        if(url.pathname==='/phone-ca.crt' && env.PREVIS_PHONE_CA)return reply(200,await readFile(env.PREVIS_PHONE_CA),'application/x-x509-ca-cert');
        if(!allowed.has(url.pathname))return reply(404,'Phone controller only');
        // Static code contains no session/project data. The socket requires the
        // short-lived capability kept in the link fragment, never an HTTP log.
        return reply(200,await readFile(join(root,'dist',url.pathname)),extname(url.pathname)==='.html'?'text/html':extname(url.pathname)==='.css'?'text/css':'text/javascript');
      }catch{return reply(404,'Unavailable');}
    });
    relay.attachPhoneServer(server,req=>{
      if(req.headers.host!==host || req.headers.origin!==`https://${host}`)return false;
      return matches(new URL(req.url,`https://${host}`).searchParams.get('token'));
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'0.0.0.0',resolve);});
  }catch(e){server?.close();server=null;error=`Phone HTTPS unavailable: ${e.code||e.message}`;}
  const expiry=setInterval(()=>{if(token&&Date.now()>=expires)revoke();},1000);expiry.unref();
  return {
    readiness,revoke,
    pair(){if(!server)throw Error(error);revoke();token=randomBytes(24).toString('base64url');expires=Date.now()+8*60*60*1000;return{url:`https://${config.host}:${config.port}/phone.html#${token}`,expiresAt:new Date(expires).toISOString()};},
    close(){clearInterval(expiry);revoke();server?.close();},
  };
}
