import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LongPressDrag } from '../src/lib/longPressDrag.js';

const make = () => new LongPressDrag({ holdMs: 350, slopPx: 8 });

test('holding still for the hold time starts a drag, once', () => {
  const g = make();
  g.down(100, 100, 0);
  assert.equal(g.tick(349), false);
  assert.equal(g.tick(350), true);
  assert.equal(g.isDragging, true);
  assert.equal(g.tick(400), false, 'already dragging: no second start');
});

test('moving past the slop before the hold time is a normal gesture, never a drag', () => {
  const g = make();
  g.down(100, 100, 0);
  assert.equal(g.move(109, 100, 100), false);
  assert.equal(g.tick(1000), false);
  assert.equal(g.isDragging, false);
  assert.equal(g.up(), false, 'no button to release');
});

test('jitter inside the slop does not cancel the long press', () => {
  const g = make();
  g.down(100, 100, 0);
  assert.equal(g.move(105, 104, 200), false);
  assert.equal(g.tick(350), true);
});

test('slop is measured from the touch-down point, not the last move', () => {
  const g = make();
  g.down(100, 100, 0);
  g.move(106, 100, 50);
  g.move(112, 100, 100); // each step is 6 px, but 12 px from the start
  assert.equal(g.tick(400), false);
});

test('a late timer is covered: the first move after the hold time starts the drag', () => {
  const g = make();
  g.down(100, 100, 0);
  assert.equal(g.move(103, 100, 360), true);
  assert.equal(g.isDragging, true);
});

test('moves while dragging never restart it, however far they go', () => {
  const g = make();
  g.down(0, 0, 0);
  g.tick(350);
  assert.equal(g.move(500, 500, 400), false);
  assert.equal(g.isDragging, true);
});

test('lifting ends the drag and reports that the button must be released', () => {
  const g = make();
  g.down(0, 0, 0);
  g.tick(350);
  assert.equal(g.up(), true);
  assert.equal(g.isDragging, false);
  assert.equal(g.up(), false, 'idempotent');
});

test('lifting before the hold time is a tap: nothing to release', () => {
  const g = make();
  g.down(0, 0, 0);
  assert.equal(g.up(), false);
  assert.equal(g.tick(1000), false, 'a timer firing after the lift does nothing');
});

test('cancel releases an active drag and disarms a pending one', () => {
  const dragging = make();
  dragging.down(0, 0, 0);
  dragging.tick(350);
  assert.equal(dragging.cancel(), true);
  assert.equal(dragging.isDragging, false);

  const pending = make();
  pending.down(0, 0, 0);
  assert.equal(pending.cancel(), false);
  assert.equal(pending.tick(1000), false);
});

test('a new touch-down rearms the gesture', () => {
  const g = make();
  g.down(0, 0, 0);
  g.move(50, 0, 10);
  g.up();
  g.down(10, 10, 1000);
  assert.equal(g.tick(1350), true);
});
