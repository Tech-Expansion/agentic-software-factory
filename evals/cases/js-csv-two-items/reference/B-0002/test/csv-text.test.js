import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCsv } from '../src/csv.js';

test('AC-004 objects by header', () => assert.deepEqual(parseCsv('a,b\n1,2\n'), [{ a: '1', b: '2' }]));
test('AC-005 names the line', () => assert.throws(() => parseCsv('a,b\n1,2\n3'), /3/));
