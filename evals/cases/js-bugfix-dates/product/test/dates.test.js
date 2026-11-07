import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daysBetween } from '../src/dates.js';

test('days in January', () => {
  assert.equal(daysBetween('2026-01-01', '2026-01-31'), 30);
});
