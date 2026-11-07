import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCsvLine } from '../src/csv.js';

test('AC-001 splits on commas', () => assert.deepEqual(parseCsvLine('a,b,,c'), ['a', 'b', '', 'c']));
test('AC-002 quoted fields', () => assert.deepEqual(parseCsvLine('"x, y","say ""hi""",z'), ['x, y', 'say "hi"', 'z']));
test('AC-003 unclosed quote', () => assert.throws(() => parseCsvLine('"a,b'), SyntaxError));
