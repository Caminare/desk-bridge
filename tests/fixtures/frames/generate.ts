/**
 * Regenerates the golden frame vectors shared by the TypeScript and C# codec tests.
 *
 *   npx tsx tests/fixtures/frames/generate.ts
 *
 * `encodeFrame` in src/lib/frameProtocol.ts is the reference: the .bin files are its exact output,
 * and cases.json lets any other implementation re-encode and compare byte for byte.
 * Header objects are written in FrameHeader declaration order (the C# encoder emits that order).
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFrame, type FrameHeader } from '../../../src/lib/frameProtocol.js';

const dir = dirname(fileURLToPath(import.meta.url));
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) if (f.endsWith('.bin')) rmSync(join(dir, f));

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
/** Deterministic fake "JPEG": SOI marker, a counter pattern, EOI marker. */
const jpeg = (len: number, seed: number) => {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (seed + i * 7) & 0xff;
  b[0] = 0xff;
  b[1] = 0xd8;
  b[len - 2] = 0xff;
  b[len - 1] = 0xd9;
  return b;
};

interface Tile { x: number; y: number; w: number; h: number; data: Uint8Array }
interface AcceptCase {
  name: string;
  expect: 'accept';
  version: 1 | 2;
  header: FrameHeader;
  tiles?: Array<{ x: number; y: number; w: number; h: number; data: string }>;
  payload?: string;
  file: string;
}
interface RejectCase { name: string; expect: 'reject'; reason: string; bytes: string }

const cases: Array<AcceptCase | RejectCase> = [];

function v1(name: string, header: FrameHeader, payload: Uint8Array) {
  const buf = encodeFrame(1, header, payload);
  writeFileSync(join(dir, `${name}.bin`), buf);
  cases.push({ name, expect: 'accept', version: 1, header, payload: hex(payload), file: `${name}.bin` });
}

function v2(name: string, header: FrameHeader, tiles: Tile[]) {
  const buf = encodeFrame(2, header, tiles);
  writeFileSync(join(dir, `${name}.bin`), buf);
  cases.push({
    name,
    expect: 'accept',
    version: 2,
    header,
    tiles: tiles.map((t) => ({ x: t.x, y: t.y, w: t.w, h: t.h, data: hex(t.data) })),
    file: `${name}.bin`,
  });
}

/** Hand-assembles a frame without validation so malformed inputs can be produced. */
function raw(version: number, header: string | object, payload: Uint8Array = new Uint8Array(0), headerLen?: number) {
  const hb = new TextEncoder().encode(typeof header === 'string' ? header : JSON.stringify(header));
  const n = headerLen ?? hb.length;
  const out = new Uint8Array(4 + hb.length + payload.length);
  out.set([0x44, version, (n >> 8) & 0xff, n & 0xff]);
  out.set(hb, 4);
  out.set(payload, 4 + hb.length);
  return out;
}

function reject(name: string, reason: string, bytes: Uint8Array) {
  cases.push({ name, expect: 'reject', reason, bytes: hex(bytes) });
}

// ---- Valid frames ---------------------------------------------------------------------------

v1('v1_full_frame', { hostId: 'host-1', seq: 1, activeWindow: 'Notepad', timestamp: 1700000000000 }, jpeg(40, 1));
v1('v1_empty_header', {}, jpeg(12, 2));

v2('v2_keyframe_single_tile', { hostId: 'host-1', seq: 2, activeWindow: 'Desktop', timestamp: 1700000000033, w: 128, h: 96, key: true }, [
  { x: 0, y: 0, w: 128, h: 96, data: jpeg(64, 3) },
]);

v2('v2_delta_multi_tile', { hostId: 'host-1', seq: 3, timestamp: 1700000000066, w: 1600, h: 900, key: false }, [
  { x: 0, y: 0, w: 64, h: 64, data: jpeg(20, 4) },
  { x: 64, y: 0, w: 128, h: 64, data: jpeg(33, 5) },
  { x: 1536, y: 836, w: 64, h: 64, data: jpeg(18, 6) },
]);

v2('v2_delta_no_tiles', { hostId: 'host-1', seq: 4, w: 640, h: 360, key: false }, []);

v2('v2_full_stats', {
  hostId: 'host-1',
  seq: 5,
  activeWindow: 'Visual Studio Code',
  timestamp: 1700000000099,
  w: 1600,
  h: 900,
  key: false,
  stats: {
    cap: 12.5,
    enc: 3.25,
    rtt: 48,
    kbps: 8123.75,
    q: 80,
    mw: 1600,
    ch: 7,
    tt: 225,
    inf: 3,
    brtt: 31.5,
    win: 256,
    cm: 'fast',
    sfps: 29.5,
    sm: 'ht',
    caps: 14.125,
    capc: 6.5,
    dif: 0.333,
    tick: 22.75,
    cfps: 30,
    pfps: 28,
    same: 2,
    drop: 1,
    rd: 0,
    kf: 1,
    kr: 'req',
    age: 0.5,
    snd: 17.1,
    lps: 240,
    kreq: 0,
  },
}, [{ x: 0, y: 0, w: 64, h: 64, data: jpeg(24, 7) }]);

