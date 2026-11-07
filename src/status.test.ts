import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { saveClarification } from './clarify.js';
import { openProduct } from './commands/context.js';
import { init } from './commands/init.js';
import { serve } from './commands/serve.js';
import { git } from './git.js';
import { appendEvent } from './runlog.js';
import { saveState, type ItemState } from './state.js';
import { board, formatBoard, readHeartbeat } from './status.js';
import type { Runtime } from './runtimes/types.js';

process.env.ASF_HOME = mkdtempSync(join(tmpdir(), 'asf-home-'));
process.env.ASF_UNSAFE_NO_SANDBOX = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'asf test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'asf@example.invalid';

let root: string;
const item = (n: number, status: string, extra = '') =>
  writeFileSync(join(root, `backlog/000${n}-x.md`), `---\nid: B-000${n}\ntitle: Item ${n}\nstatus: ${status}\n${extra}---\nBody.\n`);
const st = (state: ItemState['state'], at: string, extra: Partial<ItemState> = {}): ItemState => ({ state, branch: 'asf/x', worktree: '/x', attempts: 1, tokens: 0, updated_at: at, ...extra });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'asf-product-'));
  init(root, 'wallet');
  const project = join(root, '.factory/project.yaml');
  writeFileSync(project, readFileSync(project, 'utf8').replace('notifications: desktop', 'notifications: none'));
  process.chdir(root);
});

test('the board puts every item in a column and every decision in one queue, oldest first', () => {
  item(1, 'new');
  item(2, 'ready');
  item(3, 'ready', 'depends_on: [B-0002]\n');
  item(4, 'ready');
  item(5, 'ready', 'risk: high\n');
  item(6, 'ready');
  item(7, 'ready');
  item(8, 'done');
  const p = openProduct();
  saveClarification(p.paths.factory, {
    item: 'B-0001',
    at: '2026-11-07T08:00:00.000Z',
    understood: 'x',
    assumptions: [],
    answers: {},
    questions: [{ id: 'Q1', question: 'Which network?', why: 'w', options: [], recommendation: 'preprod', blocking: true }],
  });
  saveState(p.paths.state, {
    items: {
      'B-0004': st('review', '2026-11-07T09:00:00.000Z', { flags: ['src/keys/'] }),
      'B-0005': st('plan-review', '2026-11-07T07:00:00.000Z'),
      'B-0006': st('blocked', '2026-11-07T10:00:00.000Z', { reason: 'checks failed 3 times' }),
      'B-0007': st('in-progress', '2026-11-07T10:00:00.000Z'),
    },
  });
  const now = new Date('2026-11-07T12:00:00.000Z');
  appendEvent(p.paths.runs, { at: now.toISOString(), item: 'B-0007', step: 'build', kind: 'agent', outcome: 'ok', tokens: { input: 0, cached_input: 0, output: 0, total: 1500 } });
  const b = board(p, now);
  assert.deepEqual(b.columns, { asking: ['B-0001'], ready: ['B-0002'], waiting: ['B-0003'], review: ['B-0004'], plan: ['B-0005'], blocked: ['B-0006'], building: ['B-0007'], done: ['B-0008'] });
  assert.deepEqual(b.decisions.map((d) => [d.item, d.kind]), [['B-0005', 'plan'], ['B-0001', 'answer'], ['B-0004', 'review'], ['B-0006', 'blocked']]);
  assert.equal(b.tokens.today, 1500);
  const text = formatBoard(b, now);
  assert.match(text, /Team: not running/);
  assert.match(text, /Waiting for you \(4\)[\s\S]*B-0005 Item 5 \[plan, 5h\][\s\S]*asf approve B-0005[\s\S]*B-0004 Item 4 \[review, 3h\]: review the change; it touches src\/keys\//);
  assert.match(text, /Tokens: 1\.5k today/);
});

test('with a tracker, decisions are replies on the ticket; merged items wait for a release', () => {
  const project = join(root, '.factory/project.yaml');
  writeFileSync(project, readFileSync(project, 'utf8') + 'integration_branch: next\ntracker:\n  kind: jira\n  project: AI\n  owner: acc\n');
  item(1, 'ready', 'tracker: AI-3\n');
  item(2, 'ready');
  const p = openProduct();
  saveState(p.paths.state, { items: { 'B-0001': st('review', '2026-11-07T09:00:00.000Z'), 'B-0002': st('merged', '2026-11-07T08:00:00.000Z') } });
  const b = board(p);
  assert.deepEqual(b.decisions.map((d) => [d.item, d.kind, d.how]), [
    ['B-0002', 'release', 'asf release'],
    ['B-0001', 'review', 'reply on AI-3: "/approve" or "/reject <reason>"'],
  ]);
});

test('a running team shows what it is doing, and its heartbeat goes when it stops', async () => {
  item(1, 'ready');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  const p = openProduct();
  let seen: string[] | undefined;
  const rt: Runtime = {
    name: 'claude-code',
    async call(c) {
      seen ??= readHeartbeat(p.paths.factory)?.running;
      if (c.access === 'write' && !c.writeOnly) writeFileSync(join(c.cwd, 'out.txt'), 'x');
      return { ok: true, text: '', structured: { verdict: 'pass', criteria: [], findings: [], summary: 'ok' }, tokens: { input: 1, cached_input: 0, output: 1, total: 2 }, durationMs: 1 };
    },
    interactive: async () => 0,
  };
  await serve({ rounds: 3, sleep: () => new Promise((r) => setTimeout(r, 5)), context: { runtime: () => rt } });
  assert.deepEqual(seen, ['B-0001']);
  assert.equal(readHeartbeat(p.paths.factory), undefined);
});
