import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeFrame, parseFrame, rewriteFrameHeader, type FrameHeader } from '../src/lib/frameProtocol.js';

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

// Golden vectors shared with the C# agent (agent/windows tests). Regenerate with
// `npx tsx tests/fixtures/frames/generate.ts`.
interface GoldenAccept {
  name: string;
  expect: 'accept';
  version: 1 | 2;
  header: FrameHeader;
  tiles?: Array<{ x: number; y: number; w: number; h: number; data: string }>;
  payload?: string;
  file: string;
}
interface GoldenReject { name: string; expect: 'reject'; reason: string; bytes: string }

const fixtureDir = new URL('./fixtures/frames/', import.meta.url);
const golden: Array<GoldenAccept | GoldenReject> = JSON.parse(readFileSync(new URL('cases.json', fixtureDir), 'utf8')).cases;
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

test('golden frame vectors include valid and malformed cases', () => {
  assert.ok(golden.some((c) => c.expect === 'accept'));
  assert.ok(golden.some((c) => c.expect === 'reject'));
});

for (const c of golden) {
  test(`golden frame vector: ${c.name}`, () => {
    if (c.expect === 'reject') {
      assert.equal(parseFrame(fromHex(c.bytes)), null, c.reason);
      return;
    }
    const expected = new Uint8Array(readFileSync(new URL(c.file, fixtureDir)));
    const payload = c.version === 1
      ? fromHex(c.payload!)
      : c.tiles!.map((t) => ({ x: t.x, y: t.y, w: t.w, h: t.h, data: fromHex(t.data) }));
    assert.deepEqual(encodeFrame(c.version, c.header, payload), expected, 're-encoded bytes match the .bin');

    const parsed = parseFrame(expected);
    assert.ok(parsed, 'valid frame parses');
    assert.equal(parsed.version, c.version);
    if (c.version === 1) {
      assert.equal(parsed.tiles.length, 1);
      assert.deepEqual(expected.subarray(parsed.tiles[0].offset), fromHex(c.payload!));
    } else {
      assert.equal(parsed.tiles.length, c.tiles!.length);
      c.tiles!.forEach((t, i) => {
        const pt = parsed.tiles[i];
        assert.deepEqual([pt.x, pt.y, pt.w, pt.h], [t.x, t.y, t.w, t.h]);
        assert.deepEqual(expected.subarray(pt.offset, pt.offset + pt.length), fromHex(t.data));
      });
    }
  });
}
