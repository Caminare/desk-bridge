import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sanitizeCursorPosition, sanitizeCursorShape } from '../server/cursorMessages.js';

const rgba = (w: number, h: number) => Buffer.alloc(w * h * 4, 0x7f).toString('base64');

describe('sanitizeCursorShape', () => {
  const valid = { id: 'a1b2c3', w: 32, h: 32, hotX: 0, hotY: 0, rgba: rgba(32, 32) };

  test('accepts a well-formed shape and keeps only known fields', () => {
    assert.deepEqual(sanitizeCursorShape({ ...valid, extra: 'x' }), valid);
  });

  test('accepts the 128x128 maximum and rejects anything larger', () => {
    assert.ok(sanitizeCursorShape({ ...valid, w: 128, h: 128, rgba: rgba(128, 128) }));
    assert.equal(sanitizeCursorShape({ ...valid, w: 129, h: 1, rgba: rgba(129, 1) }), null);
  });

  test('rejects pixel data that does not match w*h*4 bytes', () => {
    assert.equal(sanitizeCursorShape({ ...valid, rgba: rgba(32, 31) }), null);
    assert.equal(sanitizeCursorShape({ ...valid, rgba: rgba(32, 32) + 'AAAA' }), null);
  });

  test('rejects non-base64 pixel data', () => {
    const good = rgba(1, 1); // 8 chars
    assert.equal(sanitizeCursorShape({ ...valid, w: 1, h: 1, rgba: good.replace(/^./, '*') }), null);
  });

  test('rejects hotspots outside the shape', () => {
    assert.equal(sanitizeCursorShape({ ...valid, hotX: 32 }), null);
    assert.equal(sanitizeCursorShape({ ...valid, hotY: -1 }), null);
    assert.ok(sanitizeCursorShape({ ...valid, hotX: 31, hotY: 31 }));
  });

  test('rejects bad ids and non-integer sizes', () => {
    assert.equal(sanitizeCursorShape({ ...valid, id: '' }), null);
    assert.equal(sanitizeCursorShape({ ...valid, id: 'x'.repeat(65) }), null);
    assert.equal(sanitizeCursorShape({ ...valid, id: 'bad id' }), null);
    assert.equal(sanitizeCursorShape({ ...valid, w: 31.5 }), null);
    assert.equal(sanitizeCursorShape({ ...valid, w: 0, rgba: '' }), null);
    assert.equal(sanitizeCursorShape(null), null);
  });
});

describe('sanitizeCursorPosition', () => {
  test('accepts a position and keeps only known fields', () => {
    assert.deepEqual(sanitizeCursorPosition({ x: 0.25, y: 0.75, visible: true, shape: 'a1', extra: 1 }), {
      x: 0.25,
      y: 0.75,
      visible: true,
      shape: 'a1',
    });
  });

  test('allows positions off the streamed monitor within -1..2', () => {
    assert.ok(sanitizeCursorPosition({ x: -1, y: 2, visible: true, shape: null }));
    assert.equal(sanitizeCursorPosition({ x: -1.01, y: 0, visible: true, shape: null }), null);
    assert.equal(sanitizeCursorPosition({ x: 0, y: 2.01, visible: true, shape: null }), null);
  });

  test('rejects non-finite coordinates and a non-boolean visible flag', () => {
    assert.equal(sanitizeCursorPosition({ x: Number.NaN, y: 0, visible: true, shape: null }), null);
    assert.equal(sanitizeCursorPosition({ x: '0.5', y: 0, visible: true, shape: null }), null);
    assert.equal(sanitizeCursorPosition({ x: 0, y: 0, visible: 'yes', shape: null }), null);
  });

  test('a missing or invalid shape id becomes null', () => {
    assert.equal(sanitizeCursorPosition({ x: 0, y: 0, visible: false })!.shape, null);
    assert.equal(sanitizeCursorPosition({ x: 0, y: 0, visible: true, shape: 'bad id' })!.shape, null);
  });
});
