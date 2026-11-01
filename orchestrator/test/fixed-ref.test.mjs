import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = process.env.FIXED_REF_SOURCE
  ? resolve(process.env.FIXED_REF_SOURCE)
  : fileURLToPath(new URL('../../', import.meta.url));
const evidence = process.env.FIXED_REF_EVIDENCE
  ? resolve(process.env.FIXED_REF_EVIDENCE)
  : mkdtempSync(join(tmpdir(), 'fixed-ref-'));
// Explicit evidence paths must be fresh; never overwrite an earlier run.
if (process.env.FIXED_REF_EVIDENCE) mkdirSync(evidence);
const { createWorktree } = await import(pathToFileURL(join(source, 'orchestrator/src/executor.mjs')));
const originalPath = process.env.PATH;
const bin = join(evidence, 'bin');
mkdirSync(bin);
const log = join(evidence, 'git.jsonl');
const fault = join(evidence, 'fault.json');
// Observe real Git; optional controlled faults affect only our fixture HEAD file.
writeFileSync(join(bin, 'git'), `#!/usr/bin/python3
import sys,subprocess,json,pathlib,os
args=sys.argv[1:]
f=pathlib.Path(${JSON.stringify(fault)})
if f.exists() and len(args)==4 and args[2:]==['rev-parse','HEAD']:
 d=json.loads(f.read_text())
 if args[1]==d.get('dest'):
  metadata=pathlib.Path(args[1],'.git').read_text().strip()[8:]
  pathlib.Path(metadata,'HEAD').write_text(d['head']+'\\n')
p=subprocess.Popen(['/usr/bin/git',*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
o,e=p.communicate()
with open(${JSON.stringify(log)},'a') as out: out.write(json.dumps({'argv':args,'pid':p.pid,'code':p.returncode,'stdout':o.decode(),'stderr':e.decode()})+'\\n')
sys.stdout.buffer.write(o);sys.stderr.buffer.write(e);sys.exit(p.returncode)
`, { mode: 0o755 });
process.env.PATH = `${bin}:/usr/bin:/bin`;
let serial = 0;
function git(repo, ...args) {
  const r = spawnSync(join(bin, 'git'), ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function fixture(format = 'sha1') {
  const repo = join(evidence, `repo-${++serial}`);
  mkdirSync(repo);
  git(repo, 'init', '--template=', `--object-format=${format}`, '-b', 'fixture');
  git(repo, 'config', 'core.hooksPath', '/dev/null');
  git(repo, 'config', 'core.fsmonitor', 'false');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@localhost');
  writeFileSync(join(repo, 'value'), 'A\n');
  git(repo, 'add', 'value'); git(repo, 'commit', '-m', 'A');
  const a = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'value'), 'B\n');
  git(repo, 'commit', '-am', 'B');
  const b = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'branch', 'moving', a); git(repo, 'tag', 'moving-tag', a);
  git(repo, 'tag', '-a', 'object-tag', '-m', 'tag', a);
  git(repo, 'reset', '--hard', a);
  const initial = git(repo, 'worktree', 'list', '--porcelain');
  return { repo, a, b, initial };
}
async function observe(f, input, label) {
  const dest = join(evidence, `dest-${++serial}`);
  const result = await createWorktree({ repo: f.repo, commit: input, dest });
  const present = existsSync(dest);
  const registration = git(f.repo, 'worktree', 'list', '--porcelain');
  const actual = present ? git(dest, 'rev-parse', 'HEAD') : null;
  const content = present && existsSync(join(dest, 'value')) ? readFileSync(join(dest, 'value'), 'utf8') : null;
  const row = { label, input, result, dest, present, registration, actual, content };
  appendFileSync(join(evidence, 'observations.jsonl'), JSON.stringify(row) + '\n');
  if (present && registration.includes(dest)) git(f.repo, 'worktree', 'remove', '--force', dest);
  row.cleaned = git(f.repo, 'worktree', 'list', '--porcelain');
  appendFileSync(join(evidence, 'cleanup.jsonl'), JSON.stringify({ dest, registration: row.cleaned, present: existsSync(dest) })+'\n');
  assert.equal(row.cleaned, f.initial);
  return row;
}
function rejected(row) {
  assert.equal(row.result.ok, false, row.label);
  assert.equal(row.present, false, row.label);
  assert.ok(!row.registration.includes(row.dest), row.label);
}

