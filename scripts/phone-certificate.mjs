// Creates NEW local certificate files only; never installs/trusts certificates.
import { mkdir, writeFile, open } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const [directory,host]=process.argv.slice(2);
if(!directory||!host||!/^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$/.test(host))throw Error('Usage: node scripts/phone-certificate.mjs NEW_DIRECTORY LAN_IP_OR_HOST');
const root=resolve(directory);await mkdir(root,{mode:0o700});
const key=join(root,'server.key'),caKey=join(root,'ca.key');
for(const file of [key,caKey])await (await open(file,'wx',0o600)).close();
const san=/^\d+\.\d+\.\d+\.\d+$/.test(host)?`IP:${host}`:`DNS:${host}`;
await writeFile(join(root,'server.ext'),`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`,{flag:'wx'});
const run=args=>execFileSync('openssl',args,{cwd:root,stdio:['ignore','ignore','pipe']});
run(['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','365','-keyout','ca.key','-out','ca.crt','-subj','/CN=Previs local phone CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
run(['req','-newkey','rsa:2048','-nodes','-sha256','-keyout','server.key','-out','server.csr','-subj',`/CN=${host}`]);
run(['x509','-req','-in','server.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out','server.crt','-days','90','-sha256','-extfile','server.ext']);
console.log(`Created local certificate files in ${root}. No trust settings changed. Only ca.crt is for the phone; never share either .key file.`);
