import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/slugify.ts';

test('AC-001 removes diacritics', () => assert.equal(slugify('Tiếng Việt'), 'tieng-viet'));
test('AC-002 collapses separators', () => assert.equal(slugify('  Hello,  World!! '), 'hello-world'));
test('AC-003 cuts between words', () => assert.equal(slugify('xin chao the gioi', { maxLength: 12 }), 'xin-chao-the'));
test('AC-004 nothing to keep', () => assert.equal(slugify('!!!'), ''));
