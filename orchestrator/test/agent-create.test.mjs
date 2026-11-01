import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = process.env.AGENT_CREATE_SOURCE || fileURLToPath(new URL('../../', import.meta.url));
const evidence = process.env.AGENT_CREATE_EVIDENCE ? resolve(process.env.AGENT_CREATE_EVIDENCE) : mkdtempSync(join(tmpdir(), 'agent-create-'));
if (process.env.AGENT_CREATE_EVIDENCE) mkdirSync(evidence);
const save = (p, value) => writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
const original = { ...process.env };
const home = join(evidence, 'home'), bin = join(evidence, 'bin'), jarvis = join(evidence, 'jarvis');
for (const p of [home, bin, jarvis]) mkdirSync(p);
const log = join(evidence, 'cli.jsonl'), state = join(evidence, 'remote.json'), modeFile = join(evidence, 'mode');
const sentinel = join(evidence, 'sentinel.jsonl');
writeFileSync(log, ''); writeFileSync(sentinel, '');
const cli = join(bin, 'controlled-openclaw');
// A supervisor observes the worker's actual OS exit, then forwards its output and
// terminates itself with the same signal. No production functions are replaced.
writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const record = x => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(x)+'\\n');
if (!process.env.CONTROLLED_WORKER) {
 const r = spawnSync(process.execPath, [__filename, ...args], {env:{...process.env, CONTROLLED_WORKER:'1'}, encoding:'utf8'});
 record({event:'os-wait', supervisorPid:process.pid, pid:r.pid, argv:args, status:r.status, signal:r.signal, stdout:r.stdout, stderr:r.stderr, error:r.error?.message});
 fs.writeSync(1,r.stdout || ''); fs.writeSync(2,r.stderr || '');
 if(r.signal) process.kill(process.pid,r.signal); else process.exit(r.status ?? 99);
} else {
 record({event:'start',pid:process.pid,argv:process.argv});
 const mode=fs.readFileSync(${JSON.stringify(modeFile)},'utf8');
 if(JSON.stringify(args)===JSON.stringify(['models','list','--json'])) { console.log(JSON.stringify([{key:'fixture/model'}])); process.exit(0); }
 // agents add has nine arguments; require the entire protocol.
 if(args.length===9 && args[0]==='agents' && args[1]==='add' && args[3]==='--model' && args[4]==='fixture/model' && args[5]==='--workspace' && args[7]==='--non-interactive' && args[8]==='--json') {
  if(mode.startsWith('reuse')) {fs.writeSync(2,'already exists');process.exit(17);}
  fs.writeSync(1,mode==='invalid'?'{invalid}':JSON.stringify(mode==='missing'?{}:{agentId:args[2]}));
  if(mode==='nonzero')process.exit(23);
  if(mode==='signal')process.kill(process.pid,'SIGTERM');
  process.exit(0);
 }
 if(args.length===4 && args[0]==='config' && args[1]==='set' && /^agents\\.entries\\.jv-create-case-[a-z]+\\.(model|workspace)$/.test(args[2])) {
  const key=args[2].endsWith('.model')?'model':'workspace';
  if((mode==='reuse-model' && key==='model') || (mode==='reuse-workspace' && key==='workspace')) {fs.writeSync(2,'controlled '+key+' failure');process.exit(key==='model'?31:32);}
  const s=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8'));s[key]=args[3];fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(s));process.exit(0);
 }
 fs.appendFileSync(${JSON.stringify(sentinel)},JSON.stringify(args)+'\\n');process.exit(97);
}
`, { mode: 0o700 });
for (const name of ['openclaw','docker','claude','security','git','sh','bash','curl','wget']) writeFileSync(join(bin,name), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(sentinel)}, JSON.stringify(process.argv)+'\\n');process.exit(97);\n`, {mode:0o700});
const env = {HOME:home,TMPDIR:evidence+'/',PATH:bin,JARVIS_HOME:jarvis,JARVIS_DB:join(jarvis,'state.db'),OPENCLAW_BIN:cli,CLAUDE_BIN:join(bin,'claude'),JARVIS_DOCKER_BIN:join(bin,'docker'),JARVIS_AUTH_HELPER:join(bin,'security'),JARVIS_AUTH_SIGNER:join(bin,'security')};
for (const k of Object.keys(process.env)) if(k !== 'NODE_TEST_CONTEXT') delete process.env[k];
Object.assign(process.env, env);
const svc = await import(pathToFileURL(join(source,'orchestrator/src/service.mjs')));
const project = svc.createProject({name:'Create fixture',slug:'create'});
const snapshot = () => Object.fromEntries(['agents','events'].map(n=>[n,svc.db().prepare(`SELECT * FROM ${n}`).all()]));
save(join(evidence,'invocation.json'), {source,env,argv:process.argv,pid:process.pid,node:process.version});
for (const mode of ['nonzero','signal','reuse-model','reuse-workspace','ok','reuse-ok','invalid','missing']) test(`service createAgent ${mode}`, async () => {
 const name='case-'+mode.replaceAll('-','');
 writeFileSync(modeFile,mode);save(state,{model:'old-model',workspace:'old-workspace'});
 const before=snapshot(), offset=readFileSync(log,'utf8').length;
 let result, error;
 try { result=await svc.createAgent({project:project.id,name,model:'fixture/model',role:'fixture role'}); } catch(e) {error=e.message;}
 const after=snapshot(), calls=readFileSync(log,'utf8').slice(offset).trim().split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.event==='os-wait');
 const remote=JSON.parse(readFileSync(state,'utf8'));
 save(join(evidence,mode+'.json'),{before,after,result,error,calls,remote});
 const workspace=join(project.dir,'agents',name), id='jv-create-'+name;
 assert.deepEqual(calls[0].argv,['models','list','--json']);
 assert.deepEqual(calls[1].argv,['agents','add',id,'--model','fixture/model','--workspace',workspace,'--non-interactive','--json']);
 assert(calls.every(x=>Number.isInteger(x.pid) && x.pid>0));
 assert.equal(calls[1].status,mode==='nonzero'?23:mode==='signal'?null:mode.startsWith('reuse')?17:0);
 assert.equal(calls[1].signal,mode==='signal'?'SIGTERM':null);
 if(['nonzero','signal'].includes(mode)) assert.equal(JSON.parse(calls[1].stdout).agentId,id);
 assert.equal(readFileSync(join(workspace,'ROLE.md'),'utf8'),'fixture role');
 const success=['ok','reuse-ok'].includes(mode);
 assert.equal(after.agents.length-before.agents.length,success?1:0,'failed CLI must not register an active agent');
 assert.equal(after.events.filter(x=>x.kind==='agent.created').length-before.events.filter(x=>x.kind==='agent.created').length,success?1:0);
 if(success) {
  assert.equal(error,undefined);assert.equal(result.status,'active');assert.equal(result.project_id,project.id);assert.equal(result.model,'fixture/model');assert.equal(result.workspace,workspace);assert.equal(result.role_prompt,'fixture role');assert.equal(result.openclaw_agent_id,id);
 } else assert(error);
 const configs=calls.slice(2);
 if(mode.startsWith('reuse')) {
  assert.deepEqual(configs[0].argv,['config','set',`agents.entries.${id}.model`,'fixture/model']);
  assert.equal(configs[0].status,mode==='reuse-model'?31:0);
  assert.equal(configs.length,mode==='reuse-model'?1:2,'model failure must short circuit workspace');
  if(mode!=='reuse-model') {assert.deepEqual(configs[1].argv,['config','set',`agents.entries.${id}.workspace`,workspace]);assert.equal(configs[1].status,mode==='reuse-workspace'?32:0);}
  assert.deepEqual(remote,{model:mode==='reuse-model'?'old-model':'fixture/model',workspace:mode==='reuse-ok'?workspace:'old-workspace'});
  if(!success) assert.match(error,/controlled (model|workspace) failure/);
 } else assert.equal(configs.length,0);
 assert.equal(readFileSync(sentinel,'utf8'),'');
});
test.after(()=>{svc.db().close();for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,original);});
