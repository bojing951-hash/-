/** Reject successful envelopes from failed processes; preserve decoding controls.
 * Only the external CLI is controlled, never ask, service, or SQLite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
const source=process.env.ASK_ERROR_SOURCE || resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const evidence=process.env.ASK_ERROR_EVIDENCE;
const save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
test('failed processes cannot complete ask or service work successfully',async t=>{
 assert(Number(process.versions.node.split('.')[0])>=24);assert(isAbsolute(source));
 if(evidence){assert(isAbsolute(evidence));assert(!existsSync(evidence));mkdirSync(evidence);}
 const out=evidence || mkdtempSync(join(tmpdir(),'ask-error-'));
 const home=join(out,'home'),tmp=join(out,'tmp'),jarvis=join(out,'jarvis'),bin=join(out,'bin');
 for(const p of [home,tmp,jarvis,bin])mkdirSync(p,{mode:0o700});
 const log=join(out,'process.jsonl'),sentinel=join(out,'sentinel.jsonl');writeFileSync(log,'');writeFileSync(sentinel,'');
 const cli=join(out,'controlled-openclaw.cjs');
 writeFileSync(cli,`#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);const mode=args[args.indexOf('--message')+1];
const record=e=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,argv:process.argv,...e})+'\\n');
record({event:'start',mode});
if(args[0]!=='agent'||args[1]!=='--agent'||args[2]!=='fixture-alpha'||args[3]!=='--session-id'||!args[4]||args[5]!=='--message'||args[7]!=='--json'){fs.writeSync(2,'protocol mismatch');process.exit(98);}
let stdout=JSON.stringify({status:'ok',result:{payloads:[{text:'CONTROLLED_RESPONSE_NOT_REAL_PROVIDER'}]}});
if(mode==='truncated')stdout='{"status":"ok","result":';
if(mode==='invalid')stdout='{invalid}';
if(mode==='error')stdout=JSON.stringify({status:'error',error:{message:'controlled refusal'}});
fs.writeSync(1,stdout);fs.writeSync(2,'CONTROLLED_RESPONSE_NOT_REAL_PROVIDER');record({event:'output',stdout,stderr:'CONTROLLED_RESPONSE_NOT_REAL_PROVIDER'});
if(mode==='exit23')process.exit(23);
else if(mode==='signal')process.kill(process.pid,'SIGTERM');
else if(mode==='timeout')setInterval(()=>{},1000);
else process.exit(0);
`,{mode:0o700});
 for(const name of ['openclaw','docker','claude','security','git','sh','bash','curl','wget','osascript'])writeFileSync(join(bin,name),`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(sentinel)},JSON.stringify(process.argv)+'\\n');process.exit(97);\n`,{mode:0o700});
 const env={HOME:home,TMPDIR:tmp+'/',JARVIS_HOME:jarvis,JARVIS_DB:join(jarvis,'state.db'),PATH:bin,OPENCLAW_BIN:cli,CLAUDE_BIN:join(bin,'claude'),JARVIS_DOCKER_BIN:join(bin,'docker'),JARVIS_AUTH_HELPER:join(bin,'security'),JARVIS_AUTH_SIGNER:join(bin,'security'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'};
 const original={...process.env};for(const k of Object.keys(process.env))if(k!=='NODE_TEST_CONTEXT')delete process.env[k];Object.assign(process.env,env);
 const events=()=>readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
 save(join(out,'invocation.json'),{source,env,node:process.version,argv:process.argv,testSha256:hash(fileURLToPath(import.meta.url)),fixtureSha256:hash(cli)});
 let svc;
 try{
 const oc=await import(pathToFileURL(join(source,'orchestrator/src/oc.mjs')).href);
 for(const mode of ['exit23','signal','timeout','ok','error','truncated','invalid'])await t.test(`ask ${mode}`,async()=>{
  const args=['agent','--agent','fixture-alpha','--session-id','fixture-session','--message',mode,'--json'];
  const observed=await new Promise(resolve=>{const child=execFile(cli,args,{env,timeout:mode==='timeout'?1000:5000},(err,stdout,stderr)=>resolve({pid:child.pid,code:err?.code??0,signal:err?.signal??null,killed:!!err?.killed,stdout,stderr}));});
  save(join(out,mode+'.os.json'),observed);
  if(mode==='exit23')assert.equal(observed.code,23);
  if(['signal','timeout'].includes(mode)){assert.equal(observed.signal,'SIGTERM');assert.equal(JSON.parse(observed.stdout).status,'ok');}
  if(mode==='timeout')assert.equal(observed.killed,true);
  const count=events().length;
  const result=await oc.ask({agentId:'fixture-alpha',sessionKey:'fixture-session',message:mode,timeoutMs:mode==='timeout'?1000:5000});
  const actual=events().slice(count);save(join(out,mode+'.ask.json'),{result,events:actual});
  assert(actual.some(e=>e.event==='output'),'actual ask child must output before failing');
  if(['exit23','signal','timeout'].includes(mode))assert.equal(JSON.parse(actual.find(e=>e.event==='output').stdout).status,'ok');
  assert.equal(result.ok,mode==='ok');assert.equal(result.text,mode==='ok'?'CONTROLLED_RESPONSE_NOT_REAL_PROVIDER':'');
 });
 svc=await import(pathToFileURL(join(source,'orchestrator/src/service.mjs')).href);
 const project=svc.createProject({name:'Ask error fixture',slug:'ask-error'}),workspace=join(project.dir,'agents','alpha');mkdirSync(workspace,{recursive:true});
 svc.db().prepare('INSERT INTO agents (id,project_id,name,model,role_prompt,workspace,openclaw_agent_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('agt_alpha',project.id,'alpha','fixture/model','fixture role',workspace,'fixture-alpha','active','fixture','fixture');
 const conv=svc.createConversation({agent:'agt_alpha',title:'own'});
 const snapshot=label=>save(join(out,label+'.sqlite.json'),Object.fromEntries(['agents','conversations','tasks','executions'].map(n=>[n,svc.db().prepare(`SELECT * FROM ${n}`).all()])));
 for(const mode of ['exit23','truncated'])await t.test(`service ${mode} finishes talk and retries Task`,async()=>{
  assert.equal(svc.getAgent('agt_alpha').status,'active');assert.equal(conv.agent_id,'agt_alpha');
  const previousIds=new Set(svc.db().prepare('SELECT id FROM executions').all().map(x=>x.id));
  const count=events().length;const talk=await svc.talk({agent:'agt_alpha',conversation:conv.id,message:mode});save(join(out,mode+'.talk.json'),talk);snapshot(mode+'-talk');
  assert(events().length>count,'real CLI must run');assert.equal(talk.ok,false);assert.equal(talk.text,'');
  const task=svc.createTask({project:project.id,title:mode,input:mode,assignee:'agt_alpha',maxAttempts:2});
  for(const [attempt,status] of [[1,'retry_pending'],[2,'failed']]){
   const result=await svc.runTask(task.id);save(join(out,mode+'-task-'+attempt+'.json'),result);snapshot(mode+'-task-'+attempt);
   assert.equal(result.ok,false);assert.equal(svc.getTask(task.id).attempts,attempt);assert.equal(svc.getTask(task.id).status,status);
  }
  const executions=svc.db().prepare('SELECT * FROM executions').all().filter(x=>!previousIds.has(x.id));assert(executions.length>=3);
  for(const row of executions){assert.equal(row.status,'failed');assert(row.finished_at);assert.equal(row.output,'');assert(row.error);}
 });
 snapshot('final');assert.equal(svc.db().prepare("SELECT count(*) n FROM executions WHERE status='running'").get().n,0);
 }finally{
 const live=[];for(const e of events().filter(e=>e.event==='start')){try{process.kill(e.pid,0);live.push(e.pid);}catch(err){assert.equal(err.code,'ESRCH');}}
 save(join(out,'cleanup.json'),{pids:events().filter(e=>e.event==='start').map(e=>e.pid),live});
 if(svc)svc.db().close();assert.deepEqual(live,[]);assert.equal(readFileSync(sentinel,'utf8'),'');
 for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,original);t.diagnostic('evidence: '+out);
 }
});