v2('v2_unicode_and_escapes', {
  hostId: 'host-ç',
  seq: 6,
  activeWindow: 'Relatório – Configurações ☺ 😀 ‮ "aspas" \\ barra\n<tab>\t& \u0001\u001f\u007f    \'x\'',
  timestamp: 1700000000132,
  w: 64,
  h: 64,
  key: true,
}, [{ x: 0, y: 0, w: 64, h: 64, data: jpeg(16, 8) }]);

v2('v2_number_formatting', {
  seq: 123456789,
  timestamp: 1.7e12,
  w: 64,
  h: 64,
  key: false,
  stats: {
    cap: 1e-7,
    enc: 0.000001,
    rtt: 1e21,
    kbps: 123456789012345680000,
    q: -0.5,
    mw: 1.5e300,
    ch: 5e-324,
    tt: 0.1,
    inf: 100,
    brtt: 1234.5678,
    win: 0.30000000000000004,
    sfps: 1e15,
    caps: 999999999999999.9,
    capc: 4.35,
  },
}, [{ x: 0, y: 0, w: 64, h: 64, data: jpeg(8, 9) }]);

// ---- Malformed frames -----------------------------------------------------------------------

const t64 = jpeg(10, 10);
const okHeader = (r: unknown, extra: object = {}) => ({ w: 128, h: 128, key: false, r, ...extra });

reject('bad_magic', 'byte 0 is not 0x44', Uint8Array.from([0x45, 1, 0, 0, 1]));
reject('bad_version', 'version byte is neither 1 nor 2', Uint8Array.from([0x44, 9, 0, 0, 1]));
reject('too_short', 'fewer than 5 bytes', Uint8Array.from([0x44, 1, 0, 0]));
reject('header_past_buffer', 'declared header length exceeds the buffer', Uint8Array.from([0x44, 1, 0, 50, 1]));
reject('header_bad_json', 'header is not valid JSON', raw(2, '{nope', t64));
reject('header_empty', 'zero-length header', raw(1, '', t64));
reject('header_null', 'header JSON is null', raw(1, 'null', t64));
reject('v1_empty_payload', 'v1 frame without a JPEG', raw(1, { hostId: 'a' }));
reject('v2_w_zero', 'w must be >= 1', raw(2, okHeader([0, 0, 64, 64, 10], { w: 0 }), t64));
reject('v2_w_fractional', 'w must be an integer', raw(2, okHeader([0, 0, 64, 64, 10], { w: 64.5 }), t64));
reject('v2_h_too_large', 'h must be <= 16384', raw(2, okHeader([0, 0, 64, 64, 10], { h: 16385 }), t64));
reject('v2_h_missing', 'h is absent', raw(2, { w: 128, key: false, r: [0, 0, 64, 64, 10] }, t64));
reject('v2_r_missing', 'r is absent', raw(2, { w: 128, h: 128, key: false }, t64));
reject('v2_r_not_array', 'r is not an array', raw(2, okHeader('nope'), t64));
reject('v2_r_not_multiple_of_5', 'r length is not a multiple of 5', raw(2, okHeader([0, 0, 64, 64]), t64));
reject('v2_tile_fractional', 'tile x is not an integer', raw(2, okHeader([0.5, 0, 64, 64, 10]), t64));
reject('v2_tile_negative_x', 'tile x < 0', raw(2, okHeader([-1, 0, 64, 64, 10]), t64));
reject('v2_tile_zero_width', 'tile w <= 0', raw(2, okHeader([0, 0, 0, 64, 10]), t64));
reject('v2_tile_out_of_bounds', 'tile x + w > frame w', raw(2, okHeader([100, 0, 64, 64, 10]), t64));
reject('v2_tile_zero_length', 'tile len <= 0', raw(2, okHeader([0, 0, 64, 64, 0]), t64));
reject('v2_tile_length_overflow', 'tile len runs past the buffer', raw(2, okHeader([0, 0, 64, 64, 11]), t64));
reject('v2_truncated_payload', 'payload shorter than the sum of tile lengths', raw(2, okHeader([0, 0, 64, 64, 10, 64, 0, 64, 64, 10]), t64));
reject('v2_trailing_bytes', 'payload longer than the sum of tile lengths', raw(2, okHeader([0, 0, 64, 64, 10]), jpeg(11, 11)));
reject('v2_keyframe_without_tiles', 'key=true with zero tiles', raw(2, okHeader([], { key: true })));

writeFileSync(join(dir, 'cases.json'), JSON.stringify({ cases }, null, 2) + '\n');
console.log(`wrote ${cases.length} cases to ${dir}`);
