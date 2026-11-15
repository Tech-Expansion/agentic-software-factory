import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runChecks } from './checks.js';
import { loadDefaultPolicy, mergePolicy } from './config.js';
import { git } from './git.js';
import { findSecrets, testTampering } from './integrity.js';
import { claudeArgs, claudeEnv, parseClaudeOutput } from './runtimes/claude.js';
import { codexEnv } from './runtimes/codex.js';
import type { AgentCall } from './runtimes/types.js';
import { claudeSandbox, hasSrt, requireSandbox, sandboxUnavailable, scrubEnv, srtSettings, toolchainEnv } from './sandbox.js';

const policy = loadDefaultPolicy();
/** The sandbox policy with the sandbox on, and off, whatever the environment of this test run says. */
const on = { ...policy.sandbox, enabled: true };
const off = { ...policy.sandbox, enabled: false };

test('secrets are removed from the environment of agent commands and checks', () => {
  const env = scrubEnv({ PATH: '/bin', HOME: '/h', CLAUDE_CODE_OAUTH_TOKEN: 't', MY_DB_PASSWORD: 'p', JIRA_API_TOKEN: 'j', TZ: 'UTC' }, policy.sandbox.secret_env);
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', TZ: 'UTC' });
});

test('checks never see the runner secrets, even without the sandbox', () => {
  process.env.ASF_PROBE_TOKEN = 'leak';
  try {
    const [r] = runChecks(tmpdir(), ['node -e "process.exit(process.env.ASF_PROBE_TOKEN ? 1 : 0)"'], off);
    assert.equal(r?.ok, true, r?.output);
  } finally {
    delete process.env.ASF_PROBE_TOKEN;
  }
});

test('the sandbox is off until a product or the operator turns it on, and a product cannot turn it off again', () => {
  const saved = process.env.ASF_SANDBOX;
  try {
    delete process.env.ASF_SANDBOX;
    const base = loadDefaultPolicy();
    assert.equal(base.sandbox.enabled, false);
    assert.equal(mergePolicy(base, { sandbox: { enabled: true } }).sandbox.enabled, true);
    process.env.ASF_SANDBOX = '1';
    assert.equal(mergePolicy(loadDefaultPolicy(), { sandbox: { enabled: false } }).sandbox.enabled, true);
  } finally {
    if (saved === undefined) delete process.env.ASF_SANDBOX;
    else process.env.ASF_SANDBOX = saved;
  }
});

test('a sandbox that is on is never quietly left out: native Windows has none, and says how to go on', () => {
  assert.match(sandboxUnavailable('win32')!, /WSL2[\s\S]*sandbox\.enabled/);
  assert.equal(sandboxUnavailable('darwin'), undefined);
  assert.equal(sandboxUnavailable('linux'), undefined);
  assert.doesNotThrow(() => requireSandbox(off));
});

test('checks in the sandbox cannot read credentials or reach other hosts', { skip: !hasSrt() && 'srt is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'asf-sbx-'));
  const [read] = runChecks(dir, [`ls ${join(homedir(), '.ssh')} || ls ${join(homedir(), '.claude')}`], on);
  assert.equal(read?.ok, false, 'credentials stay unreadable');
  const [net] = runChecks(dir, ['curl -s -m 5 -o /dev/null https://example.com'], on);
  assert.equal(net?.ok, false, 'no network beyond the allowlist');
  const [write] = runChecks(dir, ['echo ok > out.txt && test -s out.txt'], on);
  assert.equal(write?.ok, true, write?.output);
});

test('checks and agent commands may write to /tmp under its resolved path too', { skip: process.platform === 'win32' && 'Windows has no /tmp' }, () => {
  const real = realpathSync('/tmp');
  for (const settings of [srtSettings(policy.sandbox), claudeSandbox(policy.sandbox)] as { filesystem: { allowWrite: string[] } }[]) {
    assert.ok(settings.filesystem.allowWrite.includes('/tmp'));
    assert.ok(settings.filesystem.allowWrite.includes(real), `${real} is writable`);
  }
});

