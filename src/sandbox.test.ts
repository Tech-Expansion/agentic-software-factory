import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runChecks } from './checks.js';
import { loadDefaultPolicy } from './config.js';
import { git } from './git.js';
import { findSecrets, testTampering } from './integrity.js';
import { claudeArgs, parseClaudeOutput } from './runtimes/claude.js';
import { codexEnv } from './runtimes/codex.js';
import type { AgentCall } from './runtimes/types.js';
import { hasSrt, scrubEnv } from './sandbox.js';

const policy = loadDefaultPolicy();

test('secrets are removed from the environment of agent commands and checks', () => {
  const env = scrubEnv({ PATH: '/bin', HOME: '/h', CLAUDE_CODE_OAUTH_TOKEN: 't', MY_DB_PASSWORD: 'p', JIRA_API_TOKEN: 'j', TZ: 'UTC' }, policy.sandbox.secret_env);
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', TZ: 'UTC' });
});

test('checks never see the runner secrets, even unsandboxed', () => {
  const saved = process.env.ASF_UNSAFE_NO_SANDBOX;
  process.env.ASF_UNSAFE_NO_SANDBOX = '1';
  process.env.ASF_PROBE_TOKEN = 'leak';
  try {
    const [r] = runChecks(tmpdir(), ['test -z "$ASF_PROBE_TOKEN"'], policy.sandbox);
    assert.equal(r?.ok, true, r?.output);
  } finally {
    delete process.env.ASF_PROBE_TOKEN;
    if (saved === undefined) delete process.env.ASF_UNSAFE_NO_SANDBOX;
    else process.env.ASF_UNSAFE_NO_SANDBOX = saved;
  }
});

test('checks in the sandbox cannot read credentials or reach other hosts', { skip: !hasSrt() && 'srt is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'asf-sbx-'));
  const [read] = runChecks(dir, [`ls ${join(homedir(), '.ssh')} || ls ${join(homedir(), '.claude')}`], policy.sandbox);
  assert.equal(read?.ok, false, 'credentials stay unreadable');
  const [net] = runChecks(dir, ['curl -s -m 5 -o /dev/null https://example.com'], policy.sandbox);
  assert.equal(net?.ok, false, 'no network beyond the allowlist');
  const [write] = runChecks(dir, ['echo ok > out.txt && test -s out.txt'], policy.sandbox);
  assert.equal(write?.ok, true, write?.output);
});

const call = (over: Partial<AgentCall> = {}): AgentCall => ({
  cwd: '/w',
  systemPrompt: 's',
  prompt: 'p',
  access: 'write',
  allowedCommands: ['npm test'],
  deniedCommands: [],
  protectedPaths: [],
  sandbox: policy.sandbox,
  ...over,
});

test('claude adapter: Bash runs in a sandbox that fails closed, and Read cannot reach what it hides', () => {
  const saved = process.env.ASF_UNSAFE_NO_SANDBOX;
  delete process.env.ASF_UNSAFE_NO_SANDBOX;
  try {
    const args = claudeArgs(call({ hooks: { Stop: [] } }));
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    assert.equal(settings.sandbox.enabled, true);
    assert.equal(settings.sandbox.failIfUnavailable, true);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.ok(settings.sandbox.network.allowedDomains.includes('registry.npmjs.org'));
    assert.ok(settings.sandbox.credentials.envVars.some((v: { name: string }) => v.name === 'CLAUDE_CODE_OAUTH_TOKEN'));
    assert.deepEqual(settings.hooks, { Stop: [] });
    assert.equal(settings.sandbox.network.allowLocalBinding, false, 'loopback stays closed unless a product needs it');
    assert.equal(settings.env.EnableSourceControlManagerQueries, 'false');
    assert.match(args[args.indexOf('--disallowedTools') + 1]!, /Read\(~\/\.claude\/\*\*\)/);
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  } finally {
    if (saved !== undefined) process.env.ASF_UNSAFE_NO_SANDBOX = saved;
  }
});

test('claude adapter: a tests step may edit test files only', () => {
  const allowed = (c: AgentCall) => claudeArgs(c)[claudeArgs(c).indexOf('--allowedTools') + 1]!.split(',');
  const tests = allowed(call({ writeOnly: ['**/*.test.*', '**/tests/**'] }));
  assert.ok(tests.includes('Edit(**/*.test.*)') && tests.includes('Write(**/tests/**)'));
  assert.ok(!tests.includes('Edit') && !tests.includes('Write'));
  assert.ok(allowed(call()).includes('Edit'));
});

test('claude adapter: the result and the tightest rate limit are read from the stream', () => {
  const stream = [
    { type: 'system', subtype: 'init' },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 100, unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 100 }, seven_day: { utilization: 0.9, resetsAt: 900 } } } },
    { type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: 1, output_tokens: 2 } },
  ].map((l) => JSON.stringify(l)).join('\n');
  const out = parseClaudeOutput(stream);
  assert.equal(out.ok, true);
  assert.equal(out.text, 'done');
  assert.deepEqual(out.rateLimit, { status: 'allowed', resetsAt: 100, utilization: 0.9 });
});

test('codex adapter: starts without secrets but keeps its own sign-in', () => {
  const env = codexEnv(call(), { PATH: '/bin', CODEX_API_KEY: 'c', GITHUB_TOKEN: 'g', CLAUDE_CODE_OAUTH_TOKEN: 'x' });
  assert.deepEqual(env, { PATH: '/bin', CODEX_API_KEY: 'c' });
});

test('secret scan names the place and the kind, never the value', () => {
  const key = ['sk', 'ant', 'oat01', 'A'.repeat(30)].join('-');
  const diff = ['+++ b/src/config.js', '@@ -1,0 +1,2 @@', '+const ok = 1;', `+const t = "${key}";`].join('\n');
  const hits = findSecrets(diff);
  assert.deepEqual(hits, ['src/config.js:2: Anthropic key or token']);
  assert.ok(!hits.join().includes(key));
  assert.deepEqual(findSecrets(diff.replace(key, 'x'), ['const ok']), ['src/config.js:1: policy secret pattern']);
});

test('deleting, skipping or focusing tests is caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asf-tamper-'));
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'asf test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'asf@example.invalid';
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'a.test.js'), "test('a', () => {});\n");
  writeFileSync(join(dir, 'b.test.js'), "test('b', () => {});\n");
  writeFileSync(join(dir, 'src.js'), 'x\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  assert.deepEqual(testTampering(dir, 'main', policy.test_paths), []);
  git(dir, ['rm', '-q', 'b.test.js']);
  writeFileSync(join(dir, 'a.test.js'), "test.skip('a', () => {});\ntest('new', () => {});\n");
  writeFileSync(join(dir, 'src.js'), "it.skip is fine outside tests\n");
  git(dir, ['add', '-A']);
  const found = testTampering(dir, 'main', policy.test_paths);
  assert.equal(found.length, 2, found.join('\n'));
  assert.match(found.join('\n'), /deleted test file b\.test\.js/);
  assert.match(found.join('\n'), /a\.test\.js:1 skips/);
});
