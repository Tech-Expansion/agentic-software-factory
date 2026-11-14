import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { init } from './commands/init.js';
import { approve, reject, release, releasable } from './commands/review.js';
import { run } from './commands/run.js';
import { validateProduct } from './commands/validate.js';
import { git } from './git.js';
import { readEvents } from './runlog.js';
import { loadState } from './state.js';
import type { AgentCall, AgentResult, Runtime } from './runtimes/types.js';

process.env.ASF_HOME = mkdtempSync(join(tmpdir(), 'asf-home-'));
process.env.ASF_UNSAFE_NO_SANDBOX = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'asf test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'asf@example.invalid';

const plan = { approach: 'Use CIP-1854 keys.', files: ['src/keys/sign.js'], tests: ['AC-001 a missing gate signature is refused'], risks: ['a wrong key signs'] };
const pass = { verdict: 'pass', criteria: [], findings: [], summary: 'good' };

/** Each item writes the file its body names; the tech lead returns a plan, and its review is `review` when given. */
function team(over: { plan?: object; review?: object } = {}): Runtime & { calls: AgentCall[] } {
  const calls: AgentCall[] = [];
  return {
    name: 'claude-code',
    calls,
    async call(c): Promise<AgentResult> {
      calls.push(c);
      const tokens = { input: 1, cached_input: 0, output: 1, total: 2 };
      if (c.systemPrompt.includes('# Skill: plan-change')) return { ok: true, text: '', structured: { ...plan, ...over.plan }, tokens, durationMs: 1 };
      if (c.systemPrompt.includes('# Skill: review-code') && over.review) return { ok: true, text: '', structured: { ...pass, ...over.review }, tokens, durationMs: 1 };
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

test('a change to a sensitive path merges once the tech lead passed it; a migration waits for the client', async () => {
  item(1, '', 'keys/sign.txt');
  item(2, '', 'db/migrations/001.sql');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'items']);
  const out = await run({ all: true, context: { runtime: () => team() } });
  assert.deepEqual(out.map((o) => `${o.id}:${o.state}`), ['B-0001:merged', 'B-0002:review']);
  assert.deepEqual(out[1]?.flags, ['db/migrations/001.sql'], 'client_paths wait however the change was reviewed');
  assert.equal(approve('B-0002').into, 'integration');
  assert.match(git(root, ['show', 'integration:db/migrations/001.sql']), /migrations/);
});

test('a decision the tech lead escalates holds the change for the client without failing it', async () => {
  item(1);
  commitItems();
  const rt = team({ review: { escalate: ['Blockfrost paid tier: about 30 USD a month; recommended over running a node'] } });
  const [out] = await run({ context: { runtime: () => rt } });
  assert.equal(out?.state, 'review');
  assert.deepEqual(out?.flags, ['tech-lead: Blockfrost paid tier: about 30 USD a month; recommended over running a node']);
  assert.equal(rt.calls.filter((c) => c.access === 'write' && !c.writeOnly).length, 1, 'not sent back to the developer');
});

test('without the tech lead\'s review, approval and sensitive paths wait for the client', async () => {
  mkdirSync(join(root, '.factory/workflows'), { recursive: true });
  writeFileSync(join(root, '.factory/workflows/lean.yaml'), 'name: lean\nsteps:\n  - { id: build, kind: agent, role: developer, skills: [implement-backlog-item], access: write }\n  - { id: check, kind: checks }\n');
  item(1, 'workflow: lean\n', 'package.json');
  commitItems();
  const [out] = await run({ context: { runtime: () => team() } });
  assert.equal(out?.state, 'review');
  assert.deepEqual(out?.flags, ['package.json']);
});

test('a high-risk item is planned by the tech lead and built at once when nothing in the plan is the client\'s', async () => {
  item(1, 'risk: high\n');
  commitItems();
  const rt = team();
  const [out] = await run({ context: { runtime: () => rt } });
  assert.equal(out?.state, 'merged', 'the tech lead planned and reviewed it');
  assert.equal(rt.calls[0]!.access, 'read');
  assert.ok(rt.calls[0]!.schema, 'the plan has a schema');
  const builder = rt.calls.find((c) => c.access === 'write' && !c.writeOnly)!;
  assert.match(builder.prompt, /The approved plan[\s\S]*CIP-1854[\s\S]*src\/keys\/sign\.js/);
  assert.ok(rt.calls.some((c) => c.writeOnly), 'with acceptance tests first');
  assert.ok(readEvents(join(root, '.factory/runs')).some((e) => e.outcome === 'plan approved' && /tech lead/.test(e.detail ?? '')));
});

test('a plan that needs the client waits for them, and the build follows it once they approve', async () => {
  item(1, 'risk: high\n');
  commitItems();
  const rt = team({ plan: { client_decisions: ['Keys in a hardware wallet (safer, needs a Ledger) or in the browser (recommended for preprod)'] } });
  const [planned] = await run({ context: { runtime: () => rt } });
  assert.equal(planned?.state, 'plan-review');
  assert.match(planned?.reason ?? '', /needs your decision: Keys in a hardware wallet/);
  assert.equal(rt.calls.length, 1);
  assert.deepEqual(await run({ context: { runtime: () => rt } }), [], 'nothing is built before the plan is approved');

  reject('B-0001', 'use a hardware wallet');
  await run({ context: { runtime: () => rt } });
  assert.match(rt.calls[1]!.prompt, /Rejected by the user: use a hardware wallet/, 'a rejected plan is written again');

  assert.equal(approve('B-0001').into, 'plan');
  const [built] = await run({ context: { runtime: () => rt } });
  assert.equal(built?.state, 'merged');
  const builder = rt.calls.find((c) => c.access === 'write' && !c.writeOnly)!;
  assert.match(builder.prompt, /The approved plan[\s\S]*For the client to decide:[\s\S]*hardware wallet/);
});

const commitItems = () => {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'items']);
};