test('node in the sandbox uses its bundled CA list, not the OS trust store it cannot reach', () => {
  assert.equal(toolchainEnv(policy.sandbox).NODE_USE_SYSTEM_CA, '0');
});

test('checks in the sandbox can reach the npm registry over TLS', { skip: !hasSrt() && 'srt is not installed' }, () => {
  const saved = process.env.NODE_USE_SYSTEM_CA;
  process.env.NODE_USE_SYSTEM_CA = '1';
  try {
    const [r] = runChecks(tmpdir(), ['npm view semver version'], on);
    assert.equal(r?.ok, true, r?.output);
  } finally {
    if (saved === undefined) delete process.env.NODE_USE_SYSTEM_CA;
    else process.env.NODE_USE_SYSTEM_CA = saved;
  }
});

test('checks in the sandbox can write to /tmp', { skip: !hasSrt() && 'srt is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'asf-sbx-'));
  const [r] = runChecks(dir, ['f=$(mktemp /tmp/asf-probe.XXXXXX) && rm "$f"'], on);
  assert.equal(r?.ok, true, r?.output);
});

const call = (over: Partial<AgentCall> = {}): AgentCall => ({
  cwd: '/w',
  systemPrompt: 's',
  prompt: 'p',
  access: 'write',
  allowedCommands: ['npm test'],
  deniedCommands: [],
  protectedPaths: [],
  sandbox: on,
  ...over,
});

test('claude adapter: with the sandbox on, Bash runs in one that fails closed, and Read cannot reach what it hides', () => {
  const args = claudeArgs(call({ hooks: { Stop: [] } }));
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.ok(settings.sandbox.network.allowedDomains.includes('registry.npmjs.org'));
  assert.ok(settings.sandbox.credentials.envVars.some((v: { name: string }) => v.name === 'CLAUDE_CODE_OAUTH_TOKEN'));
  assert.deepEqual(settings.hooks, { Stop: [] });
  assert.equal(settings.sandbox.network.allowLocalBinding, false, 'loopback stays closed unless a product needs it');
  assert.match(args[args.indexOf('--disallowedTools') + 1]!, /Read\(~\/\.claude\/\*\*\)/);
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  const allowed = args[args.indexOf('--allowedTools') + 1]!.split(',');
  assert.ok(allowed.includes('Bash(npm test:*)') && !allowed.includes('Bash'), 'the sandbox, not the allow list, lets other commands run');
});

test('claude adapter: with the sandbox off, a builder runs any command the policy does not deny, and reviewers none', () => {
  const tools = (c: AgentCall, flag: string) => claudeArgs(c)[claudeArgs(c).indexOf(flag) + 1]!.split(',');
  const build = call({ sandbox: off, deniedCommands: ['git push', 'curl'] });
  assert.ok(tools(build, '--allowedTools').includes('Bash'));
  assert.ok(tools(build, '--disallowedTools').includes('Bash(git push:*)') && tools(build, '--disallowedTools').includes('Bash(curl:*)'));
  assert.ok(tools(build, '--disallowedTools').includes('Read(~/.ssh/**)'), 'the Read tool stays out of the credentials either way');
  assert.equal(claudeArgs(build).includes('--settings'), false, 'no sandbox block is sent');
  const review = tools(call({ sandbox: off, access: 'read' }), '--allowedTools');
  assert.ok(!review.includes('Bash') && review.includes('Bash(git diff:*)'), 'a read-only step keeps to reading');
});

test('claude adapter: the toolchain env overrides what the agent inherits, since its settings env does not', () => {
  assert.equal(claudeEnv(call(), { NODE_USE_SYSTEM_CA: '1', PATH: '/bin' }).NODE_USE_SYSTEM_CA, '0');
  assert.equal(claudeEnv(call({ sandbox: off }), { NODE_USE_SYSTEM_CA: '1' }).NODE_USE_SYSTEM_CA, '1');
  assert.equal(claudeEnv(call({ sandbox: undefined }), { NODE_USE_SYSTEM_CA: '1' }).NODE_USE_SYSTEM_CA, '1');
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
