import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, renameSync, rmSync, existsSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const source=process.env.AUDIT_SOURCE || fileURLToPath(new URL('../..',import.meta.url));
const root=mkdtempSync(join(tmpdir(),'audit-create-'));
process.env.JARVIS_HOME=join(root,'jarvis');process.env.JARVIS_DB=join(root,'state.db');
const svc=await import(pathToFileURL(join(source,'orchestrator/src/service.mjs')));
test('fixed Git audit creation through real MCP stdio',async t=>{
 const p=svc.createProject({name:'audit',slug:'audit-'+Date.now()});
 const repo=join(root,'repo');mkdirSync(repo);svc.db().prepare('UPDATE projects SET dir=? WHERE id=?').run(root,p.id);
 const git=args=>{const r=spawnSync('/usr/bin/git',['-C',repo,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 git(['init','-q']);writeFileSync(join(repo,'contract.md'),'fixed contract\n');git(['add','.']);git(['-c','user.name=test','-c','user.email=test@local','commit','-qm','fixture']);const commit=git(['rev-parse','HEAD']);
 writeFileSync(join(repo,'contract.md'),'mutable');
 const args={project:p.id,title:'audit',repo,commit,contract_commit:commit,contract_path:'contract.md'};
 const requests=[{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'audit_create',arguments:args}}];
 const r=spawnSync(process.execPath,[join(source,'orchestrator/src/mcp.mjs')],{input:requests.map(x=>JSON.stringify(x)).join('\n')+'\n',encoding:'utf8',env:process.env});assert.equal(r.status,0,r.stderr);
 const response=JSON.parse(r.stdout.trim()).result;assert.equal(response.isError,undefined,JSON.stringify(response));
 const task=JSON.parse(response.content[0].text);assert.equal(task.kind,'audit');const cfg=JSON.parse(task.executor_config);assert.equal(cfg.contract,'fixed contract\n');assert.equal(cfg.scope.task_id,task.id);
 assert.equal(svc.db().prepare('SELECT count(*) n FROM executions').get().n,0);
 assert.equal(svc.db().prepare('SELECT count(*) n FROM execution_resources').get().n,0);
 const rpc=a=>{const r=spawnSync(process.execPath,[join(source,'orchestrator/src/mcp.mjs')],{input:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'audit_create',arguments:a}})+'\n',encoding:'utf8',env:process.env});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim()).result;};
 for(const [name,patch] of Object.entries({extra:{shell:'x'},short:{commit:'abc'},type:{title:5},empty:{project:''},long:{title:'x'.repeat(257)},absolute:{contract_path:'/contract.md'},parent:{contract_path:'../contract.md'},dot:{contract_path:'./contract.md'},emptySegment:{contract_path:'a//b'},control:{contract_path:'a\nb'},missing:{contract_path:'none'}})) await t.test('reject '+name,()=>{const n=svc.listTasks().length;assert.equal(rpc({...args,...patch}).isError,true);assert.equal(svc.listTasks().length,n);});
 const blob=git(['rev-parse',commit+':contract.md']);
 await t.test('reject blob as commit',()=>assert.equal(rpc({...args,commit:blob}).isError,true));
 await t.test('core inline contract remains synchronous and rejects caller scope',()=>{const x=svc.createTask({project:p.id,title:'inline',kind:'audit',executorConfig:{repo,commit,contract:'inline'}});assert.equal(JSON.parse(x.executor_config).contract,'inline');assert.throws(()=>svc.createTask({project:p.id,title:'bad',kind:'audit',executorConfig:{repo,commit,contract:'x',scope:{}}}));});
 await t.test('CLI inline contract uses core snapshot without grant',()=>{
  const r=spawnSync(process.execPath,[join(source,'orchestrator/src/cli.mjs'),'task','create','--project',p.id,'--title','cli','--kind','audit','--repo',repo,'--commit',commit,'--contract','cli inline'],{encoding:'utf8',env:process.env});assert.equal(r.status,0,r.stderr);const task=JSON.parse(r.stdout);assert.equal(JSON.parse(task.executor_config).scope.task_id,task.id);
  assert.equal(svc.db().prepare('SELECT count(*) n FROM approvals').get().n,0);
 });
 await t.test('missing required field and core contract rejected',()=>{const {contract_commit,...missing}=args;assert.equal(rpc(missing).isError,true);assert.throws(()=>svc.createTask({project:p.id,title:'no contract',kind:'audit',executorConfig:{repo,commit}}));});
 let isolationCalls=0,worktrees=0,models=0;
 const deps={isolation:{isolationStatus:async()=>{isolationCalls++;return {available:true};},egressProxyUrl:async()=>{throw new Error('unexpected proxy');},runClaudeIsolated:async()=>{models++;}},executor:{createWorktree:async()=>{worktrees++;throw new Error('unexpected worktree');},removeWorktree:async()=>({ok:true})}};
 const newTask=()=>svc.createTask({project:p.id,title:'scoped',kind:'audit',executorConfig:{repo,commit,contract:'inline'}});
 const noEffects=()=>{assert.equal(worktrees,0);assert.equal(models,0);assert.equal(svc.db().prepare('SELECT count(*) n FROM executions').get().n,0);assert.equal(svc.db().prepare('SELECT count(*) n FROM execution_resources').get().n,0);};
 for(const [name,mutate] of Object.entries({contract:c=>({...c,contract:'drift'}),commit:c=>({...c,commit:'0'.repeat(40)}),repo:c=>({...c,repo:root}),scope:c=>({...c,scope:undefined})})) await t.test('preflight '+name,async()=>{const x=newTask();const c=mutate(JSON.parse(x.executor_config));svc.updateTask(x.id,{executor_config:JSON.stringify(c)});const r=await svc.runTask(x.id,deps);assert.equal(r.ok,false);assert.equal(isolationCalls,0);noEffects();});
 await t.test('project path drift before isolation rejects',async()=>{const x=newTask();svc.db().prepare('UPDATE projects SET dir=? WHERE id=?').run(repo,p.id);try{assert.equal((await svc.runTask(x.id,deps)).ok,false);noEffects();}finally{svc.db().prepare('UPDATE projects SET dir=? WHERE id=?').run(root,p.id);}});
 await t.test('project pause during isolation await rejects',async()=>{const x=newTask();const local={...deps,isolation:{...deps.isolation,isolationStatus:async()=>{svc.setProjectStatus(p.id,'paused');return {available:true};}}};try{assert.equal((await svc.runTask(x.id,local)).ok,false);noEffects();}finally{svc.setProjectStatus(p.id,'active');}});
 for(const status of ['cancelled','pending']) await t.test('isolation await revalidation '+status,async()=>{const x=newTask();const local={...deps,isolation:{...deps.isolation,isolationStatus:async()=>{if(status==='cancelled')svc.updateTask(x.id,{status});else svc.updateTask(x.id,{executor_config:'{}'});return {available:true};}}};assert.equal((await svc.runTask(x.id,local)).ok,false);noEffects();});
 await t.test('transaction insertion failure rolls claim back',async()=>{const x=newTask();svc.db().exec("CREATE TRIGGER fail_audit BEFORE INSERT ON executions BEGIN SELECT RAISE(ABORT,'forced'); END");try {const failed=await svc.runTask(x.id,deps);assert.equal(failed.ok,false);assert.match(failed.error,/forced/);assert.equal(svc.getTask(x.id).status,'pending');assert.equal(svc.getTask(x.id).attempts,0);noEffects();}finally{svc.db().exec('DROP TRIGGER fail_audit');}});
 await t.test('directory identity drift fails before isolation',async()=>{const x=newTask();renameSync(repo,repo+'-old');mkdirSync(repo);try{assert.equal((await svc.runTask(x.id,deps)).ok,false);noEffects();}finally{renameSync(repo,repo+'-empty');renameSync(repo+'-old',repo);}});
 await t.test('fixed plan readonly, concurrent claim, guard drift and cleanup',async()=>{
  const ex=await import(pathToFileURL(join(source,'orchestrator/src/executor.mjs')));
  mkdirSync(join(process.env.HOME,'.claude'),{recursive:true});writeFileSync(join(process.env.HOME,'.claude/settings.json'),'{"env":{}}');
  for(const drift of [false,true]) {
   const x=newTask();let release,started;const held=new Promise(r=>release=r), entered=new Promise(r=>started=r);let invocations=0,allowed=0,dest;
   const local={isolation:{isolationStatus:async()=>({available:true}),egressProxyUrl:async()=>'http://127.0.0.1:9',runClaudeIsolated:async options=>{invocations++;dest=options.workdir;assert.equal(options.mode,'plan');assert.equal(options.readOnly,true);started();await held;if(drift)svc.updateTask(x.id,{executor_config:'{}'});if(!options.guard())return {ok:false,cancelled:true};allowed++;return {ok:true,text:'controlled'};}}};
   const first=svc.runTask(x.id,local);await Promise.race([entered,first.then(r=>{throw new Error('did not enter controlled runner: '+JSON.stringify(r));})]);
   assert.equal((await svc.runTask(x.id,local)).ok,false);release();const result=await first;
   assert.equal(invocations,1);assert.equal(allowed,drift?0:1);assert.equal(result.ok,!drift);assert.equal(existsSync(dest),false);
   assert.equal(svc.db().prepare('SELECT count(*) n FROM executions WHERE task_id=?').get(x.id).n,1);
  }
 });
 await t.test('host hooks suppressed; normal Git positive control',async()=>{
  const ex=await import(pathToFileURL(join(source,'orchestrator/src/executor.mjs'))), marker=join(root,'hook-marker'),hook=join(repo,'.git/hooks/post-checkout');
  writeFileSync(hook,'#!/bin/sh\ntouch '+marker+'\n');chmodSync(hook,0o700);
  const positive=join(root,'positive');git(['worktree','add','--detach',positive,commit]);assert(existsSync(marker));git(['worktree','remove','--force',positive]);
  rmSync(marker);const dest=join(root,'protected');assert.equal((await ex.createWorktree({repo,commit,dest,audit:true})).ok,true);assert.equal((await ex.worktreeStatus(dest,{audit:true})).clean,true);assert.equal((await ex.removeWorktree({repo,dest,audit:true})).ok,true);assert.equal(existsSync(marker),false);
 });
 writeFileSync(join(repo,'bad.txt'),Buffer.from([0xff]));symlinkSync('contract.md',join(repo,'link'));writeFileSync(join(repo,'large'),'x'.repeat(262145));git(['add','.']);git(['-c','user.name=test','-c','user.email=test@local','commit','-qm','bad blobs']);const bad=git(['rev-parse','HEAD']);
 for(const path of ['bad.txt','link','large']) await t.test('illegal blob '+path,()=>assert.equal(rpc({...args,contract_commit:bad,contract_path:path}).isError,true));
 await t.test('effective filter command rejected without running',()=>{
  const marker=join(root,'filter-marker');writeFileSync(join(repo,'.gitattributes'),'contract.md filter=test\n');git(['add','.gitattributes']);git(['-c','user.name=test','-c','user.email=test@local','commit','-qm','filter attrs']);const head=git(['rev-parse','HEAD']);
  git(['config','filter.test.smudge','touch '+marker+'; cat']);
  const positive=join(root,'filter-positive');git(['worktree','add','--detach',positive,head]);assert(existsSync(marker));git(['worktree','remove','--force',positive]);rmSync(marker);
  try{assert.equal(rpc({...args,commit:head}).isError,true);assert.equal(existsSync(marker),false);}finally{git(['config','--unset','filter.test.smudge']);}
 });
});
