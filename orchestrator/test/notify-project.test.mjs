/** Real workflow/SQLite/execFile regression: missing project/workflow context misattributes notifications.
 * External CLI responses are controlled; no provider or notification is contacted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const file=fileURLToPath(import.meta.url);
const source=process.env.NOTIFY_PROJECT_SOURCE || resolve(dirname(file),'../..');
const save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const rows=p=>readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const run=(bin,args,env)=>new Promise(resolve=>{const child=execFile(bin,args,{env,timeout:30000},(e,stdout,stderr)=>resolve({pid:child.pid,code:e?.code??0,signal:e?.signal??null,stdout,stderr}));});
// Missing slug or discarded real project/workflow IDs must break these real-path checks.
const scenarios=[
 {name:'shared DB failure association',target:'db-target',agentFail:true},
 {name:'shared DB success association',target:'db-target'},
 {name:'message exit23 preserves done',target:'db-target',exit23:true},
 {name:'message exit23 preserves failed',target:'db-target',exit23:true,agentFail:true},
 {name:'no target produces no event',target:null}
];
if(process.env.NOTIFY_PROJECT_SCENARIO){
 const c=JSON.parse(process.env.NOTIFY_PROJECT_SCENARIO),out=process.env.NOTIFY_PROJECT_CASE_DIR;
 const svc=await import(pathToFileURL(join(source,'orchestrator/src/service.mjs')).href);
 try {
 const results=[];
 for(const [i,slug] of ['notify-alpha','notify-beta'].entries()) {
 const project=svc.createProject({name:slug,slug});
 const workspace=join(project.dir,'agents','alpha');mkdirSync(workspace,{recursive:true});
 const agentId='agt_'+i;
 svc.db().prepare('INSERT INTO agents (id,project_id,name,model,role_prompt,workspace,openclaw_agent_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(agentId,project.id,'alpha','fixture/model','controlled role',workspace,'fixture-alpha','active','fixture','fixture');
 if(c.target)svc.setSetting('notify_target','db-target');
 const wf=svc.createWorkflow({project:project.id,name:'Controlled notify workflow',spec:{stages:[{name:'controlled-stage',nodes:[{title:'controlled-node',input:'CONTROLLED_REQUEST',agent:agentId}]}]}});
 results.push({project,wf,result:await svc.runWorkflow(wf.id)});
 }
 const snapshot=Object.fromEntries(['projects','agents','conversations','workflows','tasks','executions','events','settings'].map(n=>[n,svc.db().prepare(`SELECT * FROM ${n}`).all()]));
 save(join(out,'result.json'),results);save(join(out,'sqlite.json'),snapshot);
 } finally {svc.db().close();}
} else test('notifications retain actual project and workflow ownership across shared DB names',async t=>{
 assert(Number(process.versions.node.split('.')[0])>=24);assert(isAbsolute(source));
 const evidence=process.env.NOTIFY_PROJECT_EVIDENCE;
 if(evidence){assert(isAbsolute(evidence));assert(!existsSync(evidence));mkdirSync(evidence);}
 const out=evidence || mkdtempSync(join(tmpdir(),'notify-project-'));
 save(join(out,'input.json'),{source,node:process.version,testSha256:createHash('sha256').update(readFileSync(file)).digest('hex'),argv:process.argv});
 for(const [i,c] of scenarios.entries())await t.test(c.name,async()=>{
 const dir=join(out,String(i));mkdirSync(dir);
 const home=join(dir,'home'),tmp=join(dir,'tmp'),jarvis=join(dir,'jarvis'),bin=join(dir,'sentinels');
 for(const p of [home,tmp,jarvis,bin])mkdirSync(p,{mode:0o700});
 const log=join(dir,'cli.jsonl'),sentinel=join(dir,'sentinel.jsonl');writeFileSync(log,'');writeFileSync(sentinel,'');
 const cli=join(dir,'controlled CLI with spaces.cjs'),homeCli=join(home,'.openclaw/bin/openclaw');
 const sentinelCode=`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(sentinel)},JSON.stringify({pid:process.pid,argv:process.argv})+'\\n');process.exit(97);\n`;
 writeFileSync(cli,`#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2);
const record=x=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,argv:process.argv,...x})+'\\n');
record({event:'start'});process.on('exit',code=>record({event:'exit',code}));
let stdout,stderr,code;
if(a[0]==='agent' && a[1]==='--agent' && a[2]==='fixture-alpha' && a[3]==='--session-id' && a[5]==='--message' && a[7]==='--json'){
 stdout=JSON.stringify({status:'ok',result:{payloads:[{text:'CONTROLLED_RESPONSE_NOT_REAL_PROVIDER'}]}});stderr='CONTROLLED_RESPONSE_NOT_REAL_PROVIDER';code=${c.agentFail?23:0};
}else if(a[0]==='message' && a[1]==='send' && a[2]==='--channel' && a[3]==='feishu' && a[4]==='--target' && a[6]==='-m' && a.length===8){
 stdout=JSON.stringify({success:true,marker:'CONTROLLED_NOTIFICATION_NOT_SENT'});stderr='CONTROLLED_NOTIFICATION_NOT_SENT';code=${c.exit23?23:0};
}else {stdout='';stderr='CONTROLLED_PROTOCOL_REJECTED';code=98;}
record({event:'output',stdout,stderr});fs.writeSync(1,stdout);fs.writeSync(2,stderr);process.exit(code);
`,{mode:0o700});
 for(const name of ['openclaw','docker','claude','security','curl','wget','osascript'])writeFileSync(join(bin,name),sentinelCode,{mode:0o700});
 mkdirSync(dirname(homeCli),{recursive:true});writeFileSync(homeCli,sentinelCode,{mode:0o700});
 const env={HOME:home,TMPDIR:tmp+'/',JARVIS_HOME:jarvis,JARVIS_DB:join(jarvis,'state.db'),PATH:bin,CLAUDE_BIN:join(bin,'claude'),JARVIS_DOCKER_BIN:join(bin,'docker'),JARVIS_AUTH_HELPER:join(bin,'security'),JARVIS_AUTH_SIGNER:join(bin,'security'),NOTIFY_PROJECT_SOURCE:source,NOTIFY_PROJECT_SCENARIO:JSON.stringify(c),NOTIFY_PROJECT_CASE_DIR:dir};
 env.OPENCLAW_BIN=cli;
 save(join(dir,'command.json'),{bin:process.execPath,argv:[file],env,scenario:c});
 const observed=await run(process.execPath,[file],env);save(join(dir,'os.json'),observed);
 try {
 assert.equal(observed.code,0,observed.stderr);
 const results=JSON.parse(readFileSync(join(dir,'result.json'))),db=JSON.parse(readFileSync(join(dir,'sqlite.json')));
 const calls=rows(log),starts=calls.filter(x=>x.event==='start'),messages=starts.filter(x=>x.argv[2]==='message');
 const events=db.events.filter(x=>x.kind==='notify.sent');
 assert.equal(db.projects.length,2);assert.equal(db.workflows.length,2);
 assert.equal(starts.filter(x=>x.argv[2]==='agent').length,2);
 assert.equal(messages.length,c.target?2:0);assert.equal(events.length,c.target?2:0);
 // Accumulate assertions so old-source failure does not hide other association defects.
 const defects=[];const check=fn=>{try{fn();}catch(e){defects.push(e.message);}};
 for(const [index,{project,wf,result}] of results.entries()) {
 const task=db.tasks.find(x=>x.workflow_id===wf.id),execution=db.executions.find(x=>x.task_id===task.id);
 assert.equal(task.project_id,project.id);assert.equal(execution.agent_id,task.assignee_agent_id);
 assert.equal(db.agents.find(x=>x.id===execution.agent_id).project_id,project.id);
 assert.equal(result.workflow.id,wf.id);assert.equal(result.results[0].task,task.id);
 assert.equal(db.workflows.find(x=>x.id===wf.id).project_id,project.id);
 assert.equal(db.workflows.find(x=>x.id===wf.id).status,c.agentFail?'failed':'done');
 assert.equal(task.status,c.agentFail?'retry_pending':'done');assert.equal(execution.status,c.agentFail?'failed':'ok');
 assert.equal(result.ok,!c.agentFail);
 if(c.agentFail){assert.equal(result.blocked,'stage_failed');assert(!('notified' in result));}
 if(!c.target){assert.deepEqual(result.notified,{sent:false,reason:'notify_target 未配置'});continue;}
 const message=messages[index],a=message.argv,event=events[index],payload=JSON.parse(event.payload);
 assert.deepEqual(a.slice(2,9),['message','send','--channel','feishu','--target','db-target','-m']);
 assert.equal(a[1],cli);
 if(c.agentFail){
 check(()=>assert(a[9].includes(project.slug),'failure body missing own slug '+project.slug));
 assert(!a[9].includes(results[1-index].project.slug));
 assert.match(a[9],/Controlled notify workflow/);assert.match(a[9],/controlled-stage.*失败/);
 assert(a[9].includes(result.failed.error),'failure body must retain original error');
 } else assert.equal(a[9],`JARVIS 工作流「Controlled notify workflow」已完成（项目 ${project.slug}）\n- controlled-node: 完成`);
 check(()=>assert.equal(event.project_id,project.id,'notify.sent actual project_id'));
 check(()=>assert.equal(payload.workflow_id,wf.id,'notify.sent actual workflow_id'));
 assert.equal(payload.ok,!c.exit23);assert.equal(typeof payload.error,'string');
 if(c.exit23)assert.match(payload.error,/CONTROLLED_NOTIFICATION_NOT_SENT/);else assert.equal(payload.error,'');
 if(!c.agentFail)assert.equal(result.notified.sent,!c.exit23);
 assert.equal(calls.find(x=>x.pid===message.pid && x.event==='exit').code,c.exit23?23:0);
 assert.match(calls.find(x=>x.pid===message.pid && x.event==='output').stdout,/CONTROLLED_NOTIFICATION_NOT_SENT/);
 }
 save(join(dir,'association-defects.json'),defects);
 assert.equal(readFileSync(sentinel,'utf8'),'');
 if(c.exit23){const probe=await run(cli,['message','send','--channel','feishu','--target','controlled-probe','-m','CONTROLLED_NOTIFICATION_NOT_SENT'],env);save(join(dir,'message-os.json'),probe);assert.equal(probe.code,23);assert.match(probe.stdout,/success/);}
 assert.deepEqual(defects,[]);
 } finally {
 const live=[];for(const x of rows(log).filter(x=>x.event==='start')){try{process.kill(x.pid,0);live.push(x.pid);}catch(e){assert.equal(e.code,'ESRCH');}}
 save(join(dir,'cleanup.json'),{pids:rows(log).filter(x=>x.event==='start').map(x=>x.pid),live});assert.deepEqual(live,[]);
 }
 });
 t.diagnostic('evidence: '+out);
});
