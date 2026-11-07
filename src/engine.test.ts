import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { init } from './commands/init.js';
import { report } from './commands/report.js';
import { approve, reject } from './commands/review.js';
import { run } from './commands/run.js';
import { validateProduct } from './commands/validate.js';
import { git } from './git.js';
import { readEvents } from './runlog.js';
import { loadState } from './state.js';
import type { AgentCall, AgentResult, Runtime } from './runtimes/types.js';

process.env.ASF_HOME = mkdtempSync(join(tmpdir(), 'asf-home-'));
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'asf test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'asf@example.invalid';

type Script = (c: AgentCall, n: number) => Partial<AgentResult> & { write?: Record<string, string | undefined> };

/** A runtime that follows a script instead of calling a model. */
function fake(script: Script): Runtime & { calls: AgentCall[] } {
  const calls: AgentCall[] = [];
  return {
    name: 'claude-code',
    calls,
    async call(c) {
      calls.push(c);
      const r = script(c, calls.length);
      for (const [f, text] of Object.entries(r.write ?? {})) {
        if (text === undefined) continue;
        mkdirSync(join(c.cwd, f, '..'), { recursive: true });
        writeFileSync(join(c.cwd, f), text);
      }
      return { ok: true, text: 'built it', tokens: { input: 100, cached_input: 0, output: 10, total: 110 }, durationMs: 1, ...r };
    },
    interactive: async () => 0,
  };
}

const verdict = (pass: boolean) => ({
  verdict: pass ? 'pass' : 'fail',
  criteria: [{ id: 'AC-001', status: pass ? 'met' : 'not_met', evidence: pass ? 'test AC-001' : 'no hello.txt' }],
  findings: [],
  summary: pass ? 'good' : 'missing file',
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'asf-product-'));
  init(root, 'demo');
  const project = join(root, '.factory/project.yaml');
  writeFileSync(project, readFileSync(project, 'utf8').replace('check: []', 'check: ["test -f hello.txt"]').replace('notifications: desktop', 'notifications: none'));
  writeFileSync(join(root, '.factory/policy.yaml'), 'max_attempts: 2\n');
  writeFileSync(join(root, 'specs/hello.md'), '# Hello\n\n## Acceptance criteria\n- AC-001: hello.txt exists.\n');
  writeFileSync(join(root, 'backlog/0001-hello.md'), '---\nid: B-0001\ntitle: Say hello\nstatus: ready\npriority: 1\nspec: specs/hello.md\ncriteria: [AC-001]\n---\nCreate hello.txt.\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  process.chdir(root);
});

test('an item that passes checks and review waits for approval, and approve merges it', async () => {
  assert.deepEqual(validateProduct().errors, []);
  const rt = fake((c) => (c.access === 'write' ? { write: { 'hello.txt': 'hi\n' } } : { structured: verdict(true) }));
  const [out] = await run({ context: { runtime: () => rt } });
  assert.equal(out?.state, 'review');
  assert.equal(rt.calls.length, 2);
  assert.match(rt.calls[1]!.prompt, /hello\.txt/, 'the verifier sees the diff');
  assert.ok(rt.calls[1]!.schema, 'the verifier is asked for a verdict');
  assert.equal(existsSync(join(root, 'hello.txt')), false, 'nothing lands on main before approval');

  approve('B-0001');
  assert.equal(readFileSync(join(root, 'hello.txt'), 'utf8'), 'hi\n');
  assert.match(readFileSync(join(root, 'backlog/0001-hello.md'), 'utf8'), /status: done/);
  assert.equal(existsSync(join(root, '.factory/worktrees/B-0001')), false);
  assert.equal(git(root, ['status', '--porcelain']).trim(), '', 'run state stays out of git');
  assert.match(report(), /Done\n\n- B-0001 Say hello/);
});

test('failed checks go back to the builder with the output, without a model review', async () => {
  const rt = fake((c, n) => (c.access === 'write' ? (n === 1 ? { write: { 'other.txt': 'x' } } : { write: { 'hello.txt': 'hi' } }) : { structured: verdict(true) }));
  const [out] = await run({ context: { runtime: () => rt } });
  assert.equal(out?.state, 'review');
  assert.deepEqual(rt.calls.map((c) => c.access), ['write', 'write', 'read']);
  assert.match(rt.calls[1]!.prompt, /The checks failed/);
});

test('an item that keeps failing review is blocked after max_attempts', async () => {
  const rt = fake((c) => (c.access === 'write' ? { write: { 'hello.txt': 'hi' } } : { structured: verdict(false) }));
  const [out] = await run({ context: { runtime: () => rt } });
  assert.equal(out?.state, 'blocked');
  assert.equal(rt.calls.length, 4);
  assert.match(rt.calls[2]!.prompt, /AC-001 not_met: no hello.txt/);
});

test('changes to protected paths are put back and sent as feedback', async () => {
  const rt = fake((c, n) =>
    c.access === 'write'
      ? { write: n === 1 ? { 'hello.txt': 'hi', 'specs/hello.md': 'rewritten' } : { 'hello.txt': 'hi' } }
      : { structured: verdict(true) },
  );
  const [out] = await run({ context: { runtime: () => rt } });
  assert.equal(out?.state, 'review');
  assert.match(rt.calls[1]!.prompt, /protected files.*specs\/hello\.md/);
  const spec = git(join(root, '.factory/worktrees/B-0001'), ['show', 'HEAD:specs/hello.md']);
  assert.match(spec, /AC-001/);
});

test('a protected change made during review never reaches the commit', async () => {
  const rt = fake((c) => (c.access === 'write' ? { write: { 'hello.txt': 'hi' } } : { write: { 'specs/hello.md': 'rewritten' }, structured: verdict(true) }));
  const [out] = await run({ context: { runtime: () => rt } });
  assert.equal(out?.state, 'blocked');
  assert.match(out!.reason!, /outside a build step: specs\/hello\.md/);
  const wt = join(root, '.factory/worktrees/B-0001');
  assert.match(readFileSync(join(wt, 'specs/hello.md'), 'utf8'), /AC-001/);
  assert.equal(git(wt, ['rev-parse', 'HEAD']).trim(), git(root, ['rev-parse', 'main']).trim(), 'nothing was committed');
});

test('a runtime error blocks at once instead of retrying', async () => {
  const rt = fake(() => ({ ok: false, error: 'usage limit reached' }));
  const [out] = await run({ all: true, context: { runtime: () => rt } });
  assert.equal(out?.state, 'blocked');
  assert.equal(rt.calls.length, 1);
  assert.match(out!.reason!, /usage limit/);
  const items = readEvents(join(root, '.factory/runs')).filter((e) => e.kind === 'agent');
  assert.equal(items[0]?.tokens?.total, 110);
});

test('a rejected item runs again with the reason as feedback', async () => {
  const rt = fake((c) => (c.access === 'write' ? { write: { 'hello.txt': 'hi' } } : { structured: verdict(true) }));
  await run({ context: { runtime: () => rt } });
  reject('B-0001', 'say hello in Vietnamese');
  assert.equal(loadState(join(root, '.factory/state.json')).items['B-0001']?.state, 'rework');
  const [out] = await run({ context: { runtime: () => rt } });
  assert.equal(out?.state, 'review');
  assert.match(rt.calls[2]!.prompt, /Rejected by the user: say hello in Vietnamese/);
});
