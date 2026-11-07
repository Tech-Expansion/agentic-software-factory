import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPalindrome, squish } from '../src/text.js';

test('AC-001 palindromes', () => assert.ok(isPalindrome('A man, a plan, a canal: Panama')));
test('AC-002 not palindromes', () => assert.ok(!isPalindrome('hello') && !isPalindrome('')));
test('AC-003 strings only', () => assert.throws(() => isPalindrome(1), TypeError));
test('AC-004 squish', () => assert.equal(squish('  a \n b  '), 'a b'));
