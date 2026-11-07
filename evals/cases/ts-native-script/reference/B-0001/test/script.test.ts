import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, parseScript, requiredSigners } from '../src/script.ts';

const k = (n: number) => n.toString(16).padStart(56, '0');

test('AC-001..AC-006 smoke', () => {
  const s = parseScript({ type: 'atLeast', required: 2, scripts: [1, 2, 3].map((n) => ({ type: 'sig', keyHash: k(n) })) });
  assert.equal(evaluate(s, { signers: [k(1), k(3)] }), true);
  assert.deepEqual(requiredSigners(s, {}), [k(1), k(2)]);
});
