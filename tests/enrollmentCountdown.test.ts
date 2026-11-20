import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCountdown } from '../src/lib/enrollmentCountdown.js';

test('formats minutes and zero-padded seconds', () => {
  assert.equal(formatCountdown(10 * 60 * 1000), '10:00');
  assert.equal(formatCountdown(9 * 60 * 1000 + 42 * 1000), '9:42');
  assert.equal(formatCountdown(5 * 1000), '0:05');
});

test('rounds partial seconds up so it never shows 0:00 while still valid', () => {
  assert.equal(formatCountdown(1), '0:01');
  assert.equal(formatCountdown(59_001), '1:00');
});

test('clamps at 0:00 once expired', () => {
  assert.equal(formatCountdown(0), '0:00');
  assert.equal(formatCountdown(-5000), '0:00');
});
