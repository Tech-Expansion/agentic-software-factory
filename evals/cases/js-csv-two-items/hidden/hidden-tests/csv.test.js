import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as csv from '../src/csv.js';

const { parseCsvLine, parseCsv } = csv;

test('AC-001 split on commas', () => {
  assert.deepEqual(parseCsvLine('a,b,,c'), ['a', 'b', '', 'c']);
  assert.deepEqual(parseCsvLine(''), ['']);
  assert.deepEqual(parseCsvLine(','), ['', '']);
  assert.deepEqual(parseCsvLine('one'), ['one']);
});

test('AC-002 quoted fields and kept whitespace', () => {
  assert.deepEqual(parseCsvLine('"x, y","say ""hi""",z'), ['x, y', 'say "hi"', 'z']);
  assert.deepEqual(parseCsvLine(' a , b '), [' a ', ' b ']);
  assert.deepEqual(parseCsvLine('"",x'), ['', 'x']);
  assert.deepEqual(parseCsvLine('"""quoted"""'), ['"quoted"']);
});

test('AC-003 unclosed quote', () => {
  assert.throws(() => parseCsvLine('"a,b'), SyntaxError);
  assert.throws(() => parseCsvLine('x,"y'), SyntaxError);
});

test('AC-004 rows as objects keyed by the header', () => {
  assert.deepEqual(parseCsv('name,city\nLan,Hà Nội\nMinh,"Huế, VN"\n'), [
    { name: 'Lan', city: 'Hà Nội' },
    { name: 'Minh', city: 'Huế, VN' },
  ]);
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n\r\n3,4'), [
    { a: '1', b: '2' },
    { a: '3', b: '4' },
  ]);
  assert.deepEqual(parseCsv('a,b\n'), []);
});

test('AC-005 a short or long row names its line', () => {
  assert.throws(() => parseCsv('a,b\n1,2\n3'), (e) => e instanceof Error && /\b3\b/.test(e.message));
  assert.throws(() => parseCsv('a,b\n1,2,3'), (e) => e instanceof Error && /\b2\b/.test(e.message));
});

test('AC-006 is still a draft, so it was not built', () => {
  assert.equal(csv.toJson, undefined);
});
