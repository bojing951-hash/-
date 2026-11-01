/** Detect missing per-call model forwarding using real service/DB/oc.execFile.
 * Only the external CLI is a controlled protocol fixture, not a real provider.
 * MODEL_SELECTION_SOURCE selects old/new service graphs; MODEL_SELECTION_EVIDENCE
 * selects a fresh writable evidence directory for developer/readonly-auditor runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
const source=process.env.MODEL_SELECTION_SOURCE || resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const evidence=process.env.MODEL_SELECTION_EVIDENCE;
const save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const A='fixture/model-a', B='fixture/model-b';

test('selected models reach actual CLI arguments while identity and failures remain intact',async t=>{
 assert(Number(process.versions.node.split('.')[0])>=24);assert(isAbsolute(source));assert(!/\s/.test(process.execPath));
 if(evidence){assert(isAbsolute(evidence));assert(!existsSync(evidence));mkdirSync(evidence);}
 const out=evidence || mkdtempSync(join(tmpdir(),'model-selection-'));
 const home=join(out,'home'),jarvis=join(out,'jarvis'),tmp=join(out,'tmp'),bin=join(out,'bin');
 for(const p of [home,jarvis,tmp,bin])mkdirSync(p,{mode:0o700});
 const log=join(out,'adapter-events.jsonl'),sentinel=join(out,'sentinel-events.jsonl');writeFileSync(log,'');writeFileSync(sentinel,'');
 const adapter=join(out,'controlled-openclaw.cjs');
 // The fixture reads process.argv itself. No production helper supplies expected B.
 // Missing --model independently means A; only this external boundary is simulated.
 writeFileSync(adapter,`#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);const log=${JSON.stringify(log)};
const record=e=>fs.appendFileSync(log,JSON.stringify(e)+'\\n');
record({event:'argv',pid:process.pid,argv:process.argv,args});
function finish(code,stdout,stderr=''){record({event:'return',pid:process.pid,code,stdout,stderr});if(stderr)process.stderr.write(stderr);process.stdout.write(stdout,()=>process.exit(code));}
const fixed=['agent','--agent',null,'--session-id',null,'--message',null,'--json'];
if(![8,10].includes(args.length)||fixed.some((v,i)=>v!==null&&v!==args[i])||!["fixture-alpha","fixture-beta"].includes(args[2])||!args[4]||!args[6]||(args.length===10&&(args[8]!=='--model'||!["fixture/model-a","fixture/model-b"].includes(args[9])))){finish(98,'','controlled protocol mismatch');}
else if(args[6]==='CONTROLLED_NONZERO')finish(23,'','controlled process failure');
else if(args[6]==='CONTROLLED_FAILURE')finish(0,JSON.stringify({status:'error',error:{message:'controlled provider refusal'}}));
else {const chosen=args.length===10?args[9]:'fixture/model-a';finish(0,JSON.stringify({status:'ok',result:{payloads:[{text:'CONTROLLED_RESPONSE_NOT_REAL_PROVIDER'}],meta:{agentMeta:{model:chosen,sessionId:args[4]}}}}));}
`,{mode:0o700});
 const paths=['docker','claude','openclaw','git','security','sh','bash','curl','wget','osascript'].map(n=>join(bin,n));
 paths.push(join(home,'.openclaw/bin/openclaw'),join(home,'.openclaw/jarvis/bin/jarvis-auth'),join(home,'.openclaw/jarvis/bin/jarvis-approve'),join(home,'.nvm/versions/node/v24.13.1/bin/claude'));
 for(const p of paths){mkdirSync(dirname(p),{recursive:true});writeFileSync(p,`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(sentinel)},JSON.stringify({pid:process.pid,argv:process.argv})+'\\n');process.exit(97);\n`,{mode:0o700});}
 const cleanEnv={HOME:home,JARVIS_HOME:jarvis,JARVIS_DB:join(jarvis,'state.db'),TMPDIR:tmp+'/',PATH:bin,OPENCLAW_BIN:adapter,CLAUDE_BIN:join(bin,'claude'),JARVIS_DOCKER_BIN:join(bin,'docker'),JARVIS_AUTH_HELPER:join(home,'.openclaw/jarvis/bin/jarvis-approve'),JARVIS_AUTH_SIGNER:join(home,'.openclaw/jarvis/bin/jarvis-auth'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'};
 const oldEnv={...process.env};
 for(const k of Object.keys(process.env))if(k!=='NODE_TEST_CONTEXT')delete process.env[k];Object.assign(process.env,cleanEnv);
 const dependencies=['service','oc','db','executor','isolation','security'].map(n=>join(source,`orchestrator/src/${n}.mjs`));const before=Object.fromEntries(dependencies.map(p=>[p,hash(p)]));save(join(out,'source-before.json'),before);
 save(join(out,'invocation.json'),{source,runtime:process.version,executable:process.execPath,argv:process.argv,env:cleanEnv,adapterSha256:hash(adapter),testSha256:hash(fileURLToPath(import.meta.url)),scope:'Controlled external CLI only; seed Agents/Conversations are test metadata, not real creation'});
 let svc;
 const events=()=>readFileSync(log,'utf8').split('\n').filter(Boolean).map(JSON.parse);
 const calls=()=>events().filter(x=>x.event==='argv');
 const safe=()=>assert.equal(readFileSync(sentinel,'utf8'),'','unexpected external entry invoked');
 function snapshot(label){const data=Object.fromEntries(['agents','conversations','tasks','executions','settings','events','approvals','execution_resources'].map(n=>[n,svc.db().prepare(`SELECT * FROM ${n} ORDER BY rowid`).all()]));save(join(out,`${label}.sqlite.json`),data);safe();return data;}
 function expectModel(args,want){assert.equal(args.filter(x=>x==='--model').length,1,'selected model must be explicitly forwarded exactly once');assert.equal(args[args.indexOf('--model')+1],want);}
 function sameAgent(a,initial){for(const key of ['id','project_id','name','role_prompt','workspace','openclaw_agent_id','status','created_at'])assert.equal(a[key],initial[key],key);assert.equal(readFileSync(join(a.workspace,'ROLE.md'),'utf8'),initial.role_prompt);}
 function response(label,r){save(join(out,label+'.result.json'),r);snapshot(label);return r;}
 try{
  svc=await import(pathToFileURL(join(source,'orchestrator/src/service.mjs')).href);
  const p=svc.createProject({name:'Model selection fixture',slug:'model-fixture'});
  function seed(id,name,ocid,role){const workspace=join(p.dir,'agents',name);mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'ROLE.md'),role);svc.db().prepare('INSERT INTO agents (id,project_id,name,model,role_prompt,workspace,openclaw_agent_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,p.id,name,A,role,workspace,ocid,'active','fixture-created','fixture-created');return svc.getAgent(id);}
  const alpha=seed('agt_alpha','alpha','fixture-alpha','ALPHA_ROLE'),beta=seed('agt_beta','beta','fixture-beta','BETA_ROLE');
  const conversation=svc.createConversation({agent:alpha.id,title:'persistent fixture conversation'}),other=svc.createConversation({agent:beta.id,title:'other agent conversation'});snapshot('seed');
  await t.test('talk A to B uses B on actual argv and retains one Conversation and identity',async()=>{
   const initial=response('talk-a',await svc.talk({agent:alpha.id,conversation:conversation.id,message:'CONTROLLED_OK_A'}));assert.equal(initial.ok,true);assert.equal(initial.model,A);
   const changed=svc.setAgentModel(alpha.id,B);assert.equal(changed.model,B);
   const count=calls().length;const result=response('talk-b',await svc.talk({agent:alpha.id,conversation:conversation.id,message:'CONTROLLED_OK_B'}));assert.equal(result.ok,true);const call=calls()[count];
   expectModel(call.args,B);assert.equal(result.model,B);assert.equal(call.args[2],'fixture-alpha');assert.equal(call.args[4],conversation.session_key);assert.equal(result.sessionKey,conversation.session_key);sameAgent(svc.getAgent(alpha.id),alpha);assert.deepEqual(svc.getConversation(conversation.id),conversation);assert.equal(svc.listConversations(alpha.id).length,1);
  });
  await t.test('Task queued under A runs with current B and records linked success',async()=>{
   svc.setAgentModel(alpha.id,A);const task=svc.createTask({project:p.id,title:'queued at A',input:'CONTROLLED_TASK_B',assignee:alpha.id});assert.equal(svc.getAgent(alpha.id).model,A);svc.setAgentModel(alpha.id,B);
   const count=calls().length;const r=response('task-b',await svc.runTask(task.id));assert.equal(r.ok,true);const call=calls()[count];expectModel(call.args,B);assert.equal(call.args[2],'fixture-alpha');assert.equal(call.args[4],`fixture-alpha:task:${task.id}`);assert.equal(r.task.status,'done');const row=svc.db().prepare('SELECT * FROM executions WHERE id=?').get(r.execution);assert.equal(row.task_id,task.id);assert.equal(row.agent_id,alpha.id);assert.equal(row.status,'ok');assert.equal(row.model,B);sameAgent(svc.getAgent(alpha.id),alpha);
  });
  await t.test('switching alpha leaves beta selection role and Conversation unchanged',async()=>{
   const count=calls().length;const r=response('beta-a',await svc.talk({agent:beta.id,conversation:other.id,message:'CONTROLLED_BETA_A'}));assert.equal(r.ok,true);assert.equal(r.model,A);const call=calls()[count];assert.equal(call.args[2],'fixture-beta');assert.equal(call.args[4],other.session_key);assert(!call.args.includes(B));sameAgent(svc.getAgent(beta.id),beta);assert.equal(svc.getAgent(beta.id).model,A);assert.deepEqual(svc.getConversation(other.id),other);
  });
  await t.test('controlled error envelope makes talk fail and persists failed Execution',async()=>{
   const r=response('talk-error',await svc.talk({agent:alpha.id,conversation:conversation.id,message:'CONTROLLED_FAILURE'}));assert.equal(r.ok,false);assert.match(r.error,/controlled provider refusal/);const rows=svc.db().prepare('SELECT * FROM executions WHERE agent_id=? AND task_id IS NULL ORDER BY rowid DESC').all(alpha.id);assert.equal(rows[0].status,'failed');assert.equal(rows[0].session_key,conversation.session_key);assert.deepEqual(svc.getConversation(conversation.id),conversation);
  });
  await t.test('controlled task refusal preserves retry_pending instead of fake success',async()=>{
   const task=svc.createTask({project:p.id,title:'retry controlled failure',input:'CONTROLLED_FAILURE',assignee:alpha.id,maxAttempts:2});const r=response('task-retry',await svc.runTask(task.id));assert.equal(r.ok,false);assert.equal(r.task.status,'retry_pending');assert.equal(r.task.attempts,1);const row=svc.db().prepare('SELECT * FROM executions WHERE id=?').get(r.execution);assert.equal(row.status,'failed');assert.equal(row.task_id,task.id);
  });
  await t.test('controlled nonzero process failure preserves failed terminal Task',async()=>{
   const task=svc.createTask({project:p.id,title:'exhausted controlled failure',input:'CONTROLLED_NONZERO',assignee:alpha.id,maxAttempts:1});const r=response('task-failed',await svc.runTask(task.id));assert.equal(r.ok,false);assert.match(r.error,/controlled process failure/);assert.equal(r.task.status,'failed');assert.equal(svc.db().prepare('SELECT status FROM executions WHERE id=?').get(r.execution).status,'failed');assert(events().some(x=>x.event==='return'&&x.code===23));
  });
  const final=snapshot('final');assert.equal(final.approvals.length,0);assert.equal(final.execution_resources.length,0);assert(!final.settings.some(s=>s.key==='notify_target'));assert(!final.events.some(e=>e.kind==='notify.sent'));assert(calls().every(e=>e.args[0]==='agent'));safe();
 }finally{
  const live=[];for(const event of calls()){try{process.kill(event.pid,0);live.push(event.pid);}catch(e){if(e.code!=='ESRCH')live.push({pid:event.pid,error:e.code});}}
  save(join(out,'cleanup.json'),{adapterPids:calls().map(x=>x.pid),live,returnRecords:events().filter(e=>e.event==='return'),boundary:'fixture subprocesses only; no real provider or Gateway'});assert.deepEqual(live,[]);
  if(svc)svc.db().close();const after=Object.fromEntries(dependencies.map(p=>[p,hash(p)]));save(join(out,'source-after.json'),after);assert.deepEqual(after,before);safe();
  for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,oldEnv);t.diagnostic(`evidence: ${out}`);
 }
});
