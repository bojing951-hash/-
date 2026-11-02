import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, renameSync, rmSync, existsSync, chmodSync, readFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fileURLToPath, pathToFileURL
} from 'node:url';
const source=process.env.AUDIT_SOURCE || fileURLToPath(new URL('../..',import.meta.url));
const root=mkdtempSync(join(tmpdir(),'audit-create-'));
process.env.JARVIS_HOME=join(root,'jarvis');
process.env.JARVIS_DB=join(root,'state.db');
const svc=await import(pathToFileURL(join(source,'orchestrator/src/service.mjs')));
test('fixed Git audit creation through real MCP stdio',async t=> {
  const p=svc.createProject( {
    name:'audit',slug:'audit-'+Date.now()
  });
  const repo=join(root,'repo');
  mkdirSync(repo);
  svc.db().prepare('UPDATE projects SET dir=? WHERE id=?').run(root,p.id);
  const git=args=> {
    const r=spawnSync('/usr/bin/git',['-C',repo,...args], {
      encoding:'utf8'
    });
    assert.equal(r.status,0,r.stderr);
    return r.stdout.trim();
  };
  git(['init','-q']);
  writeFileSync(join(repo,'contract.md'),'fixed contract\n');
  git(['add','.']);
  git(['-c','user.name=test','-c','user.email=test@local','commit','-qm','fixture']);
  const commit=git(['rev-parse','HEAD']);
  writeFileSync(join(repo,'contract.md'),'mutable');
  const args= {
    project:p.id,title:'audit',repo,commit,contract_commit:commit,contract_path:'contract.md'
  };
  const requests=[ {
    jsonrpc:'2.0',id:1,method:'tools/call',params: {
      name:'audit_create',arguments:args
    }
  }];
  const r=spawnSync(process.execPath,[join(source,'orchestrator/src/mcp.mjs')], {
    input:requests.map(x=>JSON.stringify(x)).join('\n')+'\n',encoding:'utf8',env:process.env
  });
  assert.equal(r.status,0,r.stderr);
  const response=JSON.parse(r.stdout.trim()).result;
  assert.equal(response.isError,undefined,JSON.stringify(response));
  const task=JSON.parse(response.content[0].text);
  assert.equal(task.kind,'audit');
  const cfg=JSON.parse(task.executor_config);
  assert.equal(cfg.contract,'fixed contract\n');
  assert.equal(cfg.scope.task_id,task.id);
  assert.equal(svc.db().prepare('SELECT count(*) n FROM executions').get().n,0);
  assert.equal(svc.db().prepare('SELECT count(*) n FROM execution_resources').get().n,0);
  const rpc=a=> {
    const r=spawnSync(process.execPath,[join(source,'orchestrator/src/mcp.mjs')], {
      input:JSON.stringify( {
        jsonrpc:'2.0',id:1,method:'tools/call',params: {
          name:'audit_create',arguments:a
        }
      })+'\n',encoding:'utf8',env:process.env
    });
    assert.equal(r.status,0,r.stderr);
    return JSON.parse(r.stdout.trim()).result;
  };
  for(const [name,patch] of Object.entries( {
    extra: {
      shell:'x'
    },short: {
      commit:'abc'
    },type: {
      title:5
    },empty: {
      project:''
    },long: {
      title:'x'.repeat(257)
    },absolute: {
      contract_path:'/contract.md'
    },parent: {
      contract_path:'../contract.md'
    },dot: {
      contract_path:'./contract.md'
    },emptySegment: {
      contract_path:'a//b'
    },control: {
      contract_path:'a\nb'
    },missing: {
      contract_path:'none'
    }
  })) await t.test('reject '+name,()=> {
    const n=svc.listTasks().length;
    assert.equal(rpc( {
      ...args,...patch
    }).isError,true);
    assert.equal(svc.listTasks().length,n);
  });
  const blob=git(['rev-parse',commit+':contract.md']);
  await t.test('reject blob as commit',()=>assert.equal(rpc( {
    ...args,commit:blob
  }).isError,true));
  await t.test('core inline contract remains synchronous and rejects caller scope',()=> {
    const x=svc.createTask( {
      project:p.id,title:'inline',kind:'audit',executorConfig: {
        repo,commit,contract:'inline'
      }
    });
    assert.equal(JSON.parse(x.executor_config).contract,'inline');
    assert.throws(()=>svc.createTask( {
      project:p.id,title:'bad',kind:'audit',executorConfig: {
        repo,commit,contract:'x',scope: {
        }
      }
    }));
  });
  await t.test('CLI inline contract uses core snapshot without grant',()=> {
    const r=spawnSync(process.execPath,[join(source,'orchestrator/src/cli.mjs'),'task','create','--project',p.id,'--title','cli','--kind','audit','--repo',repo,'--commit',commit,'--contract','cli inline'], {
      encoding:'utf8',env:process.env
    });
    assert.equal(r.status,0,r.stderr);
    const task=JSON.parse(r.stdout);
    assert.equal(JSON.parse(task.executor_config).scope.task_id,task.id);
    assert.equal(svc.db().prepare('SELECT count(*) n FROM approvals').get().n,0);
  });
  await t.test('missing required field and core contract rejected',()=> {
    const {
      contract_commit,...missing
    }=args;
    assert.equal(rpc(missing).isError,true);
    assert.throws(()=>svc.createTask( {
      project:p.id,title:'no contract',kind:'audit',executorConfig: {
        repo,commit
      }
    }));
  });
  let isolationCalls=0,worktrees=0,models=0;
  const deps= {
    isolation: {
      isolationStatus:async()=> {
        isolationCalls++;
        return {
          available:true
        };
      },egressProxyUrl:async()=> {
        throw new Error('unexpected proxy');
      },runClaudeIsolated:async()=> {
        models++;
      }
    },executor: {
      createWorktree:async()=> {
        worktrees++;
        throw new Error('unexpected worktree');
      },removeWorktree:async()=>( {
        ok:true
      })
    }
  };
  const newTask=()=>svc.createTask( {
    project:p.id,title:'scoped',kind:'audit',executorConfig: {
      repo,commit,contract:'inline'
    }
  });
  const noEffects=()=> {
    assert.equal(worktrees,0);
    assert.equal(models,0);
    assert.equal(svc.db().prepare('SELECT count(*) n FROM executions').get().n,0);
    assert.equal(svc.db().prepare('SELECT count(*) n FROM execution_resources').get().n,0);
  };
  for(const [name,mutate] of Object.entries( {
    contract:c=>( {
      ...c,contract:'drift'
    }),commit:c=>( {
      ...c,commit:'0'.repeat(40)
    }),repo:c=>( {
      ...c,repo:root
    }),scope:c=>( {
      ...c,scope:undefined
    })
  })) await t.test('preflight '+name,async()=> {
    const x=newTask();
    const c=mutate(JSON.parse(x.executor_config));
    svc.updateTask(x.id, {
      executor_config:JSON.stringify(c)
    });
    const r=await svc.runTask(x.id,deps);
    assert.equal(r.ok,false);
    assert.equal(isolationCalls,0);
    noEffects();
  });
  await t.test('project path drift before isolation rejects',async()=> {
    const x=newTask();
    svc.db().prepare('UPDATE projects SET dir=? WHERE id=?').run(repo,p.id);
    try {
      assert.equal((await svc.runTask(x.id,deps)).ok,false);
      noEffects();
    }finally {
      svc.db().prepare('UPDATE projects SET dir=? WHERE id=?').run(root,p.id);
    }
  });
  await t.test('project pause during isolation await rejects',async()=> {
    const x=newTask();
    const local= {
      ...deps,isolation: {
        ...deps.isolation,isolationStatus:async()=> {
          svc.setProjectStatus(p.id,'paused');
          return {
            available:true
          };
        }
      }
    };
    try {
      assert.equal((await svc.runTask(x.id,local)).ok,false);
      noEffects();
    }finally {
      svc.setProjectStatus(p.id,'active');
    }
  });
  for(const status of ['cancelled','pending']) await t.test('isolation await revalidation '+status,async()=> {
    const x=newTask();
    const local= {
      ...deps,isolation: {
        ...deps.isolation,isolationStatus:async()=> {
          if(status==='cancelled')svc.updateTask(x.id, {
            status
          });
          else svc.updateTask(x.id, {
            executor_config:'{}'
          });
          return {
            available:true
          };
        }
      }
    };
    assert.equal((await svc.runTask(x.id,local)).ok,false);
    noEffects();
  });
  await t.test('transaction insertion failure rolls claim back',async()=> {
    const x=newTask();
    svc.db().exec("CREATE TRIGGER fail_audit BEFORE INSERT ON executions BEGIN SELECT RAISE(ABORT,'forced'); END");
    try {
      const failed=await svc.runTask(x.id,deps);
      assert.equal(failed.ok,false);
      assert.match(failed.error,/forced/);
      assert.equal(svc.getTask(x.id).status,'pending');
      assert.equal(svc.getTask(x.id).attempts,0);
      noEffects();
    }finally {
      svc.db().exec('DROP TRIGGER fail_audit');
    }
  });
  await t.test('directory identity drift fails before isolation',async()=> {
    const x=newTask();
    renameSync(repo,repo+'-old');
    mkdirSync(repo);
    try {
      assert.equal((await svc.runTask(x.id,deps)).ok,false);
      noEffects();
    }finally {
      renameSync(repo,repo+'-empty');
      renameSync(repo+'-old',repo);
    }
  });
  await t.test('fixed plan readonly, concurrent claim, guard drift and cleanup',async()=> {
    const ex=await import(pathToFileURL(join(source,'orchestrator/src/executor.mjs')));
    mkdirSync(join(process.env.HOME,'.claude'), {
      recursive:true
    });
    writeFileSync(join(process.env.HOME,'.claude/settings.json'),'{"env":{}}');
    for(const drift of [false,true]) {
      const x=newTask();
      let release,started;
      const held=new Promise(r=>release=r), entered=new Promise(r=>started=r);
      let invocations=0,allowed=0,dest;
      const local= {
        isolation: {
          isolationStatus:async()=>( {
            available:true
          }),egressProxyUrl:async()=>'http://127.0.0.1:9',runClaudeIsolated:async options=> {
            invocations++;
            dest=options.workdir;
            assert.equal(options.mode,'plan');
            assert.equal(options.readOnly,true);
            started();
            await held;
            if(drift)svc.updateTask(x.id, {
              executor_config:'{}'
            });
            if(!options.guard())return {
              ok:false,cancelled:true
            };
            allowed++;
            return {
              ok:true,text:'controlled'
            };
          }
        }
      };
      const first=svc.runTask(x.id,local);
      await Promise.race([entered,first.then(r=> {
        throw new Error('did not enter controlled runner: '+JSON.stringify(r));
      })]);
      assert.equal((await svc.runTask(x.id,local)).ok,false);
      release();
      const result=await first;
      assert.equal(invocations,1);
      assert.equal(allowed,drift?0:1);
      assert.equal(result.ok,!drift);
      assert.equal(existsSync(dest),false);
      assert.equal(svc.db().prepare('SELECT count(*) n FROM executions WHERE task_id=?').get(x.id).n,1);
    }
  });
  await t.test('host hooks suppressed; normal Git positive control',async()=> {
    const ex=await import(pathToFileURL(join(source,'orchestrator/src/executor.mjs'))), marker=join(root,'hook-marker'),hook=join(repo,'.git/hooks/post-checkout');
    writeFileSync(hook,'#!/bin/sh\ntouch '+marker+'\n');
    chmodSync(hook,0o700);
    const positive=join(root,'positive');
    git(['worktree','add','--detach',positive,commit]);
    assert(existsSync(marker));
    git(['worktree','remove','--force',positive]);
    rmSync(marker);
    const dest=join(root,'protected');
    assert.equal((await ex.createWorktree( {
      repo,commit,dest,audit:true
    })).ok,true);
    assert.equal((await ex.worktreeStatus(dest, {
      audit:true
    })).clean,true);
    assert.equal((await ex.removeWorktree( {
      repo,dest,audit:true
    })).ok,true);
    assert.equal(existsSync(marker),false);
  });
  writeFileSync(join(repo,'bad.txt'),Buffer.from([0xff]));
  symlinkSync('contract.md',join(repo,'link'));
  writeFileSync(join(repo,'large'),'x'.repeat(262145));
  git(['add','.']);
  git(['-c','user.name=test','-c','user.email=test@local','commit','-qm','bad blobs']);
  const bad=git(['rev-parse','HEAD']);
  for(const path of ['bad.txt','link','large']) await t.test('illegal blob '+path,()=>assert.equal(rpc( {
    ...args,contract_commit:bad,contract_path:path
  }).isError,true));
  await t.test('effective filter command rejected without running',()=> {
    const marker=join(root,'filter-marker');
    writeFileSync(join(repo,'.gitattributes'),'contract.md filter=test\n');
    git(['add','.gitattributes']);
    git(['-c','user.name=test','-c','user.email=test@local','commit','-qm','filter attrs']);
    const head=git(['rev-parse','HEAD']);
    git(['config','filter.test.smudge','touch '+marker+'; cat']);
    const positive=join(root,'filter-positive');
    git(['worktree','add','--detach',positive,head]);
    assert(existsSync(marker));
    git(['worktree','remove','--force',positive]);
    rmSync(marker);
    try {
      assert.equal(rpc( {
        ...args,commit:head
      }).isError,true);
      assert.equal(existsSync(marker),false);
    }finally {
      git(['config','--unset','filter.test.smudge']);
    }
  });
});

