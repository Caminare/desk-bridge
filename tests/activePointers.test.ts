import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerPointerDown, type PointerPoints } from '../src/lib/activePointers.js';

const touch = (pointerId: number, isPrimary: boolean, x = 0, y = 0) => ({ pointerId, x, y, pointerType: 'touch', isPrimary });

test('a second finger joins the first (pinch)', () => {
  const points: PointerPoints = new Map();
  assert.equal(registerPointerDown(points, touch(1, true)), false);
  assert.equal(registerPointerDown(points, touch(2, false, 50, 50)), false);
  assert.equal(points.size, 2);
});

test('a new primary touch drops a finger whose release was never seen', () => {
  const points: PointerPoints = new Map();
  registerPointerDown(points, touch(1, true));
  // pointerup for 1 was lost; the user lifts and touches again with one finger.
  assert.equal(registerPointerDown(points, touch(7, true, 10, 20)), true);
  assert.deepEqual([...points.entries()], [[7, { x: 10, y: 20 }]]);
});

test('mouse and pen pointers never clear the map', () => {
  const points: PointerPoints = new Map();
  registerPointerDown(points, touch(1, true));
  assert.equal(registerPointerDown(points, { pointerId: 2, x: 0, y: 0, pointerType: 'mouse', isPrimary: true }), false);
  assert.equal(points.size, 2);
});

test('nothing to drop on a clean map', () => {
  const points: PointerPoints = new Map();
  assert.equal(registerPointerDown(points, touch(3, true)), false);
  assert.equal(points.size, 1);
});
