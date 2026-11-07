import assert from 'node:assert/strict';
import { test } from 'node:test';
import { squish } from '../src/text.js';

test('squish', () => assert.equal(squish('  a \n b  '), 'a b'));
