import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';

const source = process.env.WORKTREE_STATUS_SOURCE ? resolve(process.env.WORKTREE_STATUS_SOURCE)
  : fileURLToPath(new URL('../../', import.meta.url));
const evidence = process.env.WORKTREE_STATUS_EVIDENCE ? resolve(process.env.WORKTREE_STATUS_EVIDENCE)
  : mkdtempSync(join(tmpdir(), 'worktree-status-'));
if (process.env.WORKTREE_STATUS_EVIDENCE) mkdirSync(evidence);
const { worktreeStatus } = await import(pathToFileURL(join(source, 'orchestrator/src/executor.mjs')));
const env = { PATH: '/usr/bin:/bin', HOME: join(evidence, 'home'), TMPDIR: join(evidence, 'tmp'),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: join(evidence, 'hooks'),
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@invalid' };
for (const name of ['home', 'tmp', 'hooks', 'template', 'repo', 'nonrepo', 'empty-path']) mkdirSync(join(evidence, name));
// Isolate the real production execFile environment; no Git/function mocks.
for (const key of Object.keys(process.env)) {
  if (!key.startsWith('NODE_TEST_')) delete process.env[key];
}
Object.assign(process.env, env);
function run(bin, args) {
  return new Promise((resolveResult) => {
    const start = new Date().toISOString();
    const child = execFile(bin, args, { env: { ...process.env }, cwd: evidence }, (error, stdout, stderr) => {
      const result = { argv: [bin, ...args], cwd: evidence, env: { ...process.env }, pid: child.pid ?? null,
        start, end: new Date().toISOString(), stdout, stderr,
        error: error ? { code: error.code, errno: error.errno, syscall: error.syscall, message: error.message } : null };
      appendFileSync(join(evidence, 'commands.jsonl'), JSON.stringify(result) + '\n');
      resolveResult(result);
    });
  });
}
const repo = join(evidence, 'repo');
async function git(...args) {
  const r = await run('/usr/bin/git', ['-C', repo, ...args]);
  assert.equal(r.error, null, r.stderr);
}
await git('init', '--template=' + join(evidence, 'template'));
writeFileSync(join(repo, 'tracked.txt'), 'base\n');
await git('add', 'tracked.txt');
await git('commit', '-m', 'fixture');
async function check(name, dir, want, code = null) {
  const args = ['-C', dir, 'status', '--porcelain'];
  const [absolute, pathGit, actual] = await Promise.all([
    run('/usr/bin/git', args), run('git', args), worktreeStatus(dir)
  ]);
  const files = { tracked: readFileSync(join(repo, 'tracked.txt'), 'utf8'),
    untracked: existsSync(join(repo, 'untracked.txt')), inputExists: existsSync(dir) };
  appendFileSync(join(evidence, 'results.jsonl'), JSON.stringify({ name, dir, absolute, pathGit, actual, files }) + '\n');
  assert.equal(pathGit.error?.code ?? null, code);
  if (code !== 'ENOENT') {
    assert.equal(absolute.error?.code ?? null, code);
    assert.equal(absolute.stdout, pathGit.stdout);
    assert.equal(absolute.stderr, pathGit.stderr);
  } else assert.equal(absolute.error, null);
  if (code) assert.equal(pathGit.stdout, '');
  assert.deepEqual(actual, want);
}

test('successful clean Git status is clean', async () => {
  await check('clean', repo, { clean: true, raw: '' });
});
test('tracked modification preserves trimmed porcelain', async () => {
  writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
  try { await check('tracked', repo, { clean: false, raw: 'M tracked.txt' }); }
  finally { writeFileSync(join(repo, 'tracked.txt'), 'base\n'); }
});
test('untracked file is dirty', async () => {
  writeFileSync(join(repo, 'untracked.txt'), 'new\n');
  try { await check('untracked', repo, { clean: false, raw: '?? untracked.txt' }); }
  finally { unlinkSync(join(repo, 'untracked.txt')); }
});
test('nonrepository Git exit 128 cannot be clean', async () => {
  await check('nonrepo', join(evidence, 'nonrepo'), { clean: false, raw: '' }, 128);
});
test('missing directory Git exit 128 cannot be clean', async () => {
  await check('missing', join(evidence, 'missing'), { clean: false, raw: '' }, 128);
});
test('actual Git ENOENT cannot be clean', async () => {
  process.env.PATH = join(evidence, 'empty-path');
  try { await check('enoent', repo, { clean: false, raw: '' }, 'ENOENT'); }
  finally { process.env.PATH = env.PATH; }
});
