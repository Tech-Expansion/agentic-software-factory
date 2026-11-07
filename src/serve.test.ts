import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { init } from './commands/init.js';
import { serve } from './commands/serve.js';
import { git } from './git.js';
import { loadState, saveState } from './state.js';
import type { AgentCall, AgentResult, Runtime } from './runtimes/types.js';

process.env.ASF_HOME = mkdtempSync(join(tmpdir(), 'asf-home-'));
process.env.ASF_UNSAFE_NO_SANDBOX = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'asf test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'asf@example.invalid';

const pass = { verdict: 'pass', criteria: [], findings: [], summary: 'good' };
const tokens = { input: 1, cached_input: 0, output: 1, total: 2 };

/** Builders take a little real time, so items that run in parallel overlap. */
function team(opts: { limitFirst?: number } = {}): Runtime & { calls: AgentCall[]; peak: number } {
  let active = 0;
  const rt = {
    name: 'claude-code' as const,
    calls: [] as AgentCall[],
    peak: 0,
    async call(c: AgentCall): Promise<AgentResult> {
      rt.calls.push(c);
      if (opts.limitFirst !== undefined && rt.calls.length === 1) {
        return { ok: false, text: '', tokens, durationMs: 1, error: 'usage limit reached', rateLimit: { status: 'rejected', resetsAt: opts.limitFirst } };
      }
      active++;
      rt.peak = Math.max(rt.peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      if (c.access === 'write' && !c.writeOnly) writeFileSync(join(c.cwd, 'out.txt'), c.cwd);
      return { ok: true, text: 'done', structured: pass, tokens, durationMs: 1 };
    },
    interactive: async () => 0,
  };
  return rt;
}

let root: string;
const items = (n: number) => {
  for (let i = 1; i <= n; i++) writeFileSync(join(root, `backlog/000${i}-x.md`), `---\nid: B-000${i}\ntitle: Item ${i}\nstatus: ready\npriority: ${i}\n---\nWrite out.txt.\n`);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'items']);
};
const quick = () => new Promise<void>((r) => setTimeout(r, 5));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'asf-product-'));
  init(root, 'demo');
  const project = join(root, '.factory/project.yaml');
  writeFileSync(project, readFileSync(project, 'utf8').replace('notifications: desktop', 'notifications: none'));
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  process.chdir(root);
});

test('an idle team spends nothing', async () => {
  const rt = team();
  const r = await serve({ rounds: 5, sleep: quick, context: { runtime: () => rt } });
  assert.equal(r.rounds, 5);
  assert.equal(rt.calls.length, 0);
  assert.ok(!existsSync(join(root, '.factory/lock')), 'the lock is given back');
});

test('independent items are built in parallel, never more than the workers', async () => {
  items(3);
  const rt = team();
  const r = await serve({ workers: 2, rounds: 40, sleep: quick, context: { runtime: () => rt } });
  assert.deepEqual(r.outcomes.map((o) => o.state), ['review', 'review', 'review']);
  assert.equal(rt.peak, 2);
  assert.deepEqual(Object.values(loadState(join(root, '.factory/state.json')).items).map((s) => s.state), ['review', 'review', 'review']);
});

test('a usage limit pauses the work until the quota resets, then it resumes', async () => {
  items(1);
  let clock = 1_000_000_000_000;
  const slept: number[] = [];
  const rt = team({ limitFirst: clock / 1000 + 150 });
  const r = await serve({
    rounds: 8,
    intervalSeconds: 60,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
      await quick();
    },
    context: { runtime: () => rt },
  });
  assert.deepEqual(r.outcomes.map((o) => o.state), ['paused', 'review']);
  assert.ok(slept.includes(60_000) && slept.some((ms) => ms < 60_000), `waited for the reset: ${slept.join(', ')}`);
  const calls = rt.calls.length;
  assert.ok(calls >= 4, 'tests, build and verify after the pause');
});

test('items that were running when the factory stopped resume', async () => {
  items(1);
  const state = loadState(join(root, '.factory/state.json'));
  state.items['B-0001'] = { state: 'in-progress', branch: 'asf/B-0001', worktree: join(root, '.factory/worktrees/B-0001'), attempts: 1, tokens: 0, updated_at: '' };
  saveState(join(root, '.factory/state.json'), state);
  const logs: string[] = [];
  const r = await serve({ rounds: 10, sleep: quick, log: (m) => logs.push(m), context: { runtime: () => team() } });
  assert.ok(logs.includes('B-0001 resumes where it stopped'));
  assert.equal(r.outcomes[0]?.state, 'review');
});

test('one process at a time; a lock left by a dead one is taken over', async () => {
  mkdirSync(join(root, '.factory'), { recursive: true });
  writeFileSync(join(root, '.factory/lock'), JSON.stringify({ pid: process.ppid, what: 'serve', at: 'earlier' }));
  await assert.rejects(serve({ rounds: 1, sleep: quick, context: { runtime: () => team() } }), /already working on this product/);
  writeFileSync(join(root, '.factory/lock'), JSON.stringify({ pid: 2 ** 22 + 12345, what: 'serve', at: 'earlier' }));
  assert.equal((await serve({ rounds: 1, sleep: quick, context: { runtime: () => team() } })).rounds, 1);
});
