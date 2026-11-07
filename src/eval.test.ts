import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { evaluate, formatEval } from './commands/eval.js';
import { wilson } from './eval.js';
import type { AgentCall, AgentResult, Runtime } from './runtimes/types.js';

process.env.ASF_HOME = mkdtempSync(join(tmpdir(), 'asf-home-'));
// These tests are about the engine's logic; sandbox.test.ts covers the sandbox.
process.env.ASF_UNSAFE_NO_SANDBOX = '1';

const put = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const project = (name: string) => `factory_version: "0.1.0"
name: ${name}
stage: explore
base_branch: main
runtimes:
  default: claude-code
commands:
  check: ["test -f hello.txt"]
opt_ins:
  notifications: none
`;

/** Two items: B-0001 is ready, B-0002 is still a draft and must never be built. */
function makeCase(dir: string, id: string) {
  put(join(dir, id, 'case.yaml'), `id: ${id}\nkind: build\nstack: shell\ndescription: say hi\nsuite: regression\nhidden:\n  check: ["sh hidden-check.sh"]\n`);
  put(join(dir, id, 'product/.factory/project.yaml'), project(id));
  put(join(dir, id, 'product/specs/hello.md'), '# Hello\n\n## Acceptance criteria\n- AC-001: hello.txt says hi.\n');
  put(join(dir, id, 'product/backlog/0001-hello.md'), '---\nid: B-0001\ntitle: Say hi\nstatus: ready\nspec: specs/hello.md\ncriteria: [AC-001]\n---\nWrite hi to hello.txt.\n');
  put(join(dir, id, 'product/backlog/0002-later.md'), '---\nid: B-0002\ntitle: Later\nstatus: draft\n---\nNot yet.\n');
  put(join(dir, id, 'hidden/hidden-check.sh'), 'test "$(cat hello.txt)" = hi\n');
}

const pass = { verdict: 'pass', criteria: [{ id: 'AC-001', status: 'met', evidence: 'ok' }], findings: [], summary: 'ok' };

/** Writes whatever `content` says into hello.txt, and the verifier always passes it. */
function fake(content: (c: AgentCall) => string): Runtime {
  return {
    name: 'claude-code',
    async call(c): Promise<AgentResult> {
      if (c.writeOnly) writeFileSync(join(c.cwd, 'hello.test.js'), '// AC-001\n');
      else if (c.access === 'write') writeFileSync(join(c.cwd, 'hello.txt'), content(c));
      return { ok: true, text: 'done', structured: pass, tokens: { input: 100, cached_input: 0, output: 10, total: 110 }, durationMs: 1 };
    },
    interactive: async () => 0,
  };
}

test('eval: hidden tests decide delivery, drafts are left alone, results are written', async () => {
  const cases = mkdtempSync(join(tmpdir(), 'asf-cases-'));
  makeCase(cases, 'good');
  makeCase(cases, 'wrong');
  const out = join(mkdtempSync(join(tmpdir(), 'asf-out-')), 'r.json');
  // The product's own check passes in both cases; only the hidden check can tell them apart.
  const rt = fake((c) => (c.cwd.includes('asf-eval-good-') ? 'hi' : 'hello'));
  const r = await evaluate({ cases, out, context: { runtime: () => rt } });

  const [good, wrong] = r.cases;
  assert.equal(good?.delivered, true, good?.error ?? good?.hidden?.output);
  assert.equal(good?.firstAttempt, true);
  assert.deepEqual(good?.items, [{ id: 'B-0001', state: 'done', attempts: 1, reason: undefined }]);
  assert.equal(good?.tokens, 330, 'tests, build and verify');
  assert.deepEqual(good?.breaches, []);
  assert.equal(wrong?.delivered, false);
  assert.equal(wrong?.hidden?.ok, false);
  assert.equal(r.summary.delivered, 1);
  assert.equal(r.summary.breaches, 0);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).summary.cases, 2);
  const list = join(process.env.ASF_HOME!, 'projects.yaml');
  assert.ok(!existsSync(list) || !readFileSync(list, 'utf8').includes('good'), 'fixtures stay out of the user list');
});

test('eval: trials give pass^k and pass@k per suite, and transcripts are kept', async () => {
  const cases = mkdtempSync(join(tmpdir(), 'asf-cases-'));
  makeCase(cases, 'steady');
  makeCase(cases, 'flaky');
  const out = join(mkdtempSync(join(tmpdir(), 'asf-out-')), 'r.json');
  let flakyWrites = 0;
  const rt: Runtime = {
    name: 'claude-code',
    async call(c): Promise<AgentResult> {
      if (c.access === 'write' && !c.writeOnly) {
        const flaky = c.cwd.includes('asf-eval-flaky-');
        writeFileSync(join(c.cwd, 'hello.txt'), flaky && ++flakyWrites > 1 ? 'hello' : 'hi');
      }
      return { ok: true, text: 'done', structured: pass, tokens: { input: 1, cached_input: 0, output: 1, total: 2 }, durationMs: 1, transcript: '{"type":"result"}\n' };
    },
    interactive: async () => 0,
  };
  const r = await evaluate({ cases, out, trials: 3, context: { runtime: () => rt } });
  assert.equal(r.summary.runs, 6);
  assert.equal(r.summary.trials, 3);
  assert.deepEqual(r.summary.suites.regression && { all: r.summary.suites.regression.passAll, any: r.summary.suites.regression.passAny }, { all: 1, any: 2 });
  assert.deepEqual(r.cases.map((c) => `${c.id}#${c.trial}:${c.delivered}`), ['flaky#1:true', 'flaky#2:false', 'flaky#3:false', 'steady#1:true', 'steady#2:true', 'steady#3:true']);
  const t = r.cases[0]!.transcripts!;
  assert.match(t, /r-transcripts\/flaky-t1$/);
  assert.equal(readFileSync(join(t, 'B-0001', 'a1-build.jsonl'), 'utf8'), '{"type":"result"}\n');
  assert.ok(existsSync(join(t, 'B-0001', 'a1-tests.jsonl')));
});