test('a quick item is built without acceptance tests written first', async () => {
  item(1, 'workflow: quick\n');
  commitItems();
  const rt = team();
  const [out] = await run({ context: { runtime: () => rt } });
  assert.equal(out?.state, 'merged');
  assert.equal(rt.calls.filter((c) => c.writeOnly).length, 0, 'no tester');
  assert.deepEqual(rt.calls.map((c) => c.access), ['write', 'read', 'read'], 'build, then QA and the tech lead');
});

test('a quick change to a sensitive path is thrown away and built again, tests first', async () => {
  item(1, 'workflow: quick\n', 'keys/sign.txt');
  commitItems();
  const rt = team();
  const [out] = await run({ context: { runtime: () => rt } });
  assert.equal(out?.state, 'merged');
  assert.deepEqual(rt.calls.map((c) => (c.writeOnly ? 'tests' : c.access)), ['write', 'tests', 'write', 'read', 'read'], 'the quick build was not verified; feature ran from its tests step');
  assert.match(rt.calls.at(-1)!.systemPrompt, /You are the tech lead/, 'the tech lead reviews it');
  const escalated = readEvents(join(root, '.factory/runs')).find((e) => e.outcome === 'escalated');
  assert.match(escalated?.detail ?? '', /quick touched keys\/sign\.txt; built again through feature/);
});

test('a high-risk item runs feature whatever workflow it names', async () => {
  item(1, 'risk: high\nworkflow: quick\n');
  commitItems();
  const rt = team();
  const [out] = await run({ context: { runtime: () => rt } });
  assert.equal(out?.state, 'merged');
  assert.ok(rt.calls.some((c) => c.writeOnly), 'feature: acceptance tests first');
});

