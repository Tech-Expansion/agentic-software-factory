import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, parseScript, requiredSigners, ScriptError, type Script } from '../src/script.ts';

/** Key hashes that sort the way their numbers do. */
const k = (n: number) => n.toString(16).padStart(56, '0');
const sig = (n: number): Script => ({ type: 'sig', keyHash: k(n) });
const all = (...scripts: Script[]): Script => ({ type: 'all', scripts });
const any = (...scripts: Script[]): Script => ({ type: 'any', scripts });
const atLeast = (required: number, ...scripts: Script[]): Script => ({ type: 'atLeast', required, scripts });

const pathOf = (json: unknown) => {
  try {
    parseScript(json);
  } catch (e) {
    assert.ok(e instanceof ScriptError, `expected a ScriptError, got ${e}`);
    return e.path;
  }
  assert.fail('expected parseScript to throw');
};

test('AC-001 parses the cardano-cli forms, nested, with key hashes in lower case', () => {
  const upper = 'AB'.repeat(28);
  const json = {
    type: 'all',
    scripts: [
      { type: 'sig', keyHash: upper, note: 'ignored' },
      { type: 'atLeast', required: 1, scripts: [{ type: 'sig', keyHash: k(1) }, { type: 'any', scripts: [] }] },
      { type: 'after', slot: 100 },
      { type: 'before', slot: 0 },
    ],
  };
  assert.deepEqual(parseScript(json), {
    type: 'all',
    scripts: [
      { type: 'sig', keyHash: 'ab'.repeat(28) },
      { type: 'atLeast', required: 1, scripts: [{ type: 'sig', keyHash: k(1) }, { type: 'any', scripts: [] }] },
      { type: 'after', slot: 100 },
      { type: 'before', slot: 0 },
    ],
  });
});

test('AC-002 errors name the offending value', () => {
  assert.equal(pathOf({ type: 'all', scripts: [{ type: 'sig', keyHash: k(1) }, { type: 'nope' }] }), '$.scripts[1].type');
  assert.equal(pathOf({ type: 'any', scripts: [{ type: 'sig', keyHash: 'abc' }] }), '$.scripts[0].keyHash');
  assert.equal(pathOf({ type: 'any', scripts: [{ type: 'sig', keyHash: 'g'.repeat(56) }] }), '$.scripts[0].keyHash');
  assert.equal(pathOf({ type: 'any', scripts: [{ type: 'sig', keyHash: k(1) + '0' }] }), '$.scripts[0].keyHash');
  assert.equal(pathOf({ type: 'all' }), '$.scripts');
  assert.equal(pathOf({ type: 'all', scripts: {} }), '$.scripts');
  assert.equal(pathOf({ type: 'all', scripts: [{ type: 'sig', keyHash: k(1) }, { type: 'sig', keyHash: k(2) }, null] }), '$.scripts[2]');
  assert.equal(pathOf('sig'), '$');
  assert.equal(pathOf({ scripts: [] }), '$.type');
  assert.equal(pathOf({ type: 'atLeast', required: 3, scripts: [{ type: 'sig', keyHash: k(1) }, { type: 'sig', keyHash: k(2) }] }), '$.required');
  assert.equal(pathOf({ type: 'atLeast', required: -1, scripts: [] }), '$.required');
  assert.equal(pathOf({ type: 'atLeast', required: 1.5, scripts: [{ type: 'sig', keyHash: k(1) }, { type: 'sig', keyHash: k(2) }] }), '$.required');
  assert.equal(pathOf({ type: 'atLeast', scripts: [] }), '$.required');
  assert.equal(pathOf({ type: 'any', scripts: [{ type: 'all', scripts: [{ type: 'after', slot: '5' }] }] }), '$.scripts[0].scripts[0].slot');
  assert.equal(pathOf({ type: 'before', slot: -3 }), '$.slot');
});

