import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/slugify.ts';

test('AC-001 lower-case ASCII without diacritics', () => {
  assert.equal(slugify('Tiếng Việt'), 'tieng-viet');
  assert.equal(slugify('Đường Đến Trường'), 'duong-den-truong');
  assert.equal(slugify('Phở bò & Cà phê sữa đá'), 'pho-bo-ca-phe-sua-da');
  assert.equal(slugify('ƯỚC MƠ'), 'uoc-mo');
});

test('AC-002 single separators, none at the ends', () => {
  assert.equal(slugify('  Hello,  World!! '), 'hello-world');
  assert.equal(slugify('C++ / C# --- 2026'), 'c-c-2026');
  assert.equal(slugify('--a--b--'), 'a-b');
});

test('AC-003 cut between words', () => {
  assert.equal(slugify('xin chao the gioi', { maxLength: 12 }), 'xin-chao-the');
  assert.equal(slugify('xin chao the gioi', { maxLength: 10 }), 'xin-chao');
  assert.equal(slugify('xin chao the gioi', { maxLength: 100 }), 'xin-chao-the-gioi');
  assert.equal(slugify('supercalifragilistic word', { maxLength: 5 }), 'super');
  for (let max = 1; max < 20; max++) {
    const s = slugify('Một hai ba bốn năm sáu', { maxLength: max });
    assert.ok(s.length <= max, `${max}: ${s}`);
    assert.ok(!s.endsWith('-') && !s.startsWith('-'), `${max}: ${s}`);
    assert.ok('mot-hai-ba-bon-nam-sau'.startsWith(s), `${max}: ${s}`);
  }
});

test('AC-004 nothing to keep', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify('!!!'), '');
  assert.equal(slugify('   '), '');
});
