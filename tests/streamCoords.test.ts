import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapToStreamCoords } from '../src/lib/streamCoords.js';

const box = { left: 100, top: 50, width: 400, height: 400 };

test('maps corners and center of an unletterboxed box', () => {
  assert.deepEqual(mapToStreamCoords(100, 50, box), { nx: 0, ny: 0 });
  assert.deepEqual(mapToStreamCoords(500, 450, box), { nx: 1, ny: 1 });
  assert.deepEqual(mapToStreamCoords(300, 250, box), { nx: 0.5, ny: 0.5 });
});

test('excludes horizontal letterbox bars for a wide image', () => {
  // 16:9 image in a square box -> rendered 400x225, vertically centered (top bar 87.5px).
  const natural = { width: 1920, height: 1080 };
  assert.deepEqual(mapToStreamCoords(100, 50 + 87.5, box, natural), { nx: 0, ny: 0 });
  assert.deepEqual(mapToStreamCoords(500, 50 + 87.5 + 225, box, natural), { nx: 1, ny: 1 });
  // Taps inside the bars clamp to the edge.
  assert.equal(mapToStreamCoords(300, 60, box, natural).ny, 0);
});

test('excludes vertical letterbox bars for a tall image', () => {
  const natural = { width: 1080, height: 1920 };
  const renderedWidth = 400 * (1080 / 1920); // 225
  const left = 100 + (400 - renderedWidth) / 2;
  assert.deepEqual(mapToStreamCoords(left, 50, box, natural), { nx: 0, ny: 0 });
  assert.equal(mapToStreamCoords(left + renderedWidth / 2, 250, box, natural).nx, 0.5);
});

test('degenerate sizes do not produce NaN', () => {
  const r = mapToStreamCoords(10, 10, { left: 0, top: 0, width: 0, height: 0 }, { width: 0, height: 0 });
  assert.deepEqual(r, { nx: 0, ny: 0 });
});
