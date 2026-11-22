import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MIN_CURSOR_CSS_PX, cursorBox } from '../src/lib/cursorOverlay.js';
import { FULL_BOUNDS } from '../src/lib/viewTransform.js';

const shape = { w: 32, h: 32, hotX: 4, hotY: 8 };

describe('cursorBox', () => {
  test('places the hotspot at the normalized position inside the picture', () => {
    const box = cursorBox({ x: 0.5, y: 0.25 }, shape, { width: 1000, height: 500 }, FULL_BOUNDS, { width: 2000, height: 1000 }, 1);
    assert.equal(box.leftPct, 50);
    assert.equal(box.topPct, 25);
  });

  test('accounts for letterboxing', () => {
    const bounds = { left: 0.25, top: 0, width: 0.5, height: 1 };
    const box = cursorBox({ x: 0, y: 1 }, shape, { width: 1000, height: 500 }, bounds, { width: 2000, height: 500 }, 1);
    assert.equal(box.leftPct, 25);
    assert.equal(box.topPct, 100);
  });

  test('scales the shape with the picture: a 2x larger picture draws a 2x larger cursor', () => {
    // Picture is 2000 CSS px wide for a 1000 px monitor.
    const box = cursorBox({ x: 0, y: 0 }, shape, { width: 1000, height: 500 }, FULL_BOUNDS, { width: 2000, height: 1000 }, 1);
    assert.equal(box.width, 64);
    assert.equal(box.height, 64);
    assert.equal(box.offsetX, -8);
    assert.equal(box.offsetY, -16);
  });

  test('never draws the cursor smaller than the minimum on screen', () => {
    // A 2560 px monitor on a 400 px wide viewport would make a 32 px cursor 5 px tall.
    const box = cursorBox({ x: 0, y: 0 }, shape, { width: 2560, height: 1440 }, FULL_BOUNDS, { width: 400, height: 225 }, 1);
    assert.equal(box.height, MIN_CURSOR_CSS_PX);
    assert.equal(box.width, MIN_CURSOR_CSS_PX);
    assert.equal(box.offsetY, -MIN_CURSOR_CSS_PX / 4);
  });

  test('sizes are in the zoomed container, so the on-screen size follows zoom with the same minimum', () => {
    const monitor = { width: 1000, height: 500 };
    const vp = { width: 1000, height: 500 };
    // Zoom 2: the picture is 2000 px on screen, so the cursor is 64 px on screen = 32 px in the container.
    const zoomed = cursorBox({ x: 0, y: 0 }, shape, monitor, FULL_BOUNDS, vp, 2);
    assert.equal(zoomed.height * 2, 64);

    // Tiny picture, zoom 4: the on-screen minimum still holds.
    const small = cursorBox({ x: 0, y: 0 }, shape, { width: 4000, height: 2000 }, FULL_BOUNDS, { width: 400, height: 200 }, 4);
    assert.equal(small.height * 4, MIN_CURSOR_CSS_PX);
  });
});
