// No product import, spawn, fixture, DB or Docker probe outside hosted Linux CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const ELIGIBLE=process.platform==='linux'&&process.env.GITHUB_ACTIONS==='true';
const TRIPWIRE_SOURCE=String.raw`#!/usr/bin/env node
const fs=require('node:fs');
fs.appendFileSync(process.env.JARVIS_BOUNDARY_TRIPWIRE_LOG,JSON.stringify(process.argv.slice(2))+'\n',{mode:0o600});
process.exit(97);
`;
const PROFILE_WORKER_SOURCE=String.raw`import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
const [root,serviceURL]=process.argv.slice(2);
const zeroTables=['verify_profiles','approvals','auth_nonces','execution_resources','agents','conversations','workflows','settings'];
const result={kind:'AC04B_NORMAL_SERVICE',ok:false,reason:'FIXED_FAILURE',runTaskCount:0,executionCount:0,validateRejected:false,taskUnchanged:false,emptySensitiveTables:false,readOnlyReopenEqual:false};
let svc,dbClosed=false,readonly;
try {
 svc=await import(serviceURL);
 const d=svc.db();
 assert.equal(d.prepare('SELECT count(*) AS n FROM projects').get().n,0);
 const project=svc.createProject({name:'AC04 missing profile boundary',slug:'ac04-missing-profile'});
 const task=svc.createTask({project:project.id,title:'Unknown verification profile',kind:'executor',executor:'claude-code',executorConfig:{mode:'plan',cwd:project.dir,verify_profile_id:'vpr_missing_boundary_fixed'}});
 const before=JSON.stringify(task);result.runTaskCount=1;
 const outcome=await svc.runTask(task.id);
 assert.equal(outcome.ok,false);assert.equal(outcome.blocked,'unknown_verify_profile');
 const after=svc.getTask(task.id);assert.equal(JSON.stringify(after),before);assert.equal(after.status,'pending');assert.equal(after.attempts,0);result.taskUnchanged=true;
 const executions=d.prepare('SELECT * FROM executions').all();assert.equal(executions.length,1);
 const e=executions[0],evidence=JSON.parse(e.evidence);
 assert.equal(e.task_id,task.id);assert.equal(e.status,'rejected');assert.equal(e.agent_id,null);assert.equal(e.model,'claude-code-isolated');assert.ok(e.finished_at);assert.equal(evidence.phase,'validate');assert.equal(evidence.blocked,'unknown_verify_profile');
 result.executionCount=1;result.validateRejected=true;
 for(const t of zeroTables)assert.equal(d.prepare('SELECT count(*) AS n FROM '+t).get().n,0);
 result.emptySensitiveTables=true;
 const snapshot=JSON.stringify({task:after,executions});d.close();dbClosed=true;
 readonly=new DatabaseSync(path.join(root,'state.db'),{readOnly:true});
 assert.equal(JSON.stringify({task:readonly.prepare('SELECT * FROM tasks WHERE id=?').get(task.id),executions:readonly.prepare('SELECT * FROM executions').all()}),snapshot);
 for(const t of zeroTables)assert.equal(readonly.prepare('SELECT count(*) AS n FROM '+t).get().n,0);
 readonly.close();readonly=null;result.readOnlyReopenEqual=true;result.ok=true;result.reason='RECORDED';
}catch{result.reason='NORMAL_SERVICE_ASSERTION_FAILED';}
finally{
 try{readonly?.close();if(svc&&!dbClosed)svc.db().close();}catch{result.ok=false;result.reason='DATABASE_CLOSE_UNKNOWN';}
 process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.ok?0:1;
}
`;
const hash=b=>createHash('sha256').update(b).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('AC04B normal service rejects missing verification profile before external programs',{skip:!ELIGIBLE,timeout:30000},async()=>{
 const start=process.hrtime.bigint(),workEnd=start+15000000000n,waitEnd=start+20000000000n;
 let root,child,closed=false,code=null,signal=null,spawnError=false,stdout='',stderrBytes=0,overflow=false,timedOut=false,term=false,kill=false,unknown=false,removed=false,timer,killTimer;
 const record={kind:'AC04B_SUPERVISION',status:'FAILED',runTaskCount:0,tripwireCount:null,groupAbsent:false,cleanup:'UNKNOWN'};
 const group=()=>{if(!child?.pid)return 'ABSENT';try{process.kill(-child.pid,0);return 'PRESENT';}catch(e){if(e.code==='ESRCH')return 'ABSENT';unknown=true;return 'UNKNOWN';}};
 const send=s=>{const g=group();if(g==='UNKNOWN')unknown=true;if(g==='PRESENT'){try{process.kill(-child.pid,s);if(s==='SIGTERM')term=true;else kill=true;}catch(e){if(e.code!=='ESRCH')unknown=true;}}};
 const write=(name,text,mode=0o600)=>{const fd=fs.openSync(path.join(root,name),'wx',mode);try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
 try{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-ac04b-'));fs.chmodSync(root,0o700);
  fs.mkdirSync(path.join(root,'bin'),{mode:0o700});fs.mkdirSync(path.join(root,'tmp'),{mode:0o700});
  write('worker.mjs',PROFILE_WORKER_SOURCE);write('bin/tripwire',TRIPWIRE_SOURCE,0o700);fs.symlinkSync(process.execPath,path.join(root,'bin/node'));
  for(const name of ['sh','docker','git','openclaw','claude','security','codesign'])fs.symlinkSync('tripwire',path.join(root,'bin',name));
  const trip=path.join(root,'bin/tripwire');
  const env={HOME:root,JARVIS_HOME:root,JARVIS_DB:path.join(root,'state.db'),TMPDIR:path.join(root,'tmp')+'/',XDG_CONFIG_HOME:root,XDG_DATA_HOME:root,XDG_CACHE_HOME:root,PATH:path.join(root,'bin'),JARVIS_BOUNDARY_TRIPWIRE_LOG:path.join(root,'tripwire.log'),JARVIS_DOCKER_BIN:trip,OPENCLAW_BIN:trip,CLAUDE_BIN:trip,JARVIS_AUTH_HELPER:trip,JARVIS_AUTH_SIGNER:trip};
  child=spawn(process.execPath,[path.join(root,'worker.mjs'),root,new URL('../src/service.mjs',import.meta.url).href],{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe']});
  child.once('error',()=>{spawnError=true;});child.once('close',(c,s)=>{closed=true;code=c;signal=s;});
  child.stdout.on('data',b=>{if(Buffer.byteLength(stdout)+b.length>=4000){overflow=true;send('SIGTERM');}else stdout+=b.toString('utf8');});child.stderr.on('data',b=>{stderrBytes+=b.length;});
  assert.ok(Number.isInteger(child.pid)&&child.pid>0);
  timer=setTimeout(()=>{timedOut=true;send('SIGTERM');killTimer=setTimeout(()=>send('SIGKILL'),1000);},Math.max(1,Number((workEnd-process.hrtime.bigint())/1000000n)));
  write('worker-binding.json',JSON.stringify({pid:child.pid,pgid:child.pid}));
  while(!closed&&process.hrtime.bigint()<waitEnd)await sleep(20);
 }catch{record.reason='FIXED_PREPARATION_OR_WAIT_FAILURE';}
 finally{
  clearTimeout(timer);clearTimeout(killTimer);
  if(child?.pid&&(!closed||group()==='PRESENT')){
   send('SIGTERM');const grace=process.hrtime.bigint()+1000000000n;
   while(process.hrtime.bigint()<grace&&process.hrtime.bigint()<waitEnd&&(!closed||group()==='PRESENT'))await sleep(20);
   if(!closed||group()==='PRESENT')send('SIGKILL');
   while(process.hrtime.bigint()<waitEnd&&(!closed||group()==='PRESENT'))await sleep(20);
  }
  const g=group();record.groupAbsent=g==='ABSENT';if(!closed||g!=='ABSENT')unknown=true;
  if(child&&!closed){child.stdout.destroy();child.stderr.destroy();child.unref();}
  try{
   const log=path.join(root,'tripwire.log');if(fs.existsSync(log))assert.ok(fs.statSync(log).size<65536);const raw=fs.existsSync(log)?fs.readFileSync(log):Buffer.alloc(0);record.tripwireCount=raw.length?raw.toString('utf8').split('\n').filter(Boolean).length:0;record.tripwireLogSha256=hash(raw);
   assert.ok(closed&&!spawnError&&!overflow&&!timedOut&&!unknown&&code===0&&signal===null);
   const report=JSON.parse(stdout);assert.equal(stdout,JSON.stringify(report)+'\n');
   assert.deepEqual(Object.keys(report).sort(),['kind','ok','reason','runTaskCount','executionCount','validateRejected','taskUnchanged','emptySensitiveTables','readOnlyReopenEqual'].sort());
   assert.equal(report.kind,'AC04B_NORMAL_SERVICE');assert.equal(report.ok,true);assert.equal(report.reason,'RECORDED');assert.equal(report.runTaskCount,1);assert.equal(report.executionCount,1);
   for(const k of ['validateRejected','taskUnchanged','emptySensitiveTables','readOnlyReopenEqual'])assert.equal(report[k],true);
   assert.equal(raw.length,0);
   Object.assign(record,report,{kind:'AC04B_SUPERVISION',status:'RECORDED',tripwireCount:0,tripwireLogSha256:hash(raw)});
  }catch{record.status='FAILED';}
  if(!unknown&&root){try{fs.rmSync(root,{recursive:true,force:false});removed=true;}catch{record.status='FAILED';}}
  Object.assign(record,{cleanup:unknown?'UNKNOWN':'CONFIRMED',workerPid:child?.pid??null,workerPgid:child?.pid??null,workerExit:code,workerSignal:signal,term,kill,timedOut,stderrBytes,fixtureRemoved:removed,elapsedMs:Number((process.hrtime.bigint()-start)/1000000n),workerSourceSha256:hash(PROFILE_WORKER_SOURCE),tripwireSourceSha256:hash(TRIPWIRE_SOURCE)});
  console.log('AC04_MISSING_PROFILE_EVIDENCE '+JSON.stringify(record));
 }
 assert.equal(record.status,'RECORDED','AC04B_BOUNDARY_EVIDENCE_FAILED');assert.ok(record.elapsedMs<30000);assert.equal(removed,true);
});
