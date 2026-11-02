/**
 * 外部执行器适配层（P1-06）。
 *
 * 首个执行器：Claude Code + 现有 GLM 配置。
 * 安全边界：
 * - 只在指定 cwd 内工作，不传 --add-dir，避免越界访问
 * - 默认 plan（只读）模式；写模式必须显式请求
 * - 不使用 bypassPermissions
 * - 记录真实 exit code / git 版本，不伪造证据
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { safeChildEnv } from './security.mjs';
import { join, relative, isAbsolute } from 'node:path';

const HOME = homedir();

export function claudeBin() {
  const candidates = [
    process.env.CLAUDE_BIN,
    join(HOME, '.nvm/versions/node/v24.13.1/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return 'claude';
}

/**
 * 独立进程组运行，便于整体取消（kill 负 pid）。
 * onPid 回调用于把 pid 落盘，供外部 cancel 使用。
 */
function run(cmd, args, { cwd, timeoutMs = 900_000, onPid }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      detached: true,
      env: safeChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (onPid && child.pid) onPid(child.pid);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    // 超时/取消时的终止升级：SIGTERM → 等待 grace → SIGKILL
    let killSignal = null;
    const terminate = (sig) => {
      killSignal = sig;
      try { process.kill(-child.pid, sig); } catch {
        try { process.kill(child.pid, sig); } catch {}
      }
    };
    const termTimer = setTimeout(() => terminate('SIGTERM'), timeoutMs);
    const killTimer = setTimeout(() => {
      if (killSignal && child.exitCode === null) terminate('SIGKILL');
    }, timeoutMs + 5000);

    const done = (code, signal) => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolve({
        code: code ?? 1,
        signaled: signal != null || killSignal != null,
        killSignal,
        confirmedExit: child.exitCode !== null || child.signalCode !== null,
        stdout,
        stderr
      });
    };
    child.on('close', done);
    child.on('error', (e) => done(1, null));
  });
}

function gitHead(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 15_000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

/**
 * 由编排层代为提交（不使用模型能力）。
 * 只 add 任务声明的路径，避免把无关修改一起提交（AC-05）。
 */
export async function gitCommit({ cwd, message, paths }) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, error: '未声明提交路径' };
  }
  const git = (args) =>
    new Promise((resolve) => {
      execFile('git', ['-C', cwd, ...args], { timeout: 60_000, env: safeChildEnv() }, (e, so, se) =>
        resolve({ code: e?.code ?? 0, out: (so || '') + (se || '') })
      );
    });

  const add = await git(['add', '--', ...paths]);
  if (add.code !== 0) return { ok: false, error: add.out.slice(0, 500) };

  // 只允许提交声明的路径：暂存区出现其它文件则拒绝
  const staged = await git(['diff', '--cached', '--name-only']);
  const stagedFiles = staged.out.split('\n').map((x) => x.trim()).filter(Boolean);
  const outside = stagedFiles.filter((f) => !paths.some((p) => f === p || f.startsWith(p.replace(/\/$/, '') + '/')));
  if (outside.length) {
    await git(['reset']);
    return { ok: false, error: `提交范围外存在改动: ${outside.join(', ')}` };
  }

  const identity = ['-c', 'user.name=JARVIS Executor', '-c', 'user.email=jarvis-executor@localhost'];
  const commit = await git([...identity, 'commit', '-m', message]);
  const head = await new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 15_000 }, (e, so) => resolve(e ? null : so.trim()));
  });
  return { ok: commit.code === 0, sha: head, files: stagedFiles, output: commit.out.slice(-1500) };
}

/**
 * 在指定 commit 上创建只读工作树快照。
 * 审计必须针对固定版本，而不是浮动的 HEAD。
 */
