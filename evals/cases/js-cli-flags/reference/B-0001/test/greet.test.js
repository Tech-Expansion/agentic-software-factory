import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const greet = (...args) => spawnSync(process.execPath, ['bin/greet.js', ...args], { encoding: 'utf8' });

test('AC-001 greets the world', () => assert.equal(greet().stdout, 'Hello, world!\n'));
test('AC-002 greets a name', () => assert.equal(greet('--name', 'Lan').stdout, 'Hello, Lan!\n'));
test('AC-003 shouts', () => assert.equal(greet('--shout', '--name', 'Lan').stdout, 'HELLO, LAN!\n'));
test('AC-005 unknown option', () => assert.equal(greet('--loud').status, 2));
