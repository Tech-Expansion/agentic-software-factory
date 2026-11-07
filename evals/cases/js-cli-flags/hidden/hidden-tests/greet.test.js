import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const greet = (...args) => spawnSync(process.execPath, ['bin/greet.js', ...args], { encoding: 'utf8' });
const usageError = (r, mention) => {
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, '');
  const lines = r.stderr.trim().split('\n');
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0], /^greet: /);
  if (mention) assert.ok(lines[0].includes(mention), lines[0]);
};

test('AC-001 no options', () => {
  const r = greet();
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'Hello, world!\n');
});

test('AC-002 --name in both forms', () => {
  assert.equal(greet('--name', 'Lan').stdout, 'Hello, Lan!\n');
  assert.equal(greet('--name=Lan').stdout, 'Hello, Lan!\n');
  assert.equal(greet('--name', 'Nguyễn Văn A').stdout, 'Hello, Nguyễn Văn A!\n');
  usageError(greet('--name'));
});

test('AC-003 --shout in any order', () => {
  assert.equal(greet('--name', 'Lan', '--shout').stdout, 'HELLO, LAN!\n');
  assert.equal(greet('--shout', '--name', 'Lan').stdout, 'HELLO, LAN!\n');
  assert.equal(greet('--shout').stdout, 'HELLO, WORLD!\n');
});

test('AC-004 help', () => {
  for (const flag of ['--help', '-h']) {
    const r = greet(flag);
    assert.equal(r.status, 0);
    for (const opt of ['--name', '--shout', '--help']) assert.ok(r.stdout.includes(opt), `${flag} mentions ${opt}`);
  }
});

test('AC-005 usage errors', () => {
  usageError(greet('--loud'), '--loud');
  assert.equal(greet('--loud').stderr, 'greet: unknown option --loud\n');
  usageError(greet('--name', 'Lan', '--whisper'), '--whisper');
  usageError(greet('extra'));
});

test('AC-006 standard library only', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  assert.doesNotMatch(readFileSync('bin/greet.js', 'utf8'), /from ['"](?!node:)[^'".][^'"]*['"]/);
});
