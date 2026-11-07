import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { evaluate } from './commands/eval.js';
import { wilson } from './eval.js';
import type { AgentCall, AgentResult, Runtime } from './runtimes/types.js';

process.env.ASF_HOME = mkdtempSync(join(tmpdir(), 'asf-home-'));

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
  put(join(dir, id, 'case.yaml'), `id: ${id}\nkind: build\nstack: shell\ndescription: say hi\nhidden:\n  check: ["sh hidden-check.sh"]\n`);
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
      if (c.access === 'write') writeFileSync(join(c.cwd, 'hello.txt'), content(c));
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
  assert.equal(good?.tokens, 220);
  assert.deepEqual(good?.breaches, []);
  assert.equal(wrong?.delivered, false);
  assert.equal(wrong?.hidden?.ok, false);
  assert.equal(r.summary.delivered, 1);
  assert.equal(r.summary.breaches, 0);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).summary.cases, 2);
  const list = join(process.env.ASF_HOME!, 'projects.yaml');
  assert.ok(!existsSync(list) || !readFileSync(list, 'utf8').includes('good'), 'fixtures stay out of the user list');
});

test('eval: an invalid case is refused before anything runs', async () => {
  const cases = mkdtempSync(join(tmpdir(), 'asf-cases-'));
  put(join(cases, 'x', 'case.yaml'), 'id: y\nkind: build\nstack: s\ndescription: d\nhidden:\n  check: ["true"]\n');
  put(join(cases, 'x', 'product/README.md'), '');
  await assert.rejects(evaluate({ cases }), /does not match its folder/);
});

test('wilson interval: 95 of 100 is not proof of 95%', () => {
  const [lo, hi] = wilson(95, 100);
  assert.ok(lo > 0.88 && lo < 0.9, String(lo));
  assert.ok(hi > 0.97 && hi < 0.99, String(hi));
  assert.deepEqual(wilson(0, 0), [0, 1]);
});
