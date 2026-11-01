/** Real workflow/SQLite/execFile regression: ignoring OPENCLAW_BIN breaks notification.
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
const source=process.env.NOTIFY_PATH_SOURCE || resolve(dirname(file),'../..');
const save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const rows=p=>readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const run=(bin,args,env)=>new Promise(resolve=>{const child=execFile(bin,args,{env,timeout:30000},(e,stdout,stderr)=>resolve({pid:child.pid,code:e?.code??0,signal:e?.signal??null,stdout,stderr}));});
const scenarios=[
 {name:'custom missing HOME',target:'db-target'},
 {name:'custom beats HOME sentinel',target:'db-target',sentinel:true},
 {name:'ENV overrides DB',target:'env-target',envTarget:true},
 {name:'no target',target:null},
 {name:'HOME fallback',target:'db-target',fallback:true},
 {name:'message exit23 preserves completion',target:'db-target',exit23:true},
 {name:'failed node still notifies',target:'db-target',agentFail:true}
];
if(process.env.NOTIFY_SCENARIO){
 const c=JSON.parse(process.env.NOTIFY_SCENARIO),out=process.env.NOTIFY_CASE_DIR;
 const svc=await import(pathToFileURL(join(source,'orchestrator/src/service.mjs')).href);
 try {
 const project=svc.createProject({name:'Controlled notify project',slug:'notify-project'});
 const workspace=join(project.dir,'agents','alpha');mkdirSync(workspace,{recursive:true});
 svc.db().prepare('INSERT INTO agents (id,project_id,name,model,role_prompt,workspace,openclaw_agent_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('agt_alpha',project.id,'alpha','fixture/model','controlled role',workspace,'fixture-alpha','active','fixture','fixture');
 if(c.target)svc.setSetting('notify_target','db-target');
 const wf=svc.createWorkflow({project:project.id,name:'Controlled notify workflow',spec:{stages:[{name:'controlled-stage',nodes:[{title:'controlled-node',input:'CONTROLLED_REQUEST',agent:'agt_alpha'}]}]}});
 const result=await svc.runWorkflow(wf.id);
 const snapshot=Object.fromEntries(['projects','agents','conversations','workflows','tasks','executions','events','settings'].map(n=>[n,svc.db().prepare(`SELECT * FROM ${n}`).all()]));
 save(join(out,'result.json'),result);save(join(out,'sqlite.json'),snapshot);
 } finally {svc.db().close();}
} else test('notification uses configured CLI without changing workflow or target semantics',async t=>{
 assert(Number(process.versions.node.split('.')[0])>=24);assert(isAbsolute(source));
 const evidence=process.env.NOTIFY_PATH_EVIDENCE;
 if(evidence){assert(isAbsolute(evidence));assert(!existsSync(evidence));mkdirSync(evidence);}
 const out=evidence || mkdtempSync(join(tmpdir(),'notify-path-'));
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
 if(c.sentinel||c.fallback){mkdirSync(dirname(homeCli),{recursive:true});writeFileSync(homeCli,c.fallback?readFileSync(cli):sentinelCode,{mode:0o700});}
 const env={HOME:home,TMPDIR:tmp+'/',JARVIS_HOME:jarvis,JARVIS_DB:join(jarvis,'state.db'),PATH:bin,CLAUDE_BIN:join(bin,'claude'),JARVIS_DOCKER_BIN:join(bin,'docker'),JARVIS_AUTH_HELPER:join(bin,'security'),JARVIS_AUTH_SIGNER:join(bin,'security'),NOTIFY_PATH_SOURCE:source,NOTIFY_SCENARIO:JSON.stringify(c),NOTIFY_CASE_DIR:dir};
 if(!c.fallback)env.OPENCLAW_BIN=cli;if(c.envTarget)env.JARVIS_NOTIFY_TARGET='env-target';
 save(join(dir,'command.json'),{bin:process.execPath,argv:[file],env,scenario:c});
 const observed=await run(process.execPath,[file],env);save(join(dir,'os.json'),observed);
 try {
 assert.equal(observed.code,0,observed.stderr);
 const result=JSON.parse(readFileSync(join(dir,'result.json'))),db=JSON.parse(readFileSync(join(dir,'sqlite.json')));
 const calls=rows(log),starts=calls.filter(x=>x.event==='start'),messages=starts.filter(x=>x.argv[2]==='message');
 assert.equal(starts.filter(x=>x.argv[2]==='agent').length,1);
 const events=db.events.filter(x=>x.kind==='notify.sent');
 assert.equal(db.workflows[0].status,c.agentFail?'failed':'done');
 assert.equal(db.tasks[0].status,c.agentFail?'retry_pending':'done');
 assert.equal(db.executions[0].status,c.agentFail?'failed':'ok');
 assert.equal(result.ok,!c.agentFail);
 if(c.agentFail){assert.equal(result.blocked,'stage_failed');assert.equal(result.results[0].ok,false);assert(!('notified' in result));}
 if(!c.target){assert.equal(messages.length,0);assert.equal(events.length,0);assert.deepEqual(result.notified,{sent:false,reason:'notify_target 未配置'});}
 else {
 assert.equal(messages.length,1,'configured CLI must receive real message send');
 const a=messages[0].argv;assert.equal(a[1],c.fallback?homeCli:cli);
 assert.deepEqual(a.slice(2,9),['message','send','--channel','feishu','--target',c.target,'-m']);
 if(c.agentFail){assert.match(a[9],/Controlled notify workflow/);assert.match(a[9],/controlled-stage.*失败/);}
 else assert.equal(a[9],'JARVIS 工作流「Controlled notify workflow」已完成（项目 notify-project）\n- controlled-node: 完成');
 assert.equal(events.length,1);assert.equal(JSON.parse(events[0].payload).ok,!c.exit23);
 if(!c.agentFail)assert.equal(result.notified.sent,!c.exit23);
 const exit=calls.find(x=>x.pid===messages[0].pid && x.event==='exit');assert.equal(exit.code,c.exit23?23:0);
 const output=calls.find(x=>x.pid===messages[0].pid && x.event==='output');assert.match(output.stdout,/CONTROLLED_NOTIFICATION_NOT_SENT/);
 }
 assert.equal(readFileSync(sentinel,'utf8'),'');
 if(c.exit23){const probe=await run(cli,['message','send','--channel','feishu','--target','controlled-probe','-m','CONTROLLED_NOTIFICATION_NOT_SENT'],env);save(join(dir,'message-os.json'),probe);assert.equal(probe.code,23);assert.match(probe.stdout,/success/);}
 } finally {
 const live=[];for(const x of rows(log).filter(x=>x.event==='start')){try{process.kill(x.pid,0);live.push(x.pid);}catch(e){assert.equal(e.code,'ESRCH');}}
 save(join(dir,'cleanup.json'),{pids:rows(log).filter(x=>x.event==='start').map(x=>x.pid),live});assert.deepEqual(live,[]);
 }
 });
 t.diagnostic('evidence: '+out);
});
