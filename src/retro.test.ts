import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { openProduct } from './commands/context.js';
import { init } from './commands/init.js';
import { run } from './commands/run.js';
import { reject } from './commands/review.js';
import { sync } from './commands/sync.js';
import { git } from './git.js';
import { decideLesson, loadLessons, type Proposed } from './retro.js';
import { board } from './status.js';
import { loadWorkflow } from './workflow.js';
import type { AgentCall, Runtime } from './runtimes/types.js';
import type { Comment, Tracker } from './tracker/types.js';

process.env.ASF_HOME = mkdtempSync(join(tmpdir(), 'asf-home-'));
process.env.ASF_UNSAFE_NO_SANDBOX = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'asf test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'asf@example.invalid';

const tokens = { input: 1, cached_input: 0, output: 1, total: 2 };
const pass = { verdict: 'pass', criteria: [], findings: [], summary: 'good' };
const lesson = (p: Partial<Proposed> = {}): Proposed => ({ title: 'Write hello.txt at the root', problem: 'attempt 1 wrote it elsewhere', kind: 'check', scope: 'product', proposal: 'a test that hello.txt exists', recurs: '', ...p });

/** The builder misses on its first attempt of each item when `miss` is set; the retro returns what it is given. */
function team(lessons: Proposed[] | (() => Proposed[]), miss = true): Runtime & { calls: AgentCall[] } {
  const builds: Record<string, number> = {};
  const rt = {
    name: 'claude-code' as const,
    calls: [] as AgentCall[],
    async call(c: AgentCall) {
      rt.calls.push(c);
      if (c.systemPrompt.includes('retrospective')) return { ok: true, text: '', structured: { lessons: typeof lessons === 'function' ? lessons() : lessons }, tokens, durationMs: 1 };
      if (c.access === 'write' && !c.writeOnly) {
        const n = (builds[c.cwd] = (builds[c.cwd] ?? 0) + 1);
        writeFileSync(join(c.cwd, miss && n === 1 ? 'other.txt' : 'hello.txt'), 'x\n');
      }
      return { ok: true, text: 'done', structured: pass, tokens, durationMs: 1 };
    },
    interactive: async () => 0,
  };
  return rt;
}
const retros = (rt: { calls: AgentCall[] }) => rt.calls.filter((c) => c.systemPrompt.includes('retrospective'));

let root: string;
const item = (n: number) => {
  writeFileSync(join(root, `backlog/000${n}-hello.md`), `---\nid: B-000${n}\ntitle: Hello ${n}\nstatus: ready\npriority: ${n}\n---\nCreate hello.txt.\n`);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', `item ${n}`]);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'asf-product-'));
  init(root, 'demo');
  const project = join(root, '.factory/project.yaml');
  writeFileSync(project, readFileSync(project, 'utf8').replace('check: []', 'check: ["test -f hello.txt"]').replace('notifications: desktop', 'notifications: none'));
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  process.chdir(root);
});

test('an item that passes at once gets no retro', async () => {
  item(1);
  const rt = team([lesson()], false);
  assert.equal((await run({ context: { runtime: () => rt } }))[0]?.state, 'review');
  assert.equal(retros(rt).length, 0);
});

test('a second attempt gets a retro; an accepted check becomes a ready backlog item', async () => {
  item(1);
  const rt = team([lesson()]);
  const [out] = await run({ context: { runtime: () => rt } });
  assert.equal(out?.state, 'review', 'the retro never changes the outcome');
  const [call] = retros(rt);
  assert.equal(call?.access, 'read');
  assert.match(call!.prompt, /What went wrong, in order\n\n- Attempt 1: The checks failed/);
  const p = openProduct();
  assert.deepEqual(board(p).decisions.map((d) => [d.item, d.kind]), [['B-0001', 'review'], ['L-1', 'lesson']]);

  const l = decideLesson(p, 'L-1', 'accept');
  assert.equal(l.applied, 'B-0002');
  const file = readFileSync(join(root, 'backlog/0002-lesson-l-1.md'), 'utf8');
  assert.match(file, /title: "Check: Write hello.txt at the root"\nstatus: ready[\s\S]*a test that hello.txt exists[\s\S]*Source: lesson L-1/);
  assert.match(git(root, ['log', '-1', '--format=%s']), /B-0002 from lesson L-1/);
  assert.throws(() => decideLesson(p, 'L-1', 'reject'), /already accepted/);
});