test('eval: a usage limit stops the run, which is marked incomplete and never scored as failures', async () => {
  const cases = mkdtempSync(join(tmpdir(), 'asf-cases-'));
  makeCase(cases, 'a-first');
  makeCase(cases, 'b-limited');
  makeCase(cases, 'c-never');
  const good = fake(() => 'hi');
  let ran = 0;
  const rt: Runtime = {
    name: 'claude-code',
    async call(c): Promise<AgentResult> {
      ran++;
      if (c.cwd.includes('asf-eval-a-first-')) return good.call(c);
      return { ok: false, text: '', tokens: { input: 0, cached_input: 0, output: 0, total: 0 }, durationMs: 1, error: "You've hit your 5-hour limit · resets 4:10pm" };
    },
    interactive: async () => 0,
  };
  const r = await evaluate({ cases, trials: 2, out: join(mkdtempSync(join(tmpdir(), 'asf-out-')), 'r.json'), context: { runtime: () => rt } });
  assert.deepEqual(r.cases.map((c) => `${c.id}#${c.trial}`), ['a-first#1', 'a-first#2']);
  assert.match(r.incomplete!, /^stopped at b-limited trial 1 by a usage limit: paused by a usage limit in tests: You've hit your 5-hour limit/);
  assert.match(formatEval(r), /INCOMPLETE, not a baseline/);
  assert.equal(ran, 6 + 2, 'two full runs, then the limited case twice (run retries a paused item once), then nothing');
});

test('eval: a clarify case is scored on the gaps it covers, and nothing is built', async () => {
  const cases = mkdtempSync(join(tmpdir(), 'asf-cases-'));
  for (const id of ['clear', 'vague']) {
    put(join(cases, id, 'case.yaml'), `id: ${id}\nkind: clarify\nstack: none\ndescription: d\nsuite: capability\ngaps:\n  - { id: g1, gap: platform }\n  - { id: g2, gap: recovery }\nsettled: [preprod]\n`);
    put(join(cases, id, 'product/.factory/project.yaml'), project(id));
    put(join(cases, id, 'product/backlog/0001-x.md'), '---\nid: B-0001\ntitle: X\nstatus: new\n---\nA wallet on preprod.\n');
  }
  const judged: string[] = [];
  const rt: Runtime = {
    name: 'claude-code',
    async call(c): Promise<AgentResult> {
      const tokens = { input: 1, cached_input: 0, output: 1, total: 2 };
      if (c.systemPrompt.startsWith('You score')) {
        judged.push(c.prompt);
        const vague = c.cwd.includes('asf-eval-vague-');
        const structured = { gaps: [{ id: 'g1', covered: 'asked', by: ['Q1'] }, { id: 'g2', covered: vague ? 'missed' : 'assumed', by: [] }], needless: vague ? [{ question: 'Q2', reason: 'preprod is settled' }] : [] };
        return { ok: true, text: '', structured, tokens, durationMs: 1 };
      }
      assert.equal(c.access, 'read', 'only the analyst and the judge run');
      const structured = { understood: 'a wallet', questions: [{ id: 'Q1', question: 'Which platform?', why: 'stack', options: [], recommendation: 'web', blocking: true }], assumptions: ['recovery by a backup key'] };
      return { ok: true, text: '', structured, tokens, durationMs: 1 };
    },
    interactive: async () => 0,
  };
  const r = await evaluate({ cases, context: { runtime: () => rt } });
  const [clear, vague] = r.cases;
  assert.deepEqual(clear?.clarify, { gaps: 2, asked: 1, assumed: 1, missed: [], needless: [], questions: 1 });
  assert.equal(clear?.delivered, true, clear?.error);
  assert.equal(clear?.tokens, 2, 'the judge is not counted as the factory');
  assert.deepEqual(vague?.clarify?.missed, ['g2']);
  assert.equal(vague?.delivered, false);
  assert.match(judged[0]!, /g2: recovery[\s\S]*- preprod[\s\S]*Q1 \[blocking\]: Which platform\?[\s\S]*A1: recovery by a backup key/);
});

test('eval: an invalid case is refused before anything runs', async () => {
  const cases = mkdtempSync(join(tmpdir(), 'asf-cases-'));
  put(join(cases, 'x', 'case.yaml'), 'id: y\nkind: build\nstack: s\ndescription: d\nsuite: regression\nhidden:\n  check: ["true"]\n');
  put(join(cases, 'x', 'product/README.md'), '');
  await assert.rejects(evaluate({ cases }), /does not match its folder/);
});

test('wilson interval: 95 of 100 is not proof of 95%', () => {
  const [lo, hi] = wilson(95, 100);
  assert.ok(lo > 0.88 && lo < 0.9, String(lo));
  assert.ok(hi > 0.97 && hi < 0.99, String(hi));
  assert.deepEqual(wilson(0, 0), [0, 1]);
});
