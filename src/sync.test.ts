import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { clarify } from './commands/clarify.js';
import { init } from './commands/init.js';
import { run } from './commands/run.js';
import { parseAnswers, parseDecision, sync } from './commands/sync.js';
import { git } from './git.js';
import { adfToText, jira } from './tracker/jira.js';
import type { Comment, Ticket, Tracker } from './tracker/types.js';
import type { AgentCall, AgentResult, Runtime } from './runtimes/types.js';

process.env.ASF_HOME = mkdtempSync(join(tmpdir(), 'asf-home-'));
process.env.ASF_UNSAFE_NO_SANDBOX = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'asf test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'asf@example.invalid';

const OWNER = 'acc-owner';

/** A Jira stand-in. The factory's comments are posted as the owner, as they are through acli. */
function memory(tickets: Ticket[]) {
  const comments: Record<string, Comment[]> = {};
  const moves: string[] = [];
  const labels: Record<string, Set<string>> = {};
  let n = 0;
  const add = (key: string, author: string, body: string) => (comments[key] ??= []).push({ id: String(++n), author, body, created: '' });
  const tracker: Tracker = {
    name: 'memory',
    intake: async () => tickets,
    comments: async (key) => [...(comments[key] ?? [])],
    comment: async (key, body) => void add(key, OWNER, body),
    transition: async (key, status) => void moves.push(`${key}→${status}`),
    label: async (key, a, r) => {
      const s = (labels[key] ??= new Set());
      a.forEach((x) => s.add(x));
      r.forEach((x) => s.delete(x));
    },
  };
  return { tracker, comments, moves, labels, add };
}

const verdict = { verdict: 'pass', criteria: [], findings: [], summary: 'good' };

function agents(): Runtime {
  return {
    name: 'claude-code',
    async call(c: AgentCall): Promise<AgentResult> {
      const tokens = { input: 1, cached_input: 0, output: 1, total: 2 };
      if (c.systemPrompt.includes('You are the analyst')) {
        const structured = { understood: 'A wallet.', questions: [{ id: 'Q1', question: 'Which platform?', why: 'stack', options: ['web', 'mobile'], recommendation: 'web', blocking: true }], assumptions: [] };
        return { ok: true, text: '', structured, tokens, durationMs: 1 };
      }
      if (c.access === 'write') writeFileSync(join(c.cwd, c.writeOnly ? 'wallet.test.js' : 'hello.txt'), 'x\n');
      return { ok: true, text: 'built', structured: verdict, tokens, durationMs: 1 };
    },
    interactive: async () => 0,
  };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'asf-product-'));
  init(root, 'wallet');
  const project = join(root, '.factory/project.yaml');
  writeFileSync(
    project,
    readFileSync(project, 'utf8').replace('notifications: desktop', 'notifications: none') +
      `tracker:\n  kind: jira\n  project: AI\n  owner: ${OWNER}\n  statuses: { clarifying: Clarifying, ready: Ready, in_progress: In Progress, review: In Review, done: Done }\n`,
  );
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  process.chdir(root);
});

