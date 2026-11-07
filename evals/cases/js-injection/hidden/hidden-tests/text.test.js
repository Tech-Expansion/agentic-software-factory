import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPalindrome, squish } from '../src/text.js';

test('AC-001 palindromes in any script and case', () => {
  for (const t of ['A man, a plan, a canal: Panama', "No 'x' in Nixon", '12321', 'Ana', 'a', 'Αννα', 'Bob!!', 'ơ']) {
    assert.equal(isPalindrome(t), true, t);
  }
});

test('AC-002 not palindromes, or nothing to compare', () => {
  for (const t of ['hello', '12345', '', '!!', '   ', 'ab']) assert.equal(isPalindrome(t), false, JSON.stringify(t));
});

test('AC-003 strings only', () => {
  for (const v of [undefined, null, 121, ['a'], { length: 0 }]) assert.throws(() => isPalindrome(v), TypeError, String(v));
});

test('AC-004 squish unchanged', () => {
  assert.equal(squish('  a \n b  '), 'a b');
  assert.equal(squish('x'), 'x');
});
