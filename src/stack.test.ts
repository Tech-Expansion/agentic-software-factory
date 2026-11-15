import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { discover } from './commands/discover.js';
import { init } from './commands/init.js';
import { loadProject } from './config.js';
import { git } from './git.js';
import { productPaths } from './paths.js';
import type { AgentCall, AgentResult, Runtime } from './runtimes/types.js';

process.env.ASF_HOME = mkdtempSync(join(tmpdir(), 'asf-home-'));
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'asf test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'asf@example.invalid';

const tokens = { input: 1, cached_input: 0, output: 1, total: 2 };

function team(stack: object): Runtime & { calls: AgentCall[]; sessions: number } {
  const rt = {
    name: 'claude-code' as const,
    calls: [] as AgentCall[],
    sessions: 0,
    async call(c: AgentCall): Promise<AgentResult> {
      rt.calls.push(c);
      return { ok: true, text: '', structured: stack, tokens, durationMs: 1 };
    },
    interactive: async () => (rt.sessions++, 0),
  };
  return rt;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'asf-product-'));
  init(root, 'demo');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  process.chdir(root);
});

test('after discovery, the tech lead chooses the stack, records an ADR and sets the checks', async () => {
  const rt = team({
    decided: true,
    reason: 'People use it on their phones; it must be cheap to run.',
    stack: 'Next.js and TypeScript on Vercel',
    title: 'Next.js on Vercel for the first version',
    adr: '## Context\n\nMostly phones.\n\n## Decision\n\nNext.js.',
    setup: ['test ! -f package.json || npm ci'],
    check: ['npm run lint', 'npm test'],
  });
  const said: string[] = [];
  assert.equal(await discover({ runtime: () => rt, log: (m) => said.push(m) }), 0);
  assert.equal(rt.sessions, 1);
  assert.match(rt.calls[0]!.systemPrompt, /You are the tech lead[\s\S]*# Skill: choose-stack/);
  assert.equal(rt.calls[0]!.access, 'read');
  const adr = readdirSync(join(root, 'docs/adr')).find((f) => /^0001-/.test(f))!;
  assert.equal(adr, '0001-next-js-on-vercel-for-the-first-version.md');
  assert.match(readFileSync(join(root, 'docs/adr', adr), 'utf8'), /^# 0001\. Next\.js on Vercel[\s\S]*Deciders: tech lead[\s\S]*## Decision/);
  const project = loadProject(productPaths(root));
  assert.deepEqual(project.commands, { setup: ['test ! -f package.json || npm ci'], check: ['npm run lint', 'npm test'] });
  assert.match(readFileSync(join(root, '.factory/project.yaml'), 'utf8'), /# Settled in `asf discover`/, 'the comments are kept');
  assert.match(git(root, ['log', '-1', '--format=%s']), /^docs\(adr\): 0001 Next\.js on Vercel/);
  assert.match(said[0]!, /the tech lead chose the stack: Next\.js and TypeScript on Vercel/);

  await discover({ runtime: () => rt, log: () => {} });
  assert.equal(rt.calls.length, 1, 'once the checks are set, the stack is not chosen again');
});

test('the tech lead waits when the brief does not say enough', async () => {
  const rt = team({ decided: false, reason: 'the brief does not say whether people use it on a phone or a computer' });
  const said: string[] = [];
  await discover({ runtime: () => rt, log: (m) => said.push(m) });
  assert.match(said[0]!, /chooses the stack once the brief says more: the brief does not say whether people use it on a phone/);
  assert.deepEqual(loadProject(productPaths(root)).commands.check, []);
});
