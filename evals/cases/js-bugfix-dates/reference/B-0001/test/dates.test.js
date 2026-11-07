import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daysBetween } from '../src/dates.js';

test('AC-001 sign follows the order', () => assert.equal(daysBetween('2026-03-10', '2026-03-01'), -9));
test('AC-003 rejects impossible dates', () => assert.throws(() => daysBetween('2026-02-30', '2026-03-01'), RangeError));
test('AC-004 leap years', () => assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2));
