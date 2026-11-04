// Linux hosted CI only. Mac may syntax-check this file, never execute its worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
const ELIGIBLE=process.platform==='linux'&&process.env.GITHUB_ACTIONS==='true';
const FIXED_SCRIPT=String.raw`const fs = require('node:fs');
const crypto = require('node:crypto');
const phase = process.argv[2];
const phases = ['rw-positive-control','observe-separator','observe-substitution','observe-interpreter'];
if (!phases.includes(phase) || process.cwd() !== '/work') process.exit(71);
const digest = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const scriptSha256 = digest('/work/argv-probe.cjs');
const ready = '/work/' + phase + '.ready';
const release = '/work/' + phase + '.release';
const fd = fs.openSync(ready, 'wx', 0o644);
try { fs.writeFileSync(fd, JSON.stringify({phase,scriptSha256})); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
const until = process.hrtime.bigint() + 10000000000n;
while (!fs.existsSync(release) && process.hrtime.bigint() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
if (!fs.existsSync(release)) process.exit(72);
if (fs.readFileSync(release,'utf8') !== phase) process.exit(73);
let rwPositive = false;
if (phase === 'rw-positive-control') {
  fs.writeFileSync('/work/injection-marker','RW_CONTROL',{flag:'wx'});
  if (fs.readFileSync('/work/injection-marker','utf8') !== 'RW_CONTROL') process.exit(74);
  fs.unlinkSync('/work/injection-marker'); rwPositive = true;
}
process.stdout.write(JSON.stringify({phase,argv:process.argv,programPath:process.execPath,binarySha256:digest(process.execPath),scriptSha256,uid:process.getuid(),gid:process.getgid(),rwPositive,markerAbsent:!fs.existsSync('/work/injection-marker')})+'\n');
`;
const WORKER_SOURCE=String.raw`import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const [root,fixtureId,isoURL,scriptSha,workNs,docker] = process.argv.slice(2);
const end = BigInt(workNs), now = () => process.hrtime.bigint();
const remaining = () => Number((end-now())/1000000n);
const phases = ['rw-positive-control','observe-separator','observe-substitution','observe-interpreter'];
const payloads = [{"id": "separator", "value": "; node -e 'require(\"node:fs\").writeFileSync(\"injection-marker\",\"UNEXPECTED\")' && node -e 'require(\"node:fs\").writeFileSync(\"injection-marker\",\"UNEXPECTED\")'; #"}, {"id": "substitution", "value": "\u0024(node -e 'require(\"node:fs\").writeFileSync(\"injection-marker\",\"UNEXPECTED\")')\u0024{JARVIS_ARGV_SENTINEL}"}, {"id": "interpreter", "value": "\u0060node -e 'require(\"node:fs\").writeFileSync(\"injection-marker\",\"UNEXPECTED\")'\u0060 | node -e 'require(\"node:fs\").writeFileSync(\"injection-marker\",\"UNEXPECTED\")'"}];
const hash = b => createHash('sha256').update(b).digest('hex');
const save = (name,v) => {const fd=fs.openSync(path.join(root,name),'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(v));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
const fail = code => {throw new Error(code);};
const demand = (v,code) => {if(!v)fail(code);};
const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const command = args => {
 const timeout=Math.min(5000,remaining());demand(timeout>0,'WORK_DEADLINE');
 const r=spawnSync(docker,args,{encoding:'utf8',timeout,killSignal:'SIGKILL',maxBuffer:131072});
 demand(!r.error&&!r.signal,'DOCKER_COMMAND_UNKNOWN');return r;
};
const healthy = () => {const r=command(['info','--format','{{.ServerVersion}}']);demand(r.status===0&&r.stdout.trim().length>0&&r.stderr.trim()==='','DOCKER_UNHEALTHY');};
const missing = (r,target) => r.status!==0&&r.stdout.trim()==='[]'&&['Error: No such object: '+target,'Error: No such container: '+target,'Error response from daemon: No such container: '+target].includes(r.stderr.trim());
const absent = target => {const r=command(['inspect','--type','container',target]);demand(missing(r,target),'CONTAINER_NOT_ABSENT');};
const inspect = name => {const r=command(['inspect','--type','container',name]);demand(r.status===0&&r.stderr.trim()==='','LIVE_INSPECT_FAILED');const a=JSON.parse(r.stdout);demand(Array.isArray(a)&&a.length===1,'LIVE_INSPECT_SHAPE');return a[0];};
const result={kind:'AC03_REAL_ARGV_BOUNDARY',ok:false,reason:'PREPARATION',hostRw:false,cases:[]};
const originalCwd=process.cwd();
try {
 demand(/^[a-f0-9]{32}$/.test(fixtureId)&&/^[a-f0-9]{64}$/.test(scriptSha),'INPUT');
 process.chdir(root); demand(hash(fs.readFileSync('argv-probe.cjs'))===scriptSha,'SCRIPT_CHANGED');
 fs.writeFileSync('injection-marker','HOST_RW_CONTROL',{flag:'wx',mode:0o600});
 demand(fs.readFileSync('injection-marker','utf8')==='HOST_RW_CONTROL','HOST_RW_FAILED');fs.unlinkSync('injection-marker');result.hostRw=true;
 healthy();const img=command(['image','inspect','jarvis-executor:2.1.104','--format','{{.Id}}']);
 const imageId=img.stdout.trim();demand(img.status===0&&img.stderr.trim()===''&&/^sha256:[a-f0-9]{64}$/.test(imageId),'IMAGE_ID');
 save('image-binding.json',{tag:'jarvis-executor:2.1.104',imageId});process.env.JARVIS_EXECUTOR_IMAGE=imageId;
 const {runInWorkdir}=await import(isoURL);let binarySha;
 for(let index=0;index<phases.length;index++) {
  const phase=phases[index],name='jarvis-ac03-'+fixtureId+'-'+phase;
  const args=['/work/argv-probe.cjs',phase,...(index?[payloads[index-1].value]:[])];
  healthy();absent(name);demand(!fs.existsSync('injection-marker'),'MARKER_PRESENT');
  demand(hash(fs.readFileSync('argv-probe.cjs'))===scriptSha,'SCRIPT_CHANGED');
  demand(remaining()>=75000,'INSUFFICIENT_CALL_BUDGET');save(phase+'.announced.json',{phase,name});
  let observed,started=false;
  const observe=async()=>{try{
   const deadline=now()+10000000000n;
   while(!fs.existsSync(phase+'.ready')&&now()<deadline&&remaining()>0)await sleep(20);
   demand(fs.existsSync(phase+'.ready'),'READY_TIMEOUT');
   const ready=JSON.parse(fs.readFileSync(phase+'.ready','utf8'));demand(same(ready,{phase,scriptSha256:scriptSha}),'READY_SHAPE');
   const v=inspect(name),mounts=v.Mounts,networks=Object.keys(v.NetworkSettings?.Networks??{});
   demand(/^[a-f0-9]{64}$/.test(v.Id)&&v.Name==='/'+name&&v.Image===imageId&&v.Config?.Image===imageId&&v.State?.Running===true,'LIVE_IDENTITY');
   demand(same(v.Config.Entrypoint,['node'])&&same(v.Config.Cmd,args)&&v.Config.User==='1000:1000'&&v.Config.WorkingDir==='/work','LIVE_PROGRAM');
   demand(Array.isArray(mounts)&&mounts.length===1&&mounts[0].Type==='bind'&&mounts[0].Source===root&&mounts[0].Destination==='/work'&&mounts[0].RW===true,'LIVE_MOUNT');
   demand(same(networks,['jarvis-internal'])&&v.HostConfig?.NetworkMode==='jarvis-internal','LIVE_NETWORK');
   const binding={phase,name,id:v.Id,imageId,fixtureId,source:root,entrypoint:['node'],args,user:'1000:1000',network:'jarvis-internal',scriptSha256:scriptSha};
   save(phase+'.binding.json',binding);
   const fd=fs.openSync(phase+'.release','wx',0o644);try{fs.writeFileSync(fd,phase);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   return {ok:true,binding};
  }catch(e){return {ok:false,reason:['READY_TIMEOUT','READY_SHAPE','LIVE_INSPECT_FAILED','LIVE_INSPECT_SHAPE','LIVE_IDENTITY','LIVE_PROGRAM','LIVE_MOUNT','LIVE_NETWORK','WORK_DEADLINE','DOCKER_COMMAND_UNKNOWN'].includes(e?.message)?e.message:'OBSERVER_FAILED'};}};
  let r,o;try{r=await runInWorkdir({workdir:root,program:'node',args,image:imageId,name,network:'jarvis-internal',timeoutMs:15000,onStarted:()=>{if(!started){started=true;observed=observe();}}});}finally{if(observed)o=await observed;}
  demand(started&&observed,'OBSERVER_NOT_STARTED');demand(o.ok,o.reason??'OBSERVER_FAILED');
  demand(r.ok===true&&r.exitCode===0&&!r.signal&&!r.timedOut&&!r.abnormal&&!r.killed,'PRODUCTION_CALL_FAILED');
  const raw=r.output;demand(typeof raw==='string'&&Buffer.byteLength(raw)<4000,'OUTPUT_LIMIT');
  const actual=JSON.parse(raw);demand(raw===JSON.stringify(actual)+'\n','OUTPUT_FRAME');
  demand(same(Object.keys(actual).sort(),['phase','argv','programPath','binarySha256','scriptSha256','uid','gid','rwPositive','markerAbsent'].sort()),'OUTPUT_SCHEMA');
  demand(actual.phase===phase&&typeof actual.programPath==='string'&&path.posix.isAbsolute(actual.programPath)&&path.posix.basename(actual.programPath)==='node'&&/^[a-f0-9]{64}$/.test(actual.binarySha256),'PROGRAM_SCHEMA');
  demand(Array.isArray(actual.argv)&&actual.argv.every(x=>typeof x==='string')&&same(actual.argv,[actual.programPath,...args]),'ARGV_CHANGED');
  demand(actual.scriptSha256===scriptSha&&hash(fs.readFileSync('argv-probe.cjs'))===scriptSha,'SCRIPT_CHANGED');
  if(index===0)binarySha=actual.binarySha256;demand(actual.binarySha256===binarySha,'BINARY_CHANGED');
  demand(actual.uid===1000&&actual.gid===1000&&actual.rwPositive===(index===0)&&actual.markerAbsent===true&&!fs.existsSync('injection-marker'),'RW_OR_MARKER');
  healthy();absent(o.binding.id);absent(name);
  const row={phase,payloadClass:index?payloads[index-1].id:'positive',id:o.binding.id,imageId,actualArgv:actual.argv,argvCount:actual.argv.length,actualArgvSha256:hash(JSON.stringify(actual.argv)),expectedArgvSha256:hash(JSON.stringify([actual.programPath,...args])),argvExact:true,liveIdentityMatched:true,mountMatched:true,bindingSha256:hash(JSON.stringify(o.binding)),binarySha256:binarySha,scriptSha256:scriptSha,uid:1000,gid:1000,rwPositive:actual.rwPositive,markerAbsent:true,exitCode:0,signal:null,cleanup:'ABSENT'};
  save(phase+'.done.json',{phase,id:o.binding.id,cleanup:'ABSENT'});result.cases.push(row);
 }
 result.ok=result.hostRw&&result.cases.length===4;result.reason='RECORDED';
}catch(e){result.reason=['INPUT','SCRIPT_CHANGED','HOST_RW_FAILED','DOCKER_UNHEALTHY','DOCKER_COMMAND_UNKNOWN','IMAGE_ID','CONTAINER_NOT_ABSENT','MARKER_PRESENT','INSUFFICIENT_CALL_BUDGET','READY_TIMEOUT','READY_SHAPE','LIVE_INSPECT_FAILED','LIVE_INSPECT_SHAPE','LIVE_IDENTITY','LIVE_PROGRAM','LIVE_MOUNT','LIVE_NETWORK','OBSERVER_NOT_STARTED','OBSERVER_FAILED','PRODUCTION_CALL_FAILED','OUTPUT_LIMIT','OUTPUT_FRAME','OUTPUT_SCHEMA','PROGRAM_SCHEMA','ARGV_CHANGED','BINARY_CHANGED','RW_OR_MARKER','WORK_DEADLINE'].includes(e?.message)?e.message:'FIXED_FAILURE';}
finally{if(!result.ok&&['CONTAINER_NOT_ABSENT','DOCKER_UNHEALTHY','DOCKER_COMMAND_UNKNOWN'].includes(result.reason)){try{save('uncertain.json',{reason:result.reason});}catch{}}process.chdir(originalCwd);process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.ok?0:1;}
`;
const PHASES=['rw-positive-control','observe-separator','observe-substitution','observe-interpreter'];
const hash=b=>createHash('sha256').update(b).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('AC03 fixed verification Node preserves literal argv and marker boundary',{skip:!ELIGIBLE,timeout:180000},async()=>{
 const start=process.hrtime.bigint(),workEnd=start+145000000000n,waitEnd=start+150000000000n,cleanupEnd=start+175000000000n;
 const fixtureId=randomBytes(16).toString('hex'),root=path.join(os.tmpdir(),'jarvis-ac03-'+fixtureId);
 let child,closed=false,exitCode=null,signal=null,spawnError=false,stdout='',stderrBytes=0,overflow=false,timedOut=false,groupUnknown=false,term=false,kill=false;
 let cleanupUnknown=false,fixtureRemoved=false,report,workTimer,killTimer;
 const scriptSha=hash(FIXED_SCRIPT),publicState={kind:'AC03_SUPERVISION',status:'FAILED',workerExit:null,groupAbsent:false,cleanup:'UNKNOWN'};
 const write=(name,data,mode=0o600)=>{const fd=fs.openSync(path.join(root,name),'wx',mode);try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
 const groupState=()=>{if(!child?.pid)return 'ABSENT';try{process.kill(-child.pid,0);return 'PRESENT';}catch(e){if(e.code==='ESRCH')return 'ABSENT';groupUnknown=true;return 'UNKNOWN';}};
 const send=s=>{if(groupState()==='PRESENT'){try{process.kill(-child.pid,s);if(s==='SIGTERM')term=true;else kill=true;}catch(e){if(e.code!=='ESRCH')groupUnknown=true;}}};
 let docker;
 try{
  fs.mkdirSync(root,{mode:0o700});fs.chmodSync(root,0o777);
  docker=fs.realpathSync('/Applications/Docker.app/Contents/Resources/bin/docker');assert.match(docker,/^\/[A-Za-z0-9_./-]+$/);
  write('argv-probe.cjs',FIXED_SCRIPT,0o644);write('worker.mjs',WORKER_SOURCE);
  fs.mkdirSync(path.join(root,'docker-config'),{mode:0o700});
  const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:root,TMPDIR:root+'/',DOCKER_CONFIG:path.join(root,'docker-config'),JARVIS_DOCKER_BIN:docker,JARVIS_EXECUTOR_NETWORK:'jarvis-internal',JARVIS_EXECUTOR_IMAGE:'jarvis-executor:2.1.104'};
  child=spawn(process.execPath,[path.join(root,'worker.mjs'),root,fixtureId,new URL('../src/isolation.mjs',import.meta.url).href,scriptSha,String(workEnd),docker],{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe']});
  child.once('error',()=>{spawnError=true;});child.once('close',(c,s)=>{closed=true;exitCode=c;signal=s;});
  child.stdout.on('data',b=>{if(Buffer.byteLength(stdout)+b.length>32768){overflow=true;send('SIGTERM');}else stdout+=b.toString('utf8');});child.stderr.on('data',b=>{stderrBytes+=b.length;});
  assert.ok(Number.isInteger(child.pid)&&child.pid>0,'WORKER_PID');
  workTimer=setTimeout(()=>{timedOut=true;send('SIGTERM');killTimer=setTimeout(()=>send('SIGKILL'),1000);},Math.max(1,Number((workEnd-process.hrtime.bigint())/1000000n)));
  write('worker-binding.json',JSON.stringify({pid:child.pid,pgid:child.pid,fixtureId}));
  while(!closed&&process.hrtime.bigint()<waitEnd)await sleep(20);
 }catch{publicState.reason='FIXED_PREPARATION_OR_WAIT_FAILURE';}
 finally{
  clearTimeout(workTimer);clearTimeout(killTimer);
  if(child?.pid&&(!closed||groupState()==='PRESENT')){
   send('SIGTERM');const grace=process.hrtime.bigint()+1000000000n;
   while(process.hrtime.bigint()<grace&&process.hrtime.bigint()<waitEnd&&(!closed||groupState()==='PRESENT'))await sleep(20);
   if(!closed||groupState()==='PRESENT')send('SIGKILL');
   while(process.hrtime.bigint()<waitEnd&&(!closed||groupState()==='PRESENT'))await sleep(20);
  }
  const gs=groupState();publicState.groupAbsent=gs==='ABSENT';if(!closed||gs!=='ABSENT'||groupUnknown)cleanupUnknown=true;
  if(child&&!closed){child.stdout.destroy();child.stderr.destroy();child.unref();}
  let commands=0;
  const cmd=args=>{const left=Number((cleanupEnd-process.hrtime.bigint())/1000000n);if(++commands>5||left<=0)throw Error('CLEANUP_BUDGET');const r=spawnSync(docker,args,{encoding:'utf8',timeout:Math.min(5000,left),killSignal:'SIGKILL',maxBuffer:131072});if(r.error||r.signal)throw Error('CLEANUP_COMMAND_UNKNOWN');return r;};
  const absent=(r,target)=>r.status!==0&&r.stdout.trim()==='[]'&&['Error: No such object: '+target,'Error: No such container: '+target,'Error response from daemon: No such container: '+target].includes(r.stderr.trim());
  try{
   const active=[];
   for(const phase of PHASES){if(fs.existsSync(path.join(root,phase+'.announced.json'))&&!fs.existsSync(path.join(root,phase+'.done.json')))active.push(phase);}
   if(active.length>1)throw Error('MULTIPLE_ACTIVE_PHASES');
   if(active.length===1){
    const phase=active[0],b=JSON.parse(fs.readFileSync(path.join(root,phase+'.binding.json'),'utf8')),image=JSON.parse(fs.readFileSync(path.join(root,'image-binding.json'),'utf8'));
    assert.equal(b.phase,phase);assert.equal(b.fixtureId,fixtureId);assert.equal(b.name,'jarvis-ac03-'+fixtureId+'-'+phase);assert.match(b.id,/^[a-f0-9]{64}$/);assert.match(b.imageId,/^sha256:[a-f0-9]{64}$/);assert.equal(b.imageId,image.imageId);assert.equal(b.source,root);assert.equal(b.scriptSha256,scriptSha);
    const r=cmd(['inspect','--type','container',b.id]);
    if(!absent(r,b.id)){
     assert.equal(r.status,0);const a=JSON.parse(r.stdout);assert.equal(a.length,1);const v=a[0];
     assert.equal(v.Id,b.id);assert.equal(v.Name,'/'+b.name);assert.equal(v.Image,b.imageId);assert.equal(v.Config.Image,b.imageId);assert.deepEqual(v.Config.Entrypoint,['node']);assert.deepEqual(v.Config.Cmd,b.args);assert.equal(v.Config.User,'1000:1000');assert.equal(v.Config.WorkingDir,'/work');assert.equal(v.Mounts.length,1);assert.equal(v.Mounts[0].Type,'bind');assert.equal(v.Mounts[0].Source,root);assert.equal(v.Mounts[0].Destination,'/work');assert.equal(v.Mounts[0].RW,true);assert.deepEqual(Object.keys(v.NetworkSettings.Networks),['jarvis-internal']);assert.equal(v.HostConfig.NetworkMode,'jarvis-internal');
     const removal=cmd(['rm','-f',b.id]);if(removal.status!==0&&!absent(removal,b.id))throw Error('REMOVE_FAILED');
    }
    const health=cmd(['info','--format','{{.ServerVersion}}']);assert.equal(health.status,0);assert.ok(health.stdout.trim());
    assert.ok(absent(cmd(['inspect','--type','container',b.id]),b.id));assert.ok(absent(cmd(['inspect','--type','container',b.name]),b.name));
   }
  }catch{cleanupUnknown=true;}
  if(fs.existsSync(path.join(root,'uncertain.json')))cleanupUnknown=true;
  publicState.cleanup=cleanupUnknown?'UNKNOWN':'CONFIRMED';publicState.workerPid=child?.pid??null;publicState.workerPgid=child?.pid??null;publicState.workerExit=exitCode;publicState.workerSignal=signal;publicState.term=term;publicState.kill=kill;publicState.timedOut=timedOut;publicState.stderrBytes=stderrBytes;
  try{
   assert.ok(closed&&!spawnError&&!overflow&&!timedOut&&exitCode===0&&signal===null&&!cleanupUnknown);
   report=JSON.parse(stdout);assert.equal(stdout,JSON.stringify(report)+'\n');assert.deepEqual(Object.keys(report).sort(),['kind','ok','reason','hostRw','cases'].sort());assert.equal(report.kind,'AC03_REAL_ARGV_BOUNDARY');assert.equal(report.ok,true);assert.equal(report.reason,'RECORDED');assert.equal(report.hostRw,true);assert.equal(report.cases.length,4);assert.deepEqual(report.cases.map(c=>c.phase),PHASES);
   assert.ok(report.cases.every(c=>c.argvExact===true&&c.markerAbsent===true&&c.scriptSha256===scriptSha&&c.cleanup==='ABSENT'&&c.exitCode===0));
   assert.equal(hash(fs.readFileSync(path.join(root,'argv-probe.cjs'))),scriptSha);publicState.status='RECORDED';
   console.log('AC03_ARGV_EVIDENCE '+JSON.stringify({...report,kind:'AC03_FIXED_CASE_EVIDENCE',fixedScriptSha256:scriptSha,workerSourceSha256:hash(WORKER_SOURCE)}));
  }catch{publicState.status='FAILED';}
  if(!cleanupUnknown){try{fs.rmSync(root,{recursive:true,force:false});fixtureRemoved=true;}catch{publicState.status='FAILED';}}
  publicState.fixtureRemoved=fixtureRemoved;publicState.elapsedMs=Number((process.hrtime.bigint()-start)/1000000n);console.log('AC03_ARGV_EVIDENCE '+JSON.stringify(publicState));
 }
 assert.equal(publicState.status,'RECORDED','AC03_BOUNDARY_EVIDENCE_FAILED');assert.ok(publicState.elapsedMs<180000);assert.equal(fixtureRemoved,true);
});
