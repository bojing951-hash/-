/** Detect missing pre-call Agent and Conversation guards using real service/DB/oc.execFile.
 * Only the external CLI is a controlled protocol fixture, not a real provider.
 * AGENT_GUARD_SOURCE selects old/new service graphs; AGENT_GUARD_EVIDENCE
 * selects a fresh writable evidence directory for developer/readonly-auditor runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
const source=process.env.AGENT_GUARD_SOURCE || resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const evidence=process.env.AGENT_GUARD_EVIDENCE;
const save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const A='fixture/model-a', B='fixture/model-b';

test('Agent guards block before DB execution and external calls',async t=>{
 assert(Number(process.versions.node.split('.')[0])>=24);assert(isAbsolute(source));assert(!/\s/.test(process.execPath));
 if(evidence){assert(isAbsolute(evidence));assert(!existsSync(evidence));mkdirSync(evidence);}
 const out=evidence || mkdtempSync(join(tmpdir(),'agent-guard-'));
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
  const q=svc.createProject({name:'Other project',slug:'other-fixture'});
  svc.db().prepare('UPDATE agents SET project_id=? WHERE id=?').run(q.id,beta.id);
  const gamma=seed('agt_gamma','gamma','fixture-beta','GAMMA_ROLE');
  const own=svc.createConversation({agent:alpha.id,title:'own'});
  const foreign=[svc.createConversation({agent:beta.id,title:'cross-project'}),svc.createConversation({agent:gamma.id,title:'same-project'})];
  snapshot('seed');
  await t.test('paused Task leaves row and calls unchanged then resumes same ID once',async()=>{
   const task=svc.createTask({project:p.id,title:'paused task',input:'CONTROLLED_TASK',assignee:alpha.id});
   svc.setAgentStatus(alpha.id,'paused');const before=snapshot('paused-before'),count=calls().length;
   const r=response('paused',await svc.runTask(task.id));
   assert.equal(r.blocked,'agent_inactive');assert.equal(r.ok,false);assert.deepEqual(svc.getTask(task.id),task);assert.equal(calls().length,count);assert.deepEqual(snapshot('paused-after').executions,before.executions);
   svc.setAgentStatus(alpha.id,'active');const resumed=response('resumed',await svc.runTask(task.id));
   assert.equal(resumed.ok,true);assert.equal(resumed.task.id,task.id);assert.equal(resumed.task.attempts,1);assert.equal(calls().length,count+1);
   const call=calls()[count];expectModel(call.args,A);assert.equal(call.args[2],'fixture-alpha');assert.equal(call.args[4],`fixture-alpha:task:${task.id}`);
   const execution=svc.db().prepare('SELECT * FROM executions WHERE id=?').get(resumed.execution);assert.equal(execution.agent_id,alpha.id);assert.equal(execution.task_id,task.id);assert.equal(execution.model,A);sameAgent(svc.getAgent(alpha.id),alpha);
  });
  await t.test('paused ordinary Workflow node fails its stage without execution',async()=>{
   svc.setAgentStatus(alpha.id,'paused');const before=snapshot('workflow-before'),count=calls().length;
   const w=svc.createWorkflow({project:p.id,name:'paused workflow',spec:{stages:[{name:'stage',nodes:[{title:'node',agent:alpha.id,input:'CONTROLLED_WORKFLOW'}]}]}});
   const r=response('workflow',await svc.runWorkflow(w.id));assert.equal(r.ok,false);assert.equal(r.blocked,'stage_failed');assert.equal(r.results[0].ok,false);assert.match(r.results[0].error,/paused/);assert.equal(calls().length,count);assert.deepEqual(snapshot('workflow-after').executions,before.executions);
   const task=svc.db().prepare('SELECT * FROM tasks WHERE workflow_id=?').get(w.id);assert.equal(task.attempts,0);assert.equal(task.status,'pending');
  });
  await t.test('existing project terminal approval attempt and assignee precedence survives pause',async()=>{
   const task=svc.createTask({project:p.id,title:'precedence',input:'CONTROLLED_OK',assignee:alpha.id,needsApproval:true});
   svc.setProjectStatus(p.id,'paused');assert.equal((await svc.runTask(task.id)).blocked,'project_paused');svc.setProjectStatus(p.id,'active');
   svc.updateTask(task.id,{status:'done'});assert.equal((await svc.runTask(task.id)).blocked,'terminal_state');
   svc.updateTask(task.id,{status:'pending'});assert.equal((await svc.runTask(task.id)).blocked,'needs_approval');
   svc.db().prepare('UPDATE tasks SET approved_at=?,attempts=max_attempts WHERE id=?').run('fixture',task.id);assert.equal((await svc.runTask(task.id)).blocked,'max_attempts');
   const unassigned=svc.createTask({project:p.id,title:'unassigned',input:'x'});assert.equal((await svc.runTask(unassigned.id)).blocked,'no_assignee');
   svc.setAgentStatus(alpha.id,'active');
  });
  for(const conv of foreign)for(const ref of [conv.id,conv.session_key])await t.test(`foreign explicit Conversation rejected: ${conv.title} ${ref===conv.id?'id':'session_key'}`,async()=>{
   const before=snapshot(`foreign-${conv.title}-${ref===conv.id?'id':'key'}-before`),count=calls().length;
   const r=response(`foreign-${conv.title}-${ref===conv.id?'id':'key'}`,await svc.talk({agent:alpha.id,conversation:ref,message:'CONTROLLED_FOREIGN'}));
   assert.equal(r.ok,false);assert.equal(r.blocked,'conversation_agent_mismatch');assert.equal(calls().length,count);
   const after=snapshot(`foreign-${conv.title}-${ref===conv.id?'id':'key'}-after`);assert.deepEqual(after.executions,before.executions);assert.deepEqual(after.conversations,before.conversations);
  });
  await t.test('own explicit references continue same session and unknown reference preserves error',async()=>{
   for(const ref of [own.id,own.session_key]){const count=calls().length;const r=response('own-'+count,await svc.talk({agent:alpha.id,conversation:ref,message:'CONTROLLED_OWN'}));assert.equal(r.ok,true);assert.equal(r.sessionKey,own.session_key);assert.equal(calls()[count].args[4],own.session_key);assert.equal(calls()[count].args[2],'fixture-alpha');expectModel(calls()[count].args,A);}
   const before=snapshot('unknown-before'),count=calls().length;await assert.rejects(svc.talk({agent:alpha.id,conversation:'missing',message:'CONTROLLED_UNKNOWN'}),/会话不存在/);assert.equal(calls().length,count);assert.deepEqual(snapshot('unknown-after').executions,before.executions);sameAgent(svc.getAgent(alpha.id),alpha);assert.deepEqual(svc.getConversation(own.id),own);
  });
  const final=snapshot('final');assert.equal(final.approvals.length,0);assert.equal(final.execution_resources.length,0);assert(!final.settings.some(s=>s.key==='notify_target'));assert(!final.events.some(e=>e.kind==='notify.sent'));assert(calls().every(e=>e.args[0]==='agent'));safe();
 }finally{
  const live=[];for(const event of calls()){try{process.kill(event.pid,0);live.push(event.pid);}catch(e){if(e.code!=='ESRCH')live.push({pid:event.pid,error:e.code});}}
  save(join(out,'cleanup.json'),{adapterPids:calls().map(x=>x.pid),live,returnRecords:events().filter(e=>e.event==='return'),boundary:'fixture subprocesses only; no real provider or Gateway'});assert.deepEqual(live,[]);
  if(svc)svc.db().close();const after=Object.fromEntries(dependencies.map(p=>[p,hash(p)]));save(join(out,'source-after.json'),after);assert.deepEqual(after,before);safe();
  for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,oldEnv);t.diagnostic(`evidence: ${out}`);
 }
});
