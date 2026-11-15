import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, parseFrame, rewriteFrameHeader } from '../src/lib/frameProtocol.js';

const bytes = (...n: number[]) => new Uint8Array(n);

test('v1 round trip', () => {
  const buf = encodeFrame(1, { hostId: 'a', seq: 3 }, bytes(1, 2, 3));
  const p = parseFrame(buf)!;
  assert.equal(p.version, 1);
  assert.equal(p.isKey, true);
  assert.equal(p.header.seq, 3);
  assert.deepEqual(Array.from(buf.subarray(p.tiles[0].offset, p.tiles[0].offset + p.tiles[0].length)), [1, 2, 3]);
});

test('v2 round trip with tiles', () => {
  const buf = encodeFrame(2, { seq: 9, w: 128, h: 64, key: false }, [
    { x: 0, y: 0, w: 64, h: 64, data: bytes(7, 7) },
    { x: 64, y: 0, w: 64, h: 64, data: bytes(8, 8, 8) },
  ]);
  const p = parseFrame(buf)!;
  assert.equal(p.version, 2);
  assert.equal(p.isKey, false);
  assert.deepEqual(p.header.r, [0, 0, 64, 64, 2, 64, 0, 64, 64, 3]);
  assert.deepEqual(
    p.tiles.map((t) => Array.from(buf.subarray(t.offset, t.offset + t.length))),
    [[7, 7], [8, 8, 8]],
  );
});

test('rejects malformed frames', () => {
  assert.equal(parseFrame(bytes(0x45, 1, 0, 0, 1)), null, 'bad magic');
  assert.equal(parseFrame(bytes(0x44, 9, 0, 0, 1)), null, 'bad version');
  assert.equal(parseFrame(bytes(0x44, 1, 0, 50, 1)), null, 'header longer than buffer');
  const good = encodeFrame(2, { w: 64, h: 64, key: true }, [{ x: 0, y: 0, w: 64, h: 64, data: bytes(1) }]);
  assert.ok(parseFrame(good));
  assert.equal(parseFrame(good.subarray(0, good.length - 1)), null, 'truncated payload');
  const extra = new Uint8Array(good.length + 1);
  extra.set(good);
  assert.equal(parseFrame(extra), null, 'trailing bytes');
  const outOfBounds = encodeFrame(2, { w: 64, h: 64 }, [{ x: 32, y: 0, w: 64, h: 64, data: bytes(1) }]);
  assert.equal(parseFrame(outOfBounds), null, 'tile outside frame');
  const emptyKey = encodeFrame(2, { w: 64, h: 64, key: true }, []);
  assert.equal(parseFrame(emptyKey), null, 'keyframe without tiles');
});

test('rewriteFrameHeader keeps payload and tile layout', () => {
  const buf = encodeFrame(2, { hostId: 'evil', w: 64, h: 64, key: true }, [{ x: 0, y: 0, w: 64, h: 64, data: bytes(5, 6) }]);
  const p = parseFrame(buf)!;
  const out = rewriteFrameHeader(buf, p, { ...p.header, hostId: 'real' })!;
  const q = parseFrame(out)!;
  assert.equal(q.header.hostId, 'real');
  assert.equal(q.version, 2);
  assert.deepEqual(Array.from(out.subarray(q.tiles[0].offset, q.tiles[0].offset + 2)), [5, 6]);
});
