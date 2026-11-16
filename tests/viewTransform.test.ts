import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VIEW,
  centerOn,
  clampView,
  contentBounds,
  formatZoom,
  panByPixels,
  stepZoom,
  viewToCss,
  zoomAt,
} from '../src/lib/viewTransform.js';

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('zooming at a focal point keeps that content point under it', () => {
  const v = zoomAt(DEFAULT_VIEW, 2, 0.25, 0.75);
  // Content under (0.25, 0.75) at 1x was (0.25, 0.75); it must still be there at 2x.
  close(v.x + 0.25 / v.zoom, 0.25);
  close(v.y + 0.75 / v.zoom, 0.75);
  const v2 = zoomAt(v, 4, 0.5, 0.5);
  close(v2.x + 0.5 / 4, v.x + 0.5 / 2);
});

test('the whole screen is reachable and nothing beyond it', () => {
  let v = zoomAt(DEFAULT_VIEW, 4, 0.5, 0.5);
  v = panByPixels(v, 100_000, 100_000, 400, 225); // drag far right/down -> left/top edge
  assert.deepEqual([v.x, v.y], [0, 0]);
  v = panByPixels(v, -100_000, -100_000, 400, 225); // far left/up -> right/bottom edge
  close(v.x, 0.75);
  close(v.y, 0.75);
  close(v.x + 1 / v.zoom, 1); // visible region ends exactly at the screen edge
});

test('panning moves by the dragged distance in screen terms', () => {
  const v = panByPixels({ zoom: 2, x: 0.25, y: 0.25 }, -100, 0, 400, 300);
  // Dragging 100 px left in a 400 px viewport at 2x reveals 100/(400*2) = 1/8 more to the right.
  close(v.x, 0.375);
  close(v.y, 0.25);
});

test('zoom limits and clamping', () => {
  assert.equal(zoomAt(DEFAULT_VIEW, 10).zoom, 4);
  assert.equal(zoomAt({ zoom: 2, x: 0.5, y: 0.5 }, 0.2).zoom, 1);
  assert.deepEqual(zoomAt({ zoom: 2, x: 0.5, y: 0.5 }, 1), { zoom: 1, x: 0, y: 0 });
  assert.deepEqual(clampView({ zoom: NaN, x: NaN, y: 5 }), { zoom: 1, x: 0, y: 0 });
});

test('stepZoom walks the presets and snaps from pinch levels', () => {
  assert.equal(stepZoom(1, 1), 1.5);
  assert.equal(stepZoom(1.5, 1), 2);
  assert.equal(stepZoom(4, 1), 4);
  assert.equal(stepZoom(2.4, 1), 3);
  assert.equal(stepZoom(2.4, -1), 2);
  assert.equal(stepZoom(1, -1), 1);
});

test('centerOn and CSS output', () => {
  const v = centerOn({ zoom: 2, x: 0, y: 0 }, 0.9, 0.1);
  assert.deepEqual(v, { zoom: 2, x: 0.5, y: 0 });
  assert.equal(viewToCss({ zoom: 2, x: 0.25, y: 0.5 }), 'translate(-50%, -100%) scale(2)');
  assert.equal(formatZoom(1.5), '1.5×');
  assert.equal(formatZoom(2), '2×');
});

test('contentBounds for letterboxed pictures', () => {
  // 16:9 picture in a tall 9:16 phone box: a centered horizontal band.
  const b = contentBounds(390, 693, 1600, 900);
  close(b.width, 1);
  close(b.height, (390 / 693) / (16 / 9));
  close(b.top, (1 - b.height) / 2);
  // Ultrawide box, 16:9 picture: a centered vertical band.
  const c = contentBounds(2100, 900, 1600, 900);
  close(c.height, 1);
  close(c.width, (16 / 9) / (2100 / 900));
  assert.deepEqual(contentBounds(0, 0, 10, 10), { left: 0, top: 0, width: 1, height: 1 });
});

test('panning stops at the picture, not at the black bars', () => {
  const band = contentBounds(390, 693, 1600, 900); // picture is a horizontal band
  let v = zoomAt(DEFAULT_VIEW, 4, 0.5, 0.5, band);
  v = panByPixels(v, 100_000, 100_000, 390, 693, band);
  close(v.x, 0); // left edge of the picture
  close(v.y, band.top); // top of the picture band, not the top of the box
  v = panByPixels(v, -100_000, -100_000, 390, 693, band);
  close(v.x + 1 / v.zoom, 1);
  close(v.y + 1 / v.zoom, band.top + band.height); // bottom of the picture band
});

test('an axis where the picture fits stays centered', () => {
  const band = contentBounds(390, 693, 1600, 900);
  // At 1.5x the visible height (0.667) is still taller than the band (~0.32): centered vertically.
  const v = panByPixels(zoomAt(DEFAULT_VIEW, 1.5, 0.5, 0.5, band), 0, 5000, 390, 693, band);
  close(v.y + 0.5 / v.zoom, band.top + band.height / 2);
});
