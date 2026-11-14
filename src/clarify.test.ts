import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { loadClarification } from './clarify.js';
import { answer, clarify, questions } from './commands/clarify.js';
import { init } from './commands/init.js';
import { run } from './commands/run.js';
import { git } from './git.js';
import type { AgentCall, Runtime } from './runtimes/types.js';

process.env.ASF_HOME = mkdtempSync(join(tmpdir(), 'asf-home-'));
process.env.ASF_UNSAFE_NO_SANDBOX = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'asf test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'asf@example.invalid';

const q = (id: string, blocking: boolean, extra: Partial<Record<string, unknown>> = {}) => ({
  id,
  question: `${id}: which platform?`,
  why: 'it decides the stack',
  options: ['web', 'mobile'],
  recommendation: 'web',
  blocking,
  ...extra,
});

function productOwner(...answers: unknown[]): Runtime & { calls: AgentCall[] } {
  const calls: AgentCall[] = [];
  return {
    name: 'claude-code',
    calls,
    async call(c) {
      calls.push(c);
      const structured = answers[Math.min(calls.length, answers.length) - 1];
      return { ok: true, text: '', structured, tokens: { input: 10, cached_input: 0, output: 5, total: 15 }, durationMs: 1 };
    },
    interactive: async () => 0,
  };
}

let root: string;
let item: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'asf-product-'));
  init(root, 'wallet');
  const project = join(root, '.factory/project.yaml');
  writeFileSync(project, readFileSync(project, 'utf8').replace('notifications: desktop', 'notifications: none'));
  item = join(root, 'backlog/0001-wallet.md');
  writeFileSync(item, '---\nid: B-0001\ntitle: A wallet\nstatus: new\n---\nA free Cardano wallet with multi-sig.\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  process.chdir(root);
});

