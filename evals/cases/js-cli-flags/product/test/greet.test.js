import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('greets the world', () => {
  const r = spawnSync(process.execPath, ['bin/greet.js'], { encoding: 'utf8' });
  assert.equal(r.stdout, 'Hello, world!\n');
});