test('a product adds rules to a role and brings its own workflow', async () => {
  mkdirSync(join(root, '.factory/agents'), { recursive: true });
  mkdirSync(join(root, '.factory/workflows'), { recursive: true });
  writeFileSync(join(root, '.factory/agents/developer.md'), '---\nname: developer\n---\nNever log a mnemonic.\n');
  writeFileSync(join(root, '.factory/workflows/lean.yaml'), 'name: lean\nsteps:\n  - { id: build, kind: agent, role: developer, skills: [implement-backlog-item], access: write }\n  - { id: check, kind: checks }\n');
  const project = join(root, '.factory/project.yaml');
  writeFileSync(project, readFileSync(project, 'utf8') + 'workflow: lean\n');
  item(1);
  commitItems();
  assert.deepEqual(validateProduct().errors, []);
  const rt = team();
  const [out] = await run({ context: { runtime: () => rt } });
  assert.equal(out?.state, 'merged');
  assert.equal(rt.calls.length, 1, 'lean has no tester and no verifier');
  assert.match(rt.calls[0]!.systemPrompt, /You are the developer[\s\S]*## Product rules\n\nNever log a mnemonic\./, 'added after the factory\'s role, not instead of it');
});

test('a product feature workflow without tests blocks a high-risk item instead of building it untested', async () => {
  mkdirSync(join(root, '.factory/workflows'), { recursive: true });
  writeFileSync(join(root, '.factory/workflows/feature.yaml'), 'name: feature\nsteps:\n  - { id: build, kind: agent, role: developer, skills: [implement-backlog-item], access: write }\n');
  writeFileSync(join(root, '.factory/workflows/bad.yaml'), 'name: bad\nsteps:\n  - { id: build, kind: agent, role: ghost, skills: [nothing], access: write }\n');
  item(1, 'risk: high\n');
  commitItems();
  const v = validateProduct();
  assert.deepEqual(v.errors, ['.factory/workflows/bad.yaml: workflow bad, step build: unknown role: ghost', '.factory/workflows/bad.yaml: workflow bad, step build: unknown skill: nothing']);
  assert.ok(v.warnings.some((w) => /feature\.yaml has no tests step/.test(w)));
  const rt = team();
  const [out] = await run({ context: { runtime: () => rt } });
  assert.equal(out?.state, 'blocked');
  assert.match(out?.reason ?? '', /no tests step, and a high-risk item gets acceptance tests first/);
  assert.equal(rt.calls.length, 0);
});

const reviewers = (rt: ReturnType<typeof team>) => rt.calls.filter((c) => c.access === 'read').map((c) => /^# Your role\n\nYou are ([^.]+?) of /.exec(c.systemPrompt)![1]);

test('specialists come in only when the product turned them on and the change calls for them', async () => {
  const project = join(root, '.factory/project.yaml');
  writeFileSync(project, readFileSync(project, 'utf8') + 'paths:\n  ui: ["ui/**"]\n');
  item(1, '', 'ui/home.txt');
  item(2, '', 'f2.txt');
  item(3, '', 'ui/about.txt');
  commitItems();
  const off = team();
  await run({ item: 'B-0001', context: { runtime: () => off } });
  assert.deepEqual(reviewers(off), ['QA', 'the tech lead'], 'no UX designer until the product turns one on');

  writeFileSync(project, readFileSync(project, 'utf8') + 'specialists: [ux-designer]\n');
  commitItems();
  assert.deepEqual(validateProduct().errors, []);
  const ui = team();
  await run({ item: 'B-0003', context: { runtime: () => ui } });
  assert.deepEqual(reviewers(ui), ['QA', 'the tech lead', 'the UX designer']);
  const plain = team();
  await run({ item: 'B-0002', context: { runtime: () => plain } });
  assert.deepEqual(reviewers(plain), ['QA', 'the tech lead'], 'no specialist for a change that does not call for one');
});

test('an unknown specialist is a validation error', () => {
  const project = join(root, '.factory/project.yaml');
  writeFileSync(project, readFileSync(project, 'utf8') + 'specialists: [pen-tester]\n');
  assert.deepEqual(validateProduct().errors, ['project.yaml specialists: unknown role: pen-tester']);
});

test('an infra item is built by DevOps, reviewed by the tech lead, and by the security reviewer once it is on', async () => {
  const project = join(root, '.factory/project.yaml');
  writeFileSync(project, readFileSync(project, 'utf8') + 'specialists: [security-reviewer]\n');
  item(1, 'workflow: infra\n', '.github/workflows/ci.yml');
  commitItems();
  assert.deepEqual(validateProduct().errors, []);
  const rt = team();
  const [out] = await run({ context: { runtime: () => rt } });
  assert.equal(out?.state, 'merged', 'reviewed; the client sees pipeline changes again at `asf deploy`');
  const who = rt.calls.map((c) => /^# Your role\n\nYou are ([^.]+?) of /.exec(c.systemPrompt)![1]);
  assert.deepEqual(who, ['the DevOps engineer', 'QA', 'the tech lead', 'the security reviewer']);
});

test('the team suggests a specialist the settings call for, until the product turns it on', async () => {
  const { board, formatBoard } = await import('./status.js');
  const { openProduct } = await import('./commands/context.js');
  assert.ok(validateProduct().warnings.some((w) => /^suggested specialist: security-reviewer, because the product has sensitive paths \(keys\/\*\*\)/.test(w)));
  assert.match(formatBoard(board(openProduct())), /## Suggested by the team\n\n- security-reviewer, because/);
  const project = join(root, '.factory/project.yaml');
  writeFileSync(project, readFileSync(project, 'utf8') + 'specialists: [security-reviewer]\n');
  assert.deepEqual(board(openProduct()).suggestions, []);
  assert.ok(!validateProduct().warnings.some((w) => /suggested specialist/.test(w)));
});

test('ready items without a market scan get a warning', () => {
  const scan = () => validateProduct().warnings.some((w) => /product\/market\.md is missing/.test(w));
  assert.equal(scan(), false, 'nothing ready yet');
  item(1);
  assert.equal(scan(), true);
  writeFileSync(join(root, 'product/market.md'), '# Market scan (2026-11-14)\n');
  assert.equal(scan(), false);
});
