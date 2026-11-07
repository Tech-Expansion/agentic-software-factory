import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { init } from './commands/init.js';
import { run } from './commands/run.js';
import { git } from './git.js';
import { stopCheck } from './hooks/stop-checks.js';
import { readEvents } from './runlog.js';
import type { AgentCall, Runtime } from './runtimes/types.js';

process.env.ASF_HOME = mkdtempSync(join(tmpdir(), 'asf-home-'));
process.env.ASF_UNSAFE_NO_SANDBOX = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'asf test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'asf@example.invalid';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'asf-product-'));
});

test('the stop check sends the builder back while the checks fail, at most max times', () => {
  const cfg = { cwd: root, commands: ['test -f done.txt'], max: 2, counter: join(root, 'count.json') };
  const first = stopCheck(cfg);
  assert.equal(first.block, true);
  assert.match(first.reason!, /round 1 of 2[\s\S]*`test -f done\.txt`: FAILED/);
  assert.equal(stopCheck(cfg).block, true);
  assert.deepEqual(stopCheck(cfg), { block: false, count: { rounds: 2, blocked: 2, passed: false } }, 'let go; the runner decides');
  writeFileSync(join(root, 'done.txt'), '');
  const fresh = { ...cfg, counter: join(root, 'other.json') };
  assert.deepEqual(stopCheck(fresh), { block: false, count: { rounds: 1, blocked: 0, passed: true } });
});

test('as a hook process it answers in the format Claude Code reads', () => {
  const file = join(root, 'cfg.json');
  writeFileSync(file, JSON.stringify({ cwd: root, commands: ['exit 3'], max: 1, counter: join(root, 'c.json') }));
  const script = join(import.meta.dirname, 'hooks', 'stop-checks.js');
  const r = spawnSync(process.execPath, [script, file], { input: '{"hook_event_name":"Stop","stop_hook_active":false}', encoding: 'utf8' });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout) as { decision: string; reason: string };
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /`exit 3`: FAILED/);
  const again = spawnSync(process.execPath, [script, file], { input: '{}', encoding: 'utf8' });
  assert.equal(again.stdout, '', 'after max rounds it lets the agent stop');
});

/** Stands in for Claude Code: when the builder is done, it runs the Stop hook, and goes on while it blocks. */
function claudeWithHooks(): Runtime & { calls: AgentCall[]; reasons: string[] } {
  const rt = {
    name: 'claude-code' as const,
    calls: [] as AgentCall[],
    reasons: [] as string[],
    async call(c: AgentCall) {
      rt.calls.push(c);
      const tokens = { input: 1, cached_input: 0, output: 1, total: 2 };
      if (c.access === 'read') return { ok: true, text: '', structured: { verdict: 'pass', criteria: [], findings: [], summary: 'ok' }, tokens, durationMs: 1 };
      if (c.writeOnly) return { ok: true, text: '', tokens, durationMs: 1 };
      writeFileSync(join(c.cwd, 'draft.txt'), 'x');
      const hook = (c.hooks as { Stop: { hooks: { command: string }[] }[] } | undefined)?.Stop[0]?.hooks[0]?.command;
      for (let i = 0; hook && i < 5; i++) {
        const out = spawnSync(hook, { shell: true, cwd: c.cwd, input: '{}', encoding: 'utf8' }).stdout;
        if (!out) break;
        rt.reasons.push((JSON.parse(out) as { reason: string }).reason);
        writeFileSync(join(c.cwd, 'hello.txt'), 'hi');
      }
      return { ok: true, text: 'built', tokens, durationMs: 1 };
    },
    interactive: async () => 0,
  };
  return rt;
}

test('a failing check is fixed inside the build session, without another attempt', async () => {
  init(root, 'demo');
  const project = join(root, '.factory/project.yaml');
  writeFileSync(project, readFileSync(project, 'utf8').replace('check: []', 'check: ["test -f hello.txt"]').replace('notifications: desktop', 'notifications: none'));
  writeFileSync(join(root, 'backlog/0001-hello.md'), '---\nid: B-0001\ntitle: Say hello\nstatus: ready\n---\nCreate hello.txt.\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  process.chdir(root);
  const rt = claudeWithHooks();
  const [out] = await run({ context: { runtime: () => rt } });
  assert.equal(out?.state, 'review');
  assert.equal(rt.reasons.length, 1);
  assert.match(rt.reasons[0]!, /the checks failed \(round 1 of 3\)/);
  assert.equal(rt.calls.filter((c) => c.access === 'write' && !c.writeOnly).length, 1, 'one build call');
  assert.equal(rt.calls.find((c) => c.writeOnly)?.hooks, undefined, 'the tests step is not held to the checks');
  const e = readEvents(join(root, '.factory/runs')).find((x) => x.outcome === 'passed in session');
  assert.equal(e?.detail, '2 round(s), sent back 1 time(s)');
  assert.ok(existsSync(join(root, '.factory/runs/hooks/B-0001/a1-build.json')), 'the hook settings live outside the worktree');
});
