import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daysBetween } from '../src/dates.js';

test('AC-001 signed calendar days', () => {
  assert.equal(daysBetween('2026-01-01', '2026-01-31'), 30);
  assert.equal(daysBetween('2026-03-10', '2026-03-01'), -9);
  assert.equal(daysBetween('2026-05-05', '2026-05-05'), 0);
  assert.equal(daysBetween('2025-12-31', '2026-01-01'), 1);
});

test('AC-002 across daylight saving changes', () => {
  // New York moves its clocks on 2026-03-08 and 2026-11-01; Lord Howe by half an hour on 2026-04-05 and 2026-10-04.
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.equal(daysBetween('2026-10-31', '2026-11-02'), 2);
  assert.equal(daysBetween('2026-04-04', '2026-04-06'), 2);
  assert.equal(daysBetween('2026-10-03', '2026-10-05'), 2);
  assert.equal(daysBetween('2026-01-01', '2027-01-01'), 365);
});

test('AC-003 only real dates in YYYY-MM-DD form', () => {
  for (const bad of ['2026-02-30', '2026-2-3', '03/04/2026', '2026-13-01', '2026-00-10', '2026-01-01T00:00:00Z', ' 2026-01-01']) {
    assert.throws(() => daysBetween(bad, '2026-01-01'), (e) => e instanceof RangeError && e.message.includes(bad), bad);
    assert.throws(() => daysBetween('2026-01-01', bad), RangeError, bad);
  }
  assert.throws(() => daysBetween('', '2026-01-01'), RangeError);
  for (const bad of [undefined, null, 20260101, new Date('2026-01-01')]) {
    assert.throws(() => daysBetween(bad, '2026-01-01'), RangeError, String(bad));
  }
});

test('AC-004 leap years', () => {
  assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2);
  assert.equal(daysBetween('2023-02-28', '2023-03-01'), 1);
  assert.equal(daysBetween('2024-02-29', '2024-03-01'), 1);
  assert.throws(() => daysBetween('2023-02-29', '2023-03-01'), RangeError);
  assert.equal(daysBetween('2000-02-28', '2000-03-01'), 2);
  assert.equal(daysBetween('1900-02-28', '1900-03-01'), 1);
});