test('a doc lesson goes into the memory; when the mistake comes back, it comes back as a check', async () => {
  item(1);
  await run({ context: { runtime: () => team([lesson({ kind: 'doc', proposal: 'The checks look for it there.' })]) } });
  const p = openProduct();
  decideLesson(p, 'L-1', 'accept');
  assert.match(readFileSync(join(root, '.factory/memory/context.md'), 'utf8'), /## Lessons\n\n- Write hello.txt at the root\. The checks look for it there\. \(L-1\)\n$/);
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']).trim(), '', 'committed');

  item(2);
  const rt = team([lesson({ recurs: 'L-1' })]);
  await run({ item: 'B-0002', context: { runtime: () => rt } });
  assert.match(retros(rt)[0]!.prompt, /L-1 \[product doc, accepted\] Write hello.txt/);
  const [l] = loadLessons(p.paths.factory);
  assert.deepEqual([l?.status, l?.kind, l?.items], ['proposed', 'check', ['B-0001', 'B-0002']]);
  assert.match(l!.note!, /came back on B-0002/);
  assert.equal(loadLessons(p.paths.factory).length, 1, 'not written twice');
});

test('a rejection by the owner gets a retro; a factory lesson becomes a proposal outside the product', async () => {
  item(1);
  await run({ context: { runtime: () => team([], false) } });
  reject('B-0001', 'the greeting must be in Vietnamese');
  const rt = team([lesson({ scope: 'factory', kind: 'skill', title: 'Ask about the language of user-facing text' })], false);
  await run({ context: { runtime: () => rt } });
  assert.match(retros(rt)[0]!.prompt, /The owner rejected it: the greeting must be in Vietnamese/);
  const l = decideLesson(openProduct(), 'L-1', 'accept');
  assert.ok(l.applied?.startsWith(join(process.env.ASF_HOME!, 'proposals')));
  assert.match(readFileSync(l.applied!, 'utf8'), /# Ask about the language[\s\S]*asf eval --trials 3/);
  assert.ok(!existsSync(join(root, 'backlog/0002-lesson-l-1.md')));
});

test('a broken retro is logged and changes nothing', async () => {
  item(1);
  const logs: string[] = [];
  const rt = team(() => [{ title: 'x' } as Proposed]);
  const [out] = await run({ log: (m) => logs.push(m), context: { runtime: () => rt } });
  assert.equal(out?.state, 'review');
  assert.ok(logs.some((m) => /^retro: the retro failed on B-0001/.test(m)));
  assert.deepEqual(loadLessons(openProduct().paths.factory), []);
});

test('the owner decides lessons on the digest ticket', async () => {
  item(1);
  await run({ context: { runtime: () => team([lesson(), lesson({ title: 'Second' })]) } });
  const project = join(root, '.factory/project.yaml');
  writeFileSync(project, readFileSync(project, 'utf8') + 'tracker:\n  kind: jira\n  project: AI\n  owner: acc\n  digest: AI-1\n');
  git(root, ['commit', '-qam', 'tracker']);
  const comments: Comment[] = [];
  const tracker: Tracker = {
    name: 'memory',
    intake: async () => [],
    comments: async () => [...comments],
    comment: async (_k, body) => void comments.push({ id: String(comments.length + 1), author: 'acc', body, created: '' }),
    transition: async () => {},
    label: async () => {},
  };
  await sync({ tracker });
  assert.match(board(openProduct()).decisions.find((d) => d.item === 'L-1')!.how, /reply on AI-1: "\/lesson L-1 accept"/);
  comments.push({ id: 'x', author: 'acc', body: 'ok\n/lesson L-1 accept\n/lesson l-2 reject', created: '' });
  await sync({ tracker });
  assert.deepEqual(loadLessons(openProduct().paths.factory).map((l) => l.status), ['accepted', 'rejected']);
  assert.match(comments.at(-2)!.body, /\[asf\] L-1 accepted: B-0002/);
});

test('eval ablations: a workflow without a step, and a step that does not exist', () => {
  assert.deepEqual(loadWorkflow('feature', ['tests']).steps.map((s) => s.id), ['build', 'check', 'verify']);
  assert.throws(() => loadWorkflow('feature', ['lint']), /no step lint/);
  assert.throws(() => loadWorkflow('feature', ['build', 'tests']), /must start with an agent step with write access|first step must be/);
});