test('independent FAIL regressions use real Git roots, HEAD and cleanup facts', async t => {
  const ex = await import(pathToFileURL(join(source, 'orchestrator/src/executor.mjs')));
  const fixture = join(root, 'fix-regressions');
  mkdirSync(fixture);
  const project = svc.createProject({ name: 'fix', slug: 'fix-' + Date.now() });
  svc.db().prepare('UPDATE projects SET dir=? WHERE id=?').run(fixture, project.id);
  const repo = join(fixture, 'repo');
  mkdirSync(repo);
  const records = [];
  function record(value) {
    records.push(value);
    if (process.env.AUDIT_EVIDENCE) {
      writeFileSync(process.env.AUDIT_EVIDENCE, JSON.stringify(records, null, 2));
    }
  }
  function git(cwd, args) {
    const result = spawnSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8' });
    record({ kind: 'git', cwd, args, exit: result.status, stdout: result.stdout, stderr: result.stderr });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function commitAt(cwd, text) {
    writeFileSync(join(cwd, 'contract.md'), text);
    git(cwd, ['add', '.']);
    git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', text.trim()]);
    return git(cwd, ['rev-parse', 'HEAD']);
  }
  git(repo, ['init', '-q']);
  mkdirSync(join(repo, 'sub'));
  writeFileSync(join(repo, 'sub/contract.md'), 'SUB contract\n');
  writeFileSync(join(repo, 'outside-sub.txt'), 'root scope\n');
  const fixed = commitAt(repo, 'ROOT contract\n');
  const other = commitAt(repo, 'OTHER clean commit\n');
  const args = { project: project.id, title: 'fixed audit', repo, commit: fixed, contract_commit: fixed, contract_path: 'contract.md' };
  function rpc(arguments_) {
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'audit_create', arguments: arguments_ } };
    const result = spawnSync(process.execPath, [join(source, 'orchestrator/src/mcp.mjs')], {
      input: JSON.stringify(request) + '\n', encoding: 'utf8', env: process.env
    });
    record({ kind: 'mcp', request, exit: result.status, stdout: result.stdout, stderr: result.stderr });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim()).result;
  }
  function counts() {
    return Object.fromEntries(['tasks', 'executions', 'execution_resources', 'approvals', 'events'].map(table =>
      [table, svc.db().prepare(`SELECT count(*) n FROM ${table}`).get().n]));
  }
  await t.test('reject subdirectory pretending to be repo through MCP and core', () => {
    const before = counts();
    const response = rpc({ ...args, repo: join(repo, 'sub') });
    record({ name: 'subdirectory', actualRoot: git(join(repo, 'sub'), ['rev-parse', '--show-toplevel']), response, before, after: counts() });
    assert.equal(response.isError, true);
    assert.deepEqual(counts(), before);
    assert.throws(() => svc.createAuditTask({ ...args, repo: join(repo, 'sub') }));
  });
  await t.test('reject external core.worktree through real MCP without database effects', () => {
    const outside = join(root, 'outside-project');
    mkdirSync(outside);
    git(repo, ['config', 'core.worktree', outside]);
    try {
      const before = counts();
      const response = rpc(args);
      record({ name: 'core.worktree', actualRoot: git(repo, ['rev-parse', '--show-toplevel']), response, before, after: counts() });
      assert.equal(response.isError, true);
      assert.deepEqual(counts(), before);
    } finally {
      git(repo, ['config', '--unset', 'core.worktree']);
    }
  });
  await t.test('real independent nested repository binds root contract', () => {
    const nested = join(repo, 'sub', 'nested');
    mkdirSync(nested);
    git(nested, ['init', '-q']);
    const head = commitAt(nested, 'NESTED contract\n');
    const response = rpc({ ...args, repo: nested, commit: head, contract_commit: head });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    const task = JSON.parse(response.content[0].text);
    const cfg = JSON.parse(task.executor_config);
    assert.equal(cfg.contract, 'NESTED contract\n');
    assert.equal(cfg.scope.repository.root.path, git(nested, ['rev-parse', '--show-toplevel']));
  });
  mkdirSync(join(process.env.HOME, '.claude'), { recursive: true });
  writeFileSync(join(process.env.HOME, '.claude/settings.json'), '{"env":{}}');
  for (const scenario of ['head-after', 'head-before', 'head-guard', 'head-read-error', 'cleanup-false', 'cleanup-throw', 'failed-cleanup-false', 'cancel-cleanup-false']) {
    await t.test(scenario, async () => {
      const task = svc.createAuditTask(args);
      let dest;
      let runners = 0;
      let observed;
      const executor = {
        ...ex,
        createWorktree: async options => {
          dest = options.dest;
          const result = await ex.createWorktree(options);
          if (scenario === 'head-before') git(dest, ['reset', '--hard', other]);
          return result;
        },
        removeWorktree: async options => {
          if (scenario.includes('cleanup')) {
            if (scenario === 'cleanup-throw') throw new Error('controlled cleanup throw');
            return { ok: false, out: 'controlled cleanup false' };
          }
          return ex.removeWorktree(options);
        }
      };
      const isolation = {
        isolationStatus: async () => ({ available: true }),
        egressProxyUrl: async () => 'http://127.0.0.1:9',
        runClaudeIsolated: async options => {
          assert.equal(options.mode, 'plan');
          assert.equal(options.readOnly, true);
          if (scenario === 'cancel-cleanup-false') {
            svc.updateTask(task.id, { status: 'cancelled' });
            assert.equal(options.guard(), false);
            return { ok: false, cancelled: true, error: 'controlled cancel' };
          }
          if (scenario === 'head-guard') {
            git(dest, ['reset', '--hard', other]);
            assert.equal(options.guard(), false);
            return { ok: false, cancelled: true };
          }
          assert.equal(options.guard(), true);
          runners++;
          if (scenario === 'head-after') git(dest, ['reset', '--hard', other]);
          observed = git(dest, ['rev-parse', 'HEAD']);
          assert.equal(git(dest, ['status', '--porcelain']), '');
          if (scenario === 'head-read-error') rmSync(join(dest, '.git'));
          return { ok: scenario !== 'failed-cleanup-false', error: scenario === 'failed-cleanup-false' ? 'controlled original failure' : '', text: 'controlled success' };
        }
      };
      let result;
      try {
        result = await svc.runTask(task.id, { executor, isolation });
        const execution = svc.db().prepare('SELECT * FROM executions WHERE task_id=?').get(task.id);
        record({ scenario, fixed, other, observed, runners, result, task: svc.getTask(task.id), execution, remains: existsSync(dest) });
        assert.equal(result.ok, false);
        assert.notEqual(svc.getTask(task.id).status, 'done');
        assert.notEqual(execution.status, 'ok');
        if (['head-before', 'head-guard'].includes(scenario)) assert.equal(runners, 0);
        if (scenario.includes('cleanup')) {
          assert.equal(existsSync(dest), true);
          const evidence = JSON.parse(execution.evidence);
          assert.equal(evidence.cleanup.pending, true);
          assert.equal(evidence.cleanup.path, dest);
          assert.equal(evidence.cleanup.repo, repo);
          assert.match(evidence.cleanup.error, /controlled cleanup/);
          assert.deepEqual(result.evidence.cleanup, evidence.cleanup);
          if (scenario === 'failed-cleanup-false') assert.match(evidence.cleanup.original_reason, /controlled original failure/);
          if (scenario.startsWith('cancel')) assert.match(evidence.cleanup.original_reason, /controlled cancel/);
          assert.equal(svc.getTask(task.id).status, scenario.startsWith('cancel') ? 'cancel_failed' : 'failed');
        } else {
          assert.equal(result.evidence.audit.head.expected, fixed);
          const phase = scenario === 'head-before' ? 'before' : scenario === 'head-guard' ? 'guard' : 'after';
          const check = result.evidence.audit.head[phase];
          if (scenario === 'head-read-error') assert(check.error);
          else assert.equal(check.observed, other);
        }
      } finally {
        // Only the exact temporary worktree created above is eligible for follow-up cleanup.
        if (dest && existsSync(dest)) {
          if (!existsSync(join(dest, '.git'))) {
            const metadata = git(repo, ['rev-parse', '--absolute-git-dir']);
            // Record the exact linked-worktree metadata before removing only this broken scratch path.
            const entries = git(repo, ['worktree', 'list', '--porcelain']);
            record({ scenario, metadata, entries, followup: 'broken pointer retained in scratch' });
            rmSync(dest, { recursive: true, force: true });
            git(repo, ['worktree', 'prune']);
          } else {
            assert.equal((await ex.removeWorktree({ repo, dest, audit: true })).ok, true);
          }
        }
      }
    });
  }
});
