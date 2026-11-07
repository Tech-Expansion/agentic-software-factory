import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { init } from './commands/init.js';
import { approve, reject, release, releasable } from './commands/review.js';
import { run } from './commands/run.js';
import { git } from './git.js';
import { loadState } from './state.js';
import type { AgentCall, AgentResult, Runtime } from './runtimes/types.js';

process.env.ASF_HOME = mkdtempSync(join(tmpdir(), 'asf-home-'));
process.env.ASF_UNSAFE_NO_SANDBOX = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'asf test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'asf@example.invalid';

const plan = { approach: 'Use CIP-1854 keys.', files: ['src/keys/sign.js'], tests: ['AC-001 a missing gate signature is refused'], risks: ['a wrong key signs'] };
const pass = { verdict: 'pass', criteria: [], findings: [], summary: 'good' };

/** Each item writes the file its body names; the tech lead returns a plan. */
function team(): Runtime & { calls: AgentCall[] } {
  const calls: AgentCall[] = [];
  return {
    name: 'claude-code',
    calls,
    async call(c): Promise<AgentResult> {
      calls.push(c);
      const tokens = { input: 1, cached_input: 0, output: 1, total: 2 };
      if (c.systemPrompt.includes('You are the tech lead')) return { ok: true, text: '', structured: plan, tokens, durationMs: 1 };
      if (c.access === 'write' && !c.writeOnly) {
        const file = /writes (\S+)/.exec(c.prompt)![1]!;
        mkdirSync(join(c.cwd, file, '..'), { recursive: true });
        writeFileSync(join(c.cwd, file), `${file}\n`);
      }
      return { ok: true, text: 'done', structured: pass, tokens, durationMs: 1 };
    },
    interactive: async () => 0,
  };
}

let root: string;
const item = (n: number, extra = '', file = `f${n}.txt`) =>
  writeFileSync(join(root, `backlog/000${n}-x.md`), `---\nid: B-000${n}\ntitle: Item ${n}\nstatus: ready\npriority: ${n}\n${extra}---\nThis item writes ${file}\n`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'asf-product-'));
  init(root, 'demo');
  const project = join(root, '.factory/project.yaml');
  writeFileSync(project, readFileSync(project, 'utf8').replace('notifications: desktop', 'notifications: none') + 'integration_branch: integration\n');
  writeFileSync(join(root, '.factory/policy.yaml'), 'sensitive_paths: ["keys/**"]\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  process.chdir(root);
});

test('items that pass merge into the integration branch on their own; the owner releases them as a batch', async () => {
  item(1);
  item(2, 'depends_on: [B-0001]\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'items']);
  const main = git(root, ['rev-parse', 'main']).trim();
  const out = await run({ all: true, context: { runtime: () => team() } });
  assert.deepEqual(out.map((o) => `${o.id}:${o.state}`), ['B-0001:merged', 'B-0002:merged'], 'a merged item counts as done for what depends on it');
  assert.equal(git(root, ['rev-parse', 'main']).trim(), main, 'nothing reaches main without the owner');
  assert.match(git(root, ['show', 'integration:f2.txt']), /f2/);
  assert.match(git(root, ['show', 'integration:f1.txt']), /f1/, 'B-0002 was built on top of B-0001');
  assert.deepEqual(releasable(), ['B-0001', 'B-0002']);
  assert.deepEqual(await run({ all: true, context: { runtime: () => team() } }), [], 'merged items are not built again');

  const r = release();
  assert.deepEqual(r.items, ['B-0001', 'B-0002']);
  assert.ok(existsSync(join(root, 'f1.txt')) && existsSync(join(root, 'f2.txt')));
  assert.match(readFileSync(join(root, 'backlog/0001-x.md'), 'utf8'), /status: done/);
  assert.match(git(root, ['log', '-1', '--format=%s']), /Release B-0001, B-0002/);
  assert.equal(git(root, ['rev-parse', 'integration']).trim(), git(root, ['rev-parse', 'main']).trim());
  assert.deepEqual(loadState(join(root, '.factory/state.json')).items, {});
});

test('a change to a sensitive path waits for the owner, even with an integration branch', async () => {
  item(1, '', 'keys/sign.txt');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'items']);
  const [out] = await run({ context: { runtime: () => team() } });
  assert.equal(out?.state, 'review');
  assert.deepEqual(out?.flags, ['keys/sign.txt']);
  assert.equal(approve('B-0001').into, 'integration');
  assert.match(git(root, ['show', 'integration:keys/sign.txt']), /keys/);
});

test('a high-risk item is planned, the owner approves the plan, and the build follows it and waits again', async () => {
  item(1, 'risk: high\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'items']);
  const rt = team();
  const [planned] = await run({ context: { runtime: () => rt } });
  assert.equal(planned?.state, 'plan-review');
  assert.equal(rt.calls.length, 1);
  assert.equal(rt.calls[0]!.access, 'read');
  assert.ok(rt.calls[0]!.schema, 'the plan has a schema');
  assert.deepEqual(await run({ context: { runtime: () => rt } }), [], 'nothing is built before the plan is approved');

  reject('B-0001', 'use a hardware wallet');
  await run({ context: { runtime: () => rt } });
  assert.match(rt.calls[1]!.prompt, /Rejected by the user: use a hardware wallet/, 'a rejected plan is written again');

  assert.equal(approve('B-0001').into, 'plan');
  const [built] = await run({ context: { runtime: () => rt } });
  assert.equal(built?.state, 'review', 'a high-risk change never merges on its own');
  assert.ok(built?.flags.includes('risk: high'));
  const builder = rt.calls.find((c) => c.access === 'write' && !c.writeOnly)!;
  assert.match(builder.prompt, /Plan approved by the owner[\s\S]*CIP-1854[\s\S]*src\/keys\/sign\.js/);
});