export async function createFrozenWorktree({ repo, commit, dest }) {
  const runGit = (args) =>
    new Promise((resolve) => {
      execFile('git', ['-C', repo, ...args], { timeout: 120_000 }, (e, so, se) =>
        resolve({ code: e?.code ?? 0, out: (so || '') + (se || '') })
      );
    });

  const verify = await runGit(['cat-file', '-e', `${commit}^{commit}`]);
  if (verify.code !== 0) return { ok: false, error: `commit 不存在: ${commit}` };

  const add = await runGit(['worktree', 'add', '--detach', dest, commit]);
  if (add.code !== 0) return { ok: false, error: add.out.slice(0, 400) };

  const head = await new Promise((resolve) => {
    execFile('git', ['-C', dest, 'rev-parse', 'HEAD'], { timeout: 15_000 }, (e, so) => resolve(e ? null : so.trim()));
  });
  return { ok: true, path: dest, sha: head };
}

export async function removeFrozenWorktree({ repo, dest }) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, 'worktree', 'remove', '--force', dest], { timeout: 60_000 }, (e, so, se) =>
      resolve({ ok: !e, out: (so || '') + (se || '') })
    );
  });
}

/* ------------------------------ 隔离工作树（DEF-07） ----------------------- */

/** 从固定 commit 创建一次性工作树；不触碰用户工作目录。 */
export async function createWorktree({ repo, commit, dest, audit = false }) {
  if (audit) {
    try { auditGit(repo,['worktree','add','--detach',dest,commit]); const sha=auditGit(dest,['rev-parse','HEAD']); if(sha!==commit.toLowerCase()) throw new Error('工作树 HEAD 校验失败'); return {ok:true,path:dest,sha}; } catch(e) { return {ok:false,error:e.message}; }
  }
  const git = (args, cwd = repo) =>
    new Promise((resolve) => {
      execFile('git', ['-C', cwd, ...args], { timeout: 120_000, env: safeChildEnv() }, (e, so, se) =>
        resolve({ code: e?.code ?? 0, out: (so || '') + (se || '') })
      );
    });

  if (typeof commit !== 'string' || !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(commit)) {
    return { ok: false, error: '需要完整的 Commit 对象 ID' };
  }
  const exists = await git(['cat-file', '-t', commit]);
  if (exists.code !== 0 || exists.out.trim() !== 'commit') {
    return { ok: false, error: `commit 不存在或对象类型错误: ${commit}` };
  }

  const add = await git(['worktree', 'add', '--detach', dest, commit]);
  if (add.code !== 0) return { ok: false, error: add.out.slice(0, 400) };

  const head = await git(['rev-parse', 'HEAD'], dest);
  if (head.code !== 0 || head.out.trim() !== commit.toLowerCase()) {
    const cleanup = await removeWorktree({ repo, dest });
    return { ok: false, error: `工作树 HEAD 校验失败${cleanup.ok ? '' : ': 清理失败 ' + cleanup.out.slice(0, 400)}` };
  }
  return { ok: true, path: dest, sha: head.out.trim() };
}

/** 工作树状态：初始必须干净（AC-15）。 */
export async function worktreeStatus(dir, { audit = false } = {}) {
  if (audit) { try { const raw=auditGit(dir,['status','--porcelain']); return {clean:!raw,raw}; } catch(e) { return {clean:false,raw:e.message}; } }
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'status', '--porcelain'], { timeout: 30_000 }, (e, so) =>
      resolve({ clean: !e && (so || '').trim() === '', raw: (so || '').trim() })
    );
  });
}

/** 解析工作树改动文件（porcelain 前两列状态 + 分隔空白）。 */
export async function changedFiles(dir) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'status', '--porcelain'], { timeout: 30_000 }, (e, so) => {
      const files = (so || '')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => l.replace(/^..\s+/, '').trim())
        .filter(Boolean);
      resolve(files);
    });
  });
}

/**
 * 把工作树里的新 commit 固定到仓库的一个 ref 上。
 * 不修改用户当前分支；detach 工作树删除后 commit 仍可达、可核对。
 */
export async function publishRef({ repo, ref, sha }) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, 'update-ref', ref, sha], { timeout: 30_000 }, (e, so, se) =>
      resolve({ ok: !e, ref, sha, out: (so || '') + (se || '') })
    );
  });
}