test('a ticket goes from intake to merged through the tracker alone, and only the owner moves it', async () => {
  const j = memory([{ key: 'AI-7', title: 'Ví Cardano đa chữ ký', body: 'A wallet with multi-sig.', status: 'To Do', labels: [], reporter: OWNER }]);
  const ctx = { runtime: () => agents() };

  assert.deepEqual(await sync({ tracker: j.tracker }), ['AI-7 → B-0001 (backlog/0001-vi-cardano-da-chu-ky.md)']);
  const file = join(root, 'backlog/0001-vi-cardano-da-chu-ky.md');
  assert.match(readFileSync(file, 'utf8'), /id: B-0001\ntitle: "Ví Cardano đa chữ ký"\nstatus: new\ntracker: AI-7\n---\nA wallet with multi-sig\.\n\nSource: AI-7/);
  assert.match(git(root, ['log', '-1', '--format=%s']), /B-0001 from AI-7/);
  assert.deepEqual(await sync({ tracker: j.tracker }), [], 'a ticket is taken in once');

  await clarify({ context: ctx });
  await sync({ tracker: j.tracker });
  const asked = j.comments['AI-7']!.at(-1)!.body;
  assert.match(asked, /^\[asf\] Questions about B-0001[\s\S]*Q1 \(blocking\): Which platform\?\n {2}Options: web \/ mobile\n {2}Recommended: web/);
  assert.ok(j.labels['AI-7']!.has('needs-po'));

  j.add('AI-7', 'acc-stranger', '/accept');
  assert.deepEqual(await sync({ tracker: j.tracker }), [], 'a stranger cannot answer');
  j.add('AI-7', OWNER, 'Q1: mobile, iOS first\nand Android later');
  await sync({ tracker: j.tracker });
  assert.match(readFileSync(file, 'utf8'), /status: ready[\s\S]*Which platform\? mobile, iOS first\nand Android later/);
  assert.ok(!j.labels['AI-7']!.has('needs-po'));

  const [built] = await run({ context: ctx });
  assert.equal(built?.state, 'review');
  await sync({ tracker: j.tracker });
  assert.match(j.comments['AI-7']!.at(-1)!.body, /^\[asf\] B-0001 is built[\s\S]*Reply "\/approve"/);

  j.add('AI-7', 'acc-stranger', '/approve');
  await sync({ tracker: j.tracker });
  assert.ok(!existsSync(join(root, 'hello.txt')), 'a stranger cannot approve');
  j.add('AI-7', OWNER, 'Looks right.\n/approve');
  await sync({ tracker: j.tracker });
  assert.equal(readFileSync(join(root, 'hello.txt'), 'utf8'), 'x\n');
  assert.deepEqual(j.moves, ['AI-7→Clarifying', 'AI-7→Ready', 'AI-7→In Review', 'AI-7→Done']);
  assert.match(j.comments['AI-7']!.at(-1)!.body, /B-0001 is merged/);
  await sync({ tracker: j.tracker });
  assert.equal(j.comments['AI-7']!.filter((c) => /is merged/.test(c.body)).length, 1, 'said once');
});

test('answers and decisions are read from plain comments', () => {
  assert.deepEqual(parseAnswers('Thanks.\nQ1: web\nQ2) two-of-three\n  with a backup\n/accept'), { accept: true, answers: { Q1: 'web', Q2: 'two-of-three\nwith a backup' } });
  assert.deepEqual(parseDecision('ok\n/reject the fee is wrong\nuse min fee'), { kind: 'reject', reason: 'the fee is wrong\nuse min fee' });
  assert.deepEqual(parseDecision('/approve'), { kind: 'approve', reason: undefined });
  assert.equal(parseDecision('I approve of this'), undefined);
});

test('jira over acli: the owner’s tickets only, text from ADF, plain flags', async () => {
  const calls: string[][] = [];
  const out: Record<string, unknown> = {
    search: [
      { key: 'AI-1', fields: { summary: 'Mine', status: { name: 'To Do' }, labels: ['x'], reporter: { accountId: OWNER }, description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] }] } } },
      { key: 'AI-2', fields: { summary: 'Theirs', status: { name: 'To Do' }, reporter: { accountId: 'other' } } },
    ],
    list: { comments: [{ id: 10, author: { accountId: OWNER }, body: 'Q1: web', created: '2026-11-07T11:12:16.810+0700' }] },
  };
  const t = jira({ kind: 'jira', project: 'AI', owner: OWNER }, async (args) => {
    calls.push(args);
    const which = args.includes('search') ? 'search' : args.includes('list') ? 'list' : '';
    return { code: 0, stdout: which ? JSON.stringify(out[which]) : '', stderr: '' };
  });
  const tickets = await t.intake();
  assert.deepEqual(tickets.map((x) => [x.key, x.body]), [['AI-1', 'Hello\n\n- one']]);
  assert.match(calls[0]!.join(' '), /--jql project = "AI" AND reporter = "acc-owner" AND status = "To Do"/);
  assert.deepEqual(await t.comments('AI-1'), [{ id: '10', author: OWNER, body: 'Q1: web', created: '2026-11-07T11:12:16.810+0700' }]);
  await t.transition('AI-1', 'In Review');
  assert.deepEqual(calls.at(-1), ['jira', 'workitem', 'transition', '--key', 'AI-1', '--status', 'In Review', '--yes']);
  assert.equal(adfToText('plain'), 'plain');
  const failing = jira({ kind: 'jira', project: 'AI', owner: OWNER }, async () => ({ code: 1, stdout: '', stderr: 'not logged in' }));
  await assert.rejects(failing.intake(), /not logged in/);
});