test('a new item is not built; blocking questions keep it new until the owner answers', async () => {
  assert.deepEqual(await run({ context: { runtime: () => assert.fail('nothing may be built') } }), []);
  const rt = productOwner({ understood: 'A wallet.', questions: [q('Q1', true), q('Q2', false, { question: 'Q2: dark mode?' })], assumptions: ['preprod only'] });
  const [out] = await clarify({ context: { runtime: () => rt } });
  assert.deepEqual(out, { id: 'B-0001', open: 1, ready: false });
  const call = rt.calls[0]!;
  assert.equal(call.access, 'read');
  assert.equal(realpathSync(call.cwd), realpathSync(root));
  assert.ok(call.schema, 'the product owner answers in the analysis schema');
  assert.match(call.prompt, /Requirement B-0001: A wallet[\s\S]*multi-sig/);
  assert.match(readFileSync(item, 'utf8'), /status: new/);
  assert.match(questions(), /Q1 \[blocking\] Q1: which platform\?[\s\S]*- mobile[\s\S]*recommended: web \(it decides the stack\)[\s\S]*Q2 Q2: dark mode/);

  writeFileSync(join(root, 'notes.txt'), 'the owner was here');
  const done = answer('B-0001', 'Q1', 'mobile first, iOS and Android');
  assert.equal(done.ready, true);
  const text = readFileSync(item, 'utf8');
  assert.match(text, /status: ready/);
  assert.match(text, /## Decisions\n\n- Q1: which platform\? mobile first, iOS and Android\n- Q2: dark mode\? web \(assumed, not asked\)\n- Assumed: preprod only/);
  assert.match(git(root, ['log', '-1', '--format=%s']), /B-0001 is clear to build/);
  assert.equal(git(root, ['show', '--name-only', '--format=', 'HEAD']).trim(), 'backlog/0001-wallet.md', 'only the item is committed');
  assert.match(git(root, ['status', '--porcelain']), /\?\? notes\.txt/);
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']).trim(), '', 'clarifications stay out of git');
});

test('an item with nothing blocking is ready at once', async () => {
  const rt = productOwner({ understood: 'Clear.', questions: [q('Q1', false)], assumptions: [] });
  const [out] = await clarify({ context: { runtime: () => rt } });
  assert.equal(out?.ready, true);
  assert.match(readFileSync(item, 'utf8'), /status: ready[\s\S]*web \(assumed, not asked\)/);
});

test('--accept takes the recommendations; a dirty checkout keeps the item new', async () => {
  const rt = productOwner({ understood: 'A wallet.', questions: [q('Q1', true), q('Q2', true)], assumptions: [] });
  await clarify({ context: { runtime: () => rt } });
  writeFileSync(join(root, 'AGENTS.md'), 'changed by the owner\n');
  const dirty = answer('B-0001', undefined, '', { accept: true });
  assert.equal(dirty.ready, false);
  assert.match(dirty.note!, /commit or stash/);
  assert.match(readFileSync(item, 'utf8'), /status: new/);
  git(root, ['checkout', '--', 'AGENTS.md']);
  const ok = answer('B-0001', undefined, '', { accept: true });
  assert.equal(ok.ready, true);
  const c = loadClarification(join(root, '.factory'), 'B-0001')!;
  assert.deepEqual(Object.values(c.answers).map((a) => [a.answer, a.recommended]), [['web', true], ['web', true]]);
});

test('asking again keeps what the owner answered and never reuses its ids', async () => {
  const rt = productOwner(
    { understood: 'A wallet.', questions: [q('Q1', true), q('Q2', true)], assumptions: [] },
    { understood: 'A mobile wallet.', questions: [q('Q1', true, { question: 'Q1: which network?' })], assumptions: [] },
  );
  await clarify({ context: { runtime: () => rt } });
  answer('B-0001', 'Q1', 'mobile');
  const [again] = await clarify({ again: true, context: { runtime: () => rt } });
  assert.match(rt.calls[1]!.prompt, /Already answered by the owner[\s\S]*Q1\. Q1: which platform\?\n {2}mobile/);
  const c = loadClarification(join(root, '.factory'), 'B-0001')!;
  assert.deepEqual(c.questions.map((x) => [x.id, x.question]), [['Q1', 'Q1: which platform?'], ['Q2', 'Q1: which network?']]);
  assert.deepEqual(again, { id: 'B-0001', open: 1, ready: false });
  const [skipped] = await clarify({ context: { runtime: () => rt } });
  assert.match(skipped!.note!, /already asked/);
  assert.equal(rt.calls.length, 2, 'no new product owner call without --again');
});

test('an analysis that breaks the contract is refused', async () => {
  await assert.rejects(clarify({ context: { runtime: () => productOwner({ understood: 'x', questions: [q('Q1', true), q('Q1', false)], assumptions: [] }) } }), /not unique/);
  await assert.rejects(clarify({ context: { runtime: () => productOwner({ understood: 'x', questions: [{ id: 'Q1' }], assumptions: [] }) } }), /product owner failed/);
  assert.equal(loadClarification(join(root, '.factory'), 'B-0001'), undefined);
});

test('a small item is built with the quick workflow, unless it is high risk', async () => {
  const rt = productOwner({ understood: 'Fix a typo.', questions: [], assumptions: [], size: 'small' });
  await clarify({ context: { runtime: () => rt } });
  assert.match(readFileSync(item, 'utf8'), /^---\nid: B-0001\ntitle: A wallet\nstatus: ready\nworkflow: quick\n---\n/);
  assert.match(git(root, ['log', '-1', '--format=%b']), /Small: built with the quick workflow/);

  writeFileSync(item, '---\nid: B-0001\ntitle: A wallet\nstatus: new\nrisk: high\n---\nSign with the gate key.\n');
  git(root, ['commit', '-qam', 'risky']);
  await clarify({ again: true, context: { runtime: () => rt } });
  assert.doesNotMatch(readFileSync(item, 'utf8'), /workflow:/, 'a high-risk item keeps feature');
});

test('asf decide answers, accepts and refuses what it does not know', async () => {
  const { decide } = await import('./commands/decide.js');
  const rt = productOwner({ understood: 'A wallet.', questions: [q('Q1', true), q('Q2', true)], assumptions: [] });
  await clarify({ context: { runtime: () => rt } });
  assert.match(decide('B-0001', ['Q1', 'mobile,', 'iOS', 'first']), /1 blocking question\(s\) open/);
  assert.match(decide('B-0001', ['accept']), /B-0001 is ready to build/);
  assert.match(readFileSync(item, 'utf8'), /Q1: which platform\? mobile, iOS first/);
  assert.throws(() => decide('B-0001', ['maybe']), /asf decide <item> approve/);
  assert.throws(() => decide('X-1', ['accept']), /not an item \(B-0001\) or a lesson/);
  assert.throws(() => decide('L-9', ['accept']), /no lesson L-9/);
});
