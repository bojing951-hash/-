/**
 * 模型代理令牌生命周期与代理拒绝路径。
 * 不依赖 Docker：代理是独立 Node 进程，用临时端口和临时密钥文件启动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-proxy-'));
process.env.HOME = tmp;
process.env.JARVIS_HOME = tmp;
process.env.JARVIS_DB = join(tmp, 'state.db');

const svc = await import('../src/service.mjs');

const tokenFile = join(tmp, 'proxy', 'active-tokens.json');
const readTokens = () => JSON.parse(readFileSync(tokenFile, 'utf8'));
const future = () => new Date(Date.now() + 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

function seedExecution(id, taskId) {
  svc.db()
    .prepare('INSERT INTO executions (id,task_id,status,started_at) VALUES (?,?,?,?)')
    .run(id, taskId, 'running', new Date().toISOString());
}

test('模型令牌：按 Execution 撤销，取消后其他执行令牌不受影响', () => {
  const p = svc.createProject({ name: '代理令牌', slug: 'proxy-token' });
  const t = svc.createTask({ project: p.id, title: 'token', input: 'x' });
  seedExecution('exe_a', t.id);
  seedExecution('exe_b', t.id);

  const a = svc.registerModelToken('exe_a', t.id);
  const b = svc.registerModelToken('exe_b', t.id);
  let tokens = readTokens();
  assert.equal(tokens[a].execution_id, 'exe_a');
  assert.equal(tokens[b].execution_id, 'exe_b');

  assert.equal(svc.revokeModelTokensForExecution('exe_a'), 1);
  tokens = readTokens();
  assert.equal(tokens[a], undefined);
  assert.equal(tokens[b].execution_id, 'exe_b');

  svc.revokeModelToken(b);
  assert.deepEqual(readTokens(), {});
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function startProxy(tokens) {
  const port = await freePort();
  const keyFile = join(tmp, 'glm.key');
  const tokFile = join(tmp, 'model-tokens.json');
  writeFileSync(keyFile, 'sk-test-proxy-key-not-real');
  writeFileSync(tokFile, JSON.stringify(tokens));
  const child = spawn(process.execPath, ['orchestrator/docker/egress-proxy.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PROXY_PORT: String(port),
      GLM_KEY_FILE: keyFile,
      MODEL_TOKENS_FILE: tokFile,
      MODEL_UPSTREAM_HOST: '127.0.0.1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let closed = false;
  let stopPromise;
  let pending = '';
  let readySettled = false;
  let readyTimer;
  let resolveReady;
  let rejectReady;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const finishReady = (error) => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimer);
    pending = '';
    child.stderr.off('data', onData);
    child.stderr.resume();
    if (error) rejectReady(error);
    else resolveReady();
  };
  const onError = () => finishReady(new Error('PROXY_CHILD_ERROR'));
  const onPipeError = () => finishReady(new Error('PROXY_PIPE_ERROR'));
  const onClose = () => {
    closed = true;
    finishReady(new Error('PROXY_CLOSED_BEFORE_READY'));
    child.off('error', onError);
    child.off('close', onClose);
    child.stdout.off('error', onPipeError);
    child.stderr.off('error', onPipeError);
    resolveClosed();
  };
  const onData = (chunk) => {
    for (const part of chunk.split(/(?<=\n)/)) {
      if (pending.length + part.length > 8192) {
        finishReady(new Error('PROXY_READY_BUFFER_LIMIT'));
        return;
      }
      pending += part;
      if (!pending.endsWith('\n')) continue;
      const line = pending;
      pending = '';
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event && !Array.isArray(event) && typeof event === 'object' &&
          Object.keys(event).sort().join(',') === 'class,kind' &&
          event.kind === 'EGRESS_PROXY_EVENT' && event.class === 'LISTENING') {
        finishReady();
        return;
      }
    }
  };
  child.on('error', onError);
  child.on('close', onClose);
  child.stdout.on('error', onPipeError);
  child.stderr.on('error', onPipeError);
  child.stdout.resume();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', onData);
  readyTimer = setTimeout(() => finishReady(new Error('PROXY_START_TIMEOUT')), 8000);
  const waitClosed = async (milliseconds) => {
    if (closed) return true;
    let timer;
    try {
      return await Promise.race([
        closedPromise.then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const stop = () => {
    if (!stopPromise) stopPromise = (async () => {
      clearTimeout(readyTimer);
      child.stderr.off('data', onData);
      pending = '';
      child.stdout.resume();
      child.stderr.resume();
      if (closed) return;
      try { child.kill('SIGTERM'); } catch { /* Actual close is still required. */ }
      if (await waitClosed(1000)) return;
      try { child.kill('SIGKILL'); } catch { /* Never infer exit from a signal. */ }
      if (!await waitClosed(1000)) throw new Error('PROXY_CLEANUP_UNCONFIRMED');
    })();
    return stopPromise;
  };
  try {
    await ready;
    return { port, child, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

test('模型代理：无令牌/过期/已撤销 401，有效令牌才进入上游', async () => {
  const validA = 'a'.repeat(24);
  const validB = 'b'.repeat(24);
  const expired = 'c'.repeat(24);
  const proxy = await startProxy({
    [validA]: { execution_id: 'exe_a', task_id: 'tsk_a', expires_at: future() },
    [expired]: { execution_id: 'exe_c', task_id: 'tsk_c', expires_at: past() }
  });
  try {
    const base = `http://127.0.0.1:${proxy.port}/api/anthropic`;
    const noToken = await fetch(`${base}/v1/messages`, { signal: AbortSignal.timeout(5000) });
    assert.equal(noToken.status, 401, '无令牌必须拒绝');

    const expiredRes = await fetch(`${base}/s/${expired}/v1/messages`, { signal: AbortSignal.timeout(5000) });
    assert.equal(expiredRes.status, 401, '过期令牌必须拒绝');

    const revokedRes = await fetch(`${base}/s/${validB}/v1/messages`, { signal: AbortSignal.timeout(5000) });
    assert.equal(revokedRes.status, 401, '未签发的令牌必须拒绝');

    // 有效令牌会通过授权检查，然后因为测试上游 127.0.0.1:443 不可达而返回 502。
    const validRes = await fetch(`${base}/s/${validA}/v1/messages`, { signal: AbortSignal.timeout(5000) });
    assert.equal(validRes.status, 502, '有效令牌必须通过 401 检查');
  } finally {
    await proxy.stop();
  }
});