test('AC-003 all, any and atLeast, empty ones included', () => {
  const tx = { signers: [k(1).toUpperCase(), k(2)] };
  assert.equal(evaluate(sig(1), tx), true, 'signers are compared without regard to case');
  assert.equal(evaluate({ type: 'sig', keyHash: k(2).toUpperCase() }, tx), true);
  assert.equal(evaluate(sig(3), tx), false);
  assert.equal(evaluate(all(), tx), true);
  assert.equal(evaluate(any(), tx), false);
  assert.equal(evaluate(atLeast(0), tx), true);
  assert.equal(evaluate(all(sig(1), sig(2)), tx), true);
  assert.equal(evaluate(all(sig(1), sig(3)), tx), false);
  assert.equal(evaluate(any(sig(3), sig(2)), tx), true);
  assert.equal(evaluate(atLeast(2, sig(1), sig(3), sig(2)), tx), true);
  assert.equal(evaluate(atLeast(3, sig(1), sig(3), sig(2)), tx), false);
  assert.equal(evaluate(atLeast(2, sig(1), sig(1), sig(3)), tx), true, 'each sub-script counts, even with the same key');
});

test('AC-004 time locks need the bound they test', () => {
  const after = { type: 'after', slot: 100 } as const;
  const before = { type: 'before', slot: 200 } as const;
  assert.equal(evaluate(after, { signers: [], validFrom: 100 }), true);
  assert.equal(evaluate(after, { signers: [], validFrom: 99 }), false);
  assert.equal(evaluate(after, { signers: [], validTo: 500 }), false);
  assert.equal(evaluate(before, { signers: [], validTo: 200 }), true);
  assert.equal(evaluate(before, { signers: [], validTo: 201 }), false);
  assert.equal(evaluate(before, { signers: [], validFrom: 0 }), false);
  assert.equal(evaluate(all(after, before), { signers: [], validFrom: 150, validTo: 180 }), true);
  assert.equal(evaluate(any(before, sig(1)), { signers: [k(1)] }), true);
});

test('AC-005 the smallest set, first in order, or null', () => {
  assert.deepEqual(requiredSigners(atLeast(2, sig(3), sig(1), sig(2)), {}), [k(1), k(2)]);
  assert.deepEqual(requiredSigners(any(all(sig(2), sig(3)), all(sig(1), sig(4))), {}), [k(1), k(4)]);
  assert.deepEqual(requiredSigners(any(all(sig(1), sig(2), sig(3)), all(sig(5), sig(4))), {}), [k(4), k(5)], 'smaller before earlier');
  assert.deepEqual(requiredSigners({ type: 'sig', keyHash: k(10).toUpperCase() }, {}), [k(10)]);
  assert.deepEqual(requiredSigners(all({ type: 'after', slot: 10 }, sig(1)), { validFrom: 10 }), [k(1)]);
  assert.equal(requiredSigners(all({ type: 'after', slot: 10 }, sig(1)), { validFrom: 9 }), null);
  assert.equal(requiredSigners(all({ type: 'before', slot: 10 }, sig(1)), {}), null);
  assert.equal(requiredSigners(atLeast(3, sig(1), sig(2)), {}), null);
  assert.deepEqual(requiredSigners(any(sig(1), { type: 'after', slot: 5 }), { validFrom: 6 }), []);
  assert.deepEqual(requiredSigners(all(), {}), []);
  assert.equal(requiredSigners(any(), {}), null);
});

test('AC-006 a key shared between branches counts once', () => {
  const A = sig(1), B = sig(2), C = sig(3), D = sig(4);
  assert.deepEqual(requiredSigners(any(all(A, B), all(A, C), D), {}), [k(4)]);
  assert.deepEqual(requiredSigners(all(any(B, C), any(C, A)), {}), [k(3)]);
  assert.deepEqual(requiredSigners(atLeast(2, all(A, B), all(B, C), all(C, D)), {}), [k(1), k(2), k(3)]);
  assert.deepEqual(requiredSigners(all(atLeast(2, A, B, C), atLeast(2, C, D, B)), {}), [k(2), k(3)]);
});

test('AC-006 twenty keys within a second', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => sig(20 - i));
  const cases: [Script, string[]][] = [
    [atLeast(10, ...twenty), Array.from({ length: 10 }, (_, i) => k(i + 1))],
    [all(...twenty), Array.from({ length: 20 }, (_, i) => k(i + 1))],
    [any(all(...twenty), sig(20)), [k(20)]],
    [all(atLeast(19, ...twenty), any(sig(1), sig(2))), Array.from({ length: 19 }, (_, i) => k(i + 1))],
  ];
  for (const [script, want] of cases) {
    const started = performance.now();
    assert.deepEqual(requiredSigners(script, {}), want);
    assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
  }
});