/** 读取引用指向的 SHA（用于确认发布是否真的可用）。 */
export async function revParseRef({ repo, ref }) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, 'rev-parse', ref], { timeout: 20_000 }, (e, so) => resolve(e ? null : so.trim()));
  });
}

export async function removeWorktree({ repo, dest, audit = false }) {
  if(audit) { try { return {ok:true,out:auditGit(repo,['worktree','remove','--force',dest])}; } catch(e) {return {ok:false,out:e.message};} }
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, 'worktree', 'remove', '--force', dest], { timeout: 60_000 }, (e, so, se) =>
      resolve({ ok: !e, out: (so || '') + (se || '') })
    );
  });
}

/** 执行器能力自检（不消耗额度）。 */
export async function executorStatus() {
  const r = await run(claudeBin(), ['--version'], { cwd: HOME, timeoutMs: 30_000 });
  return { bin: claudeBin(), version: (r.stdout || r.stderr).trim(), ok: r.code === 0 };
}


// Audit host Git operations have a separate, bounded policy. Ordinary executors
// retain their existing environment and behavior.
const auditFlags = ['--no-replace-objects', '--no-lazy-fetch', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
export function auditGit(repo, args, binary = false) {
  const data = execFileSync('/usr/bin/git', [...auditFlags, '-C', repo, ...args], {
    timeout: 15000, maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return binary ? data : new TextDecoder('utf-8', { fatal: true, ignoreBOM:true }).decode(data).trim();
}
function auditWithin(path, root) {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('审计路径不在项目范围内');
}
export function auditRepository(repo, projectDir, commit) {
  if (typeof commit !== 'string' || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(commit)) throw new Error('需要完整 Commit ID');
  const project = realpathSync(projectDir), cwd = realpathSync(isAbsolute(repo) ? repo : join(project, repo));
  auditWithin(cwd, project);
  const gitdir = realpathSync(auditGit(cwd, ['rev-parse', '--absolute-git-dir']));
  const common = realpathSync(auditGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  auditWithin(gitdir, project); auditWithin(common, project);
  // A configured process/smudge/clean command can execute on the host at checkout.
  let filters;
  try { filters = auditGit(cwd, ['config', '--get-regexp', '^filter\\..*\\.(process|smudge|clean)$']); }
  catch (e) { if (e.status !== 1) throw e; filters = ''; }
  if (filters) throw new Error('审计仓库存在外部 filter 配置');
  if (auditGit(cwd, ['cat-file', '-t', commit]) !== 'commit') throw new Error('对象不是 commit');
  const identity = path => { const st=statSync(path); if (!st.isDirectory()) throw new Error('需要目录'); return { path, dev:st.dev, ino:st.ino }; };
  return { project:identity(project), repo:identity(cwd), gitdir:identity(gitdir), common:identity(common), commit:commit.toLowerCase() };
}
export function auditContract(repo, commit, path) {
  if (typeof path !== 'string' || Buffer.byteLength(path)>4096 || path.includes('\\') || /[\x00-\x20\x7f]/.test(path) || path.split('/').some(x=>!x || x==='.' || x==='..') || isAbsolute(path)) throw new Error('非法契约路径');
  if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(commit) || auditGit(repo,['cat-file','-t',commit])!=='commit') throw new Error('契约来源必须是完整 commit');
  const entry = auditGit(repo,['ls-tree','-z',commit,'--',path],true).toString('utf8');
  const match=/^(100644|100755) blob ([a-f0-9]+)\t([^\0]+)\0$/.exec(entry);
  if (!match || match[3]!==path) throw new Error('契约必须是普通 blob');
  const size=Number(auditGit(repo,['cat-file','-s',match[2]]));
  if (size>262144) throw new Error('契约超限');
  const bytes=auditGit(repo,['cat-file','blob',match[2]],true);
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  if (!text.trim()) throw new Error('契约不能为空');
  return { text, source:{ commit:commit.toLowerCase(), path, blob:match[2] } };
}