// Removing the full-ID guard permits the same request to select different content.
test('moving HEAD, branch and tag are rejected before creating any worktree', async () => {
  const f = fixture(); const rows = [];
  for (const ref of ['HEAD', 'moving', 'moving-tag']) rows.push(await observe(f, ref, `before-${ref}`));
  git(f.repo, 'reset', '--hard', f.b); f.initial = git(f.repo, 'worktree', 'list', '--porcelain');
  git(f.repo, 'branch', '-f', 'moving', f.b); git(f.repo, 'tag', '-f', 'moving-tag', f.b);
  for (const ref of ['HEAD', 'moving', 'moving-tag']) rows.push(await observe(f, ref, `after-${ref}`));
  const fixed = await observe(f, f.a, 'fixed-A-after-movement');
  assert.equal(fixed.result.ok, true); assert.equal(fixed.actual, f.a); assert.equal(fixed.content, 'A\n');
  assert.equal(git(f.repo, 'symbolic-ref', '--short', 'HEAD'), 'fixture');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.b); assert.equal(readFileSync(join(f.repo, 'value'), 'utf8'), 'B\n');
  for (const row of rows) rejected(row); // Complete both phases before the first rejection assertion.
});

for (const format of ['sha1', 'sha256']) test(`complete ${format} commit checks out exact A`, async () => {
  const f = fixture(format); git(f.repo, 'reset', '--hard', f.b); f.initial = git(f.repo, 'worktree', 'list', '--porcelain');
  const row = await observe(f, f.a, format);
  assert.equal(f.a.length, format === 'sha1' ? 40 : 64);
  assert.equal(row.result.ok, true); assert.equal(row.result.sha, f.a);
  assert.equal(row.actual, f.a); assert.equal(row.content, 'A\n');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.b);
});

// Removing input/type validation must fail without leaving destinations or registrations.
test('reject malformed IDs, missing objects and non-commit objects', async () => {
  const f = fixture();
  const inputs = ['', f.a.slice(0, 7), `${f.a}^`, `${f.a}^{commit}`, 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(40), '0'.repeat(40), git(f.repo, 'rev-parse', `${f.a}:value`), git(f.repo, 'rev-parse', `${f.a}^{tree}`), git(f.repo, 'rev-parse', 'object-tag')];
  const rows = [];
  for (const input of inputs) rows.push(await observe(f, input, input));
  for (const row of rows) rejected(row);
});

test('rejection and failed worktree add preserve existing destination content', async () => {
  const f = fixture(); const dest = join(evidence, `existing-${++serial}`); mkdirSync(dest);
  writeFileSync(join(dest, 'marker'), 'preserve');
  for (const commit of ['HEAD', f.a]) {
    const result = await createWorktree({ repo: f.repo, commit, dest });
    appendFileSync(join(evidence, 'observations.jsonl'), JSON.stringify({ label: 'existing-dest', commit, result })+'\n');
    assert.equal(result.ok, false); assert.equal(readFileSync(join(dest, 'marker'), 'utf8'), 'preserve');
    assert.equal(git(f.repo, 'worktree', 'list', '--porcelain'), f.initial);
  }
});

// Ignoring failed/mismatching final HEAD must fail these real-Git fault controls.
for (const mode of ['failure', 'mismatch']) test(`final HEAD ${mode} cannot return success or leak worktree`, async () => {
  const f = fixture(); const dest = join(evidence, `fault-dest-${++serial}`);
  writeFileSync(fault, JSON.stringify({ dest, head: mode === 'failure' ? 'ref: refs/heads/missing' : f.b }));
  let result;
  try {
    result = await createWorktree({ repo: f.repo, commit: f.a, dest });
    const registration = git(f.repo, 'worktree', 'list', '--porcelain');
    appendFileSync(join(evidence, 'fault-results.jsonl'), JSON.stringify({ mode, result, registration, present: existsSync(dest) })+'\n');
    assert.equal(result.ok, false); assert.equal(existsSync(dest), false);
    assert.equal(registration, f.initial);
  } finally {
    // Disable injection before cleanup; only touch this fixture's metadata.
    writeFileSync(fault, '{}');
    if (existsSync(join(dest, '.git'))) {
      const metadata = readFileSync(join(dest, '.git'), 'utf8').trim().slice(8);
      writeFileSync(join(metadata, 'HEAD'), f.a+'\n');
      git(f.repo, 'worktree', 'remove', '--force', dest);
    }
    appendFileSync(join(evidence, 'cleanup.jsonl'), JSON.stringify({ mode, registration: git(f.repo, 'worktree', 'list', '--porcelain'), present: existsSync(dest) })+'\n');
  }
});
test.after(() => { process.env.PATH = originalPath; });
