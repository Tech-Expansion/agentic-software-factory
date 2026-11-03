import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { nextReady, parseItem, setStatus } from './backlog.js';
import { loadDefaultPolicy, mergePolicy, validate } from './config.js';
import { verdictFails } from './engine.js';
import { matchesAny } from './glob.js';
import { factoryRoot } from './paths.js';
import { claudeArgs, parseClaudeOutput } from './runtimes/claude.js';
import { codexArgs, parseCodexEvents } from './runtimes/codex.js';
import type { AgentCall } from './runtimes/types.js';

test('glob: ** spans directories, * stays in one segment', () => {
  assert.equal(matchesAny('.factory/project.yaml', ['.factory/**']), '.factory/**');
  assert.equal(matchesAny('web/package.json', ['**/package.json']), '**/package.json');
  assert.equal(matchesAny('package.json', ['**/package.json']), '**/package.json');
  assert.equal(matchesAny('specs/a/b.md', ['specs/*.md']), undefined);
  assert.equal(matchesAny('src/factory.ts', ['.factory/**']), undefined);
});

test('policy: a product policy can only tighten the default', () => {
  const base = loadDefaultPolicy();
  const merged = mergePolicy(base, { max_attempts: 99, max_tokens_per_item: 10, denied_commands: ['npm publish'] });
  assert.equal(merged.max_attempts, base.max_attempts);
  assert.equal(merged.max_tokens_per_item, 10);
  assert.ok(merged.denied_commands.includes('git push'));
  assert.ok(merged.denied_commands.includes('npm publish'));
});

test('template project.yaml is valid once filled in', () => {
  const text = readFileSync(join(factoryRoot, 'templates/product/.factory/project.yaml'), 'utf8')
    .replaceAll('{{name}}', 'demo')
    .replaceAll('{{factory_version}}', '0.1.0');
  assert.deepEqual(validate('project', parse(text)), []);
});

const item = (id: string, extra: string) =>
  parseItem(`${id}.md`, `---\nid: ${id}\ntitle: t ${id}\n${extra}\n---\nbody`).item!;

test('backlog: next ready item respects status, dependencies, priority and run state', () => {
  const items = [
    item('B-0001', 'status: done'),
    item('B-0002', 'status: ready\npriority: 2'),
    item('B-0003', 'status: ready\npriority: 1\ndepends_on: [B-0004]'),
    item('B-0004', 'status: draft'),
    item('B-0005', 'status: ready\npriority: 1'),
  ];
  assert.equal(nextReady(items, { items: {} })?.id, 'B-0005');
  const busy = { state: 'review' as const, branch: '', worktree: '', attempts: 1, tokens: 0, updated_at: '' };
  assert.equal(nextReady(items, { items: { 'B-0005': busy } })?.id, 'B-0002');
  assert.equal(nextReady(items, { items: { 'B-0005': { ...busy, state: 'rework' } } })?.id, 'B-0005');
});

test('backlog: invalid front matter is reported, status is rewritten in place', () => {
  assert.match(parseItem('x.md', '---\nid: X\ntitle: t\nstatus: ready\n---\n').errors.join(), /pattern/);
  const file = join(mkdtempSync(join(tmpdir(), 'asf-')), 'b.md');
  writeFileSync(file, '---\nid: B-0001\ntitle: t\nstatus: ready\n---\nkeep: this\nstatus: here\n');
  setStatus(file, 'done');
  assert.equal(readFileSync(file, 'utf8'), '---\nid: B-0001\ntitle: t\nstatus: done\n---\nkeep: this\nstatus: here\n');
});

const call = (over: Partial<AgentCall> = {}): AgentCall => ({
  cwd: '/w',
  systemPrompt: 'sys',
  prompt: 'p',
  access: 'write',
  allowedCommands: ['npm test'],
  deniedCommands: ['git push'],
  protectedPaths: ['specs/**'],
  ...over,
});

test('claude adapter: never --bare, write tools only with write access, denials passed on', () => {
  const w = claudeArgs(call());
  assert.ok(!w.includes('--bare'));
  const allowed = w[w.indexOf('--allowedTools') + 1]!;
  assert.match(allowed, /Edit/);
  assert.match(allowed, /Bash\(npm test:\*\)/);
  assert.match(w[w.indexOf('--disallowedTools') + 1]!, /Bash\(git push:\*\).*Edit\(specs\/\*\*\)/);
  const r = claudeArgs(call({ access: 'read', schema: { type: 'object' } }));
  assert.doesNotMatch(r[r.indexOf('--allowedTools') + 1]!, /Edit|npm test/);
  assert.equal(r[r.indexOf('--json-schema') + 1], '{"type":"object"}');
});

test('claude adapter: usage and structured output are read from the result', () => {
  const out = parseClaudeOutput(
    JSON.stringify({
      is_error: false,
      subtype: 'success',
      result: '{"verdict":"pass"}',
      structured_output: { verdict: 'pass' },
      total_cost_usd: 0.01,
      usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 10 },
      permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'node --test | tail' } }],
    }),
  );
  assert.equal(out.ok, true);
  assert.deepEqual(out.denied, ['Bash: node --test | tail']);
  assert.deepEqual(out.tokens, { input: 102, cached_input: 50, output: 10, total: 162 });
  assert.deepEqual(out.structured, { verdict: 'pass' });
  assert.equal(parseClaudeOutput('not json').ok, false);
});

test('codex adapter: sandbox follows access, usage is summed over turns', () => {
  const a = codexArgs(call({ access: 'read' }), '/tmp/last', '/tmp/schema.json');
  assert.equal(a[a.indexOf('-s') + 1], 'read-only');
  assert.equal(a[a.indexOf('--output-schema') + 1], '/tmp/schema.json');
  assert.equal(a.at(-1), '-');
  const ev = parseCodexEvents(
    [
      'Reading additional input from stdin...',
      '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":16,"reasoning_output_tokens":4}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
    ].join('\n'),
  );
  assert.deepEqual(ev.tokens, { input: 600, cached_input: 400, output: 20, total: 1020 });
  assert.equal(ev.lastText, 'done');
  assert.equal(ev.error, undefined);
});

test('verdict: pass is not taken on trust', () => {
  const ok = { verdict: 'pass' as const, criteria: [{ id: 'AC-001', status: 'met' as const, evidence: 't' }], findings: [], summary: 's' };
  assert.equal(verdictFails(ok), undefined);
  assert.match(verdictFails({ ...ok, criteria: [{ id: 'AC-001', status: 'not_met', evidence: 'missing' }] })!, /AC-001 not_met/);
  assert.match(verdictFails({ ...ok, findings: [{ severity: 'blocker', message: 'leaks a key' }] })!, /blocker/);
  assert.equal(verdictFails({ ...ok, findings: [{ severity: 'minor', message: 'naming' }] }), undefined);
});
