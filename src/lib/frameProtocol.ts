/**
 * DeskBridge binary frame format (shared by relay, browser client and tests).
 *
 *   byte 0     0x44 ('D')
 *   byte 1     version: 0x01 = full JPEG frame, 0x02 = tiled frame
 *   bytes 2-3  big-endian uint16 header length N
 *   bytes 4..  N bytes of UTF-8 JSON header
 *   rest       payload
 *
 * v1 payload: one JPEG covering the whole frame.
 * v2 payload: concatenated JPEG tiles. Header `r` is a flat list of
 *   [x, y, w, h, byteLength] per tile, in frame (stream) pixel coordinates;
 *   `w`/`h` give the frame size and `key` marks a keyframe (tiles cover the
 *   whole frame, so the receiver may discard any earlier state).
 *   A v2 delta frame only makes sense on top of the previous frame, so a
 *   receiver that missed a frame must wait for the next keyframe.
 */

export const FRAME_MAGIC = 0x44;
export const FRAME_V1 = 0x01;
export const FRAME_V2 = 0x02;

/** Per-frame pipeline stats reported by the agent (all optional). */
export interface AgentFrameStats {
  /** Capture + scale time for this frame, ms. */
  cap?: number;
  /** JPEG encode time for this frame, ms. */
  enc?: number;
  /** Smoothed round trip from send to ack, ms (agent -> relay -> controller -> relay -> agent). */
  rtt?: number;
  /** Smoothed upload rate, kbit/s. */
  kbps?: number;
  /** Current JPEG quality and stream width. */
  q?: number;
  mw?: number;
  /** Changed tiles / total tiles for this frame. */
  ch?: number;
  tt?: number;
  /** Frames currently awaiting an ack. */
  inf?: number;
  /** Path baseline RTT (minimum over the recent window), ms. RTT - brtt = queuing delay. */
  brtt?: number;
  /** Agent send window, KB. */
  win?: number;
}

export interface FrameHeader {
  hostId?: string;
  seq?: number;
  activeWindow?: string;
  timestamp?: number;
  /** v2: frame width/height in stream pixels. */
  w?: number;
  h?: number;
  /** v2: keyframe flag. */
  key?: boolean;
  /** v2: flat [x, y, w, h, len] tuples. */
  r?: number[];
  stats?: AgentFrameStats;
}

export interface FrameTile {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Offset of this tile's JPEG bytes within the full message. */
  offset: number;
  length: number;
}

export interface ParsedFrame {
  version: 1 | 2;
  header: FrameHeader;
  /** Offset of the payload within the message. */
  payloadOffset: number;
  /** True for v1 frames and v2 keyframes. */
  isKey: boolean;
  /** v2 tiles; for v1 a single tile spanning the payload (w/h unknown = 0). */
  tiles: FrameTile[];
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/** Parses a frame. Returns null for anything malformed (wrong magic, bad lengths, bad JSON). */
export function parseFrame(buf: Uint8Array): ParsedFrame | null {
  if (buf.length < 5 || buf[0] !== FRAME_MAGIC) return null;
  const version = buf[1];
  if (version !== FRAME_V1 && version !== FRAME_V2) return null;
  const headerLen = (buf[2] << 8) | buf[3];
  const payloadOffset = 4 + headerLen;
  if (buf.length < payloadOffset) return null;

  let header: FrameHeader;
  try {
    header = JSON.parse(textDecoder.decode(buf.subarray(4, payloadOffset)));
  } catch {
    return null;
  }
  if (!header || typeof header !== 'object') return null;

  if (version === FRAME_V1) {
    if (buf.length <= payloadOffset) return null;
    return {
      version: 1,
      header,
      payloadOffset,
      isKey: true,
      tiles: [{ x: 0, y: 0, w: 0, h: 0, offset: payloadOffset, length: buf.length - payloadOffset }],
    };
  }

  const w = Number(header.w);
  const h = Number(header.h);
  const r = header.r;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || w > 16384 || h > 16384) return null;
  if (!Array.isArray(r) || r.length % 5 !== 0) return null;

  const tiles: FrameTile[] = [];
  let offset = payloadOffset;
  for (let i = 0; i < r.length; i += 5) {
    const [tx, ty, tw, th, len] = r.slice(i, i + 5).map(Number);
    if (![tx, ty, tw, th, len].every(Number.isInteger)) return null;
    if (tx < 0 || ty < 0 || tw <= 0 || th <= 0 || tx + tw > w || ty + th > h || len <= 0) return null;
    if (offset + len > buf.length) return null;
    tiles.push({ x: tx, y: ty, w: tw, h: th, offset, length: len });
    offset += len;
  }
  if (offset !== buf.length) return null;
  if (header.key === true && tiles.length === 0) return null;

  return { version: 2, header, payloadOffset, isKey: header.key === true, tiles };
}

/** Builds a frame message. For v2, `tiles` carry rects + JPEG bytes and the header's `r` is filled in. */
export function encodeFrame(
  version: 1 | 2,
  header: FrameHeader,
  payload: Uint8Array | Array<{ x: number; y: number; w: number; h: number; data: Uint8Array }>,
): Uint8Array {
  let body: Uint8Array;
  let fullHeader = header;
  if (version === 2) {
    const tiles = payload as Array<{ x: number; y: number; w: number; h: number; data: Uint8Array }>;
    fullHeader = { ...header, r: tiles.flatMap((t) => [t.x, t.y, t.w, t.h, t.data.length]) };
    const total = tiles.reduce((n, t) => n + t.data.length, 0);
    body = new Uint8Array(total);
    let off = 0;
    for (const t of tiles) {
      body.set(t.data, off);
      off += t.data.length;
    }
  } else {
    body = payload as Uint8Array;
  }
  const headerBytes = textEncoder.encode(JSON.stringify(fullHeader));
  if (headerBytes.length > 0xffff) throw new Error('frame header too large');
  const out = new Uint8Array(4 + headerBytes.length + body.length);
  out[0] = FRAME_MAGIC;
  out[1] = version === 2 ? FRAME_V2 : FRAME_V1;
  out[2] = (headerBytes.length >> 8) & 0xff;
  out[3] = headerBytes.length & 0xff;
  out.set(headerBytes, 4);
  out.set(body, 4 + headerBytes.length);
  return out;
}

/** Returns a copy of the frame with a replaced header (payload untouched). */
export function rewriteFrameHeader(buf: Uint8Array, parsed: ParsedFrame, header: FrameHeader): Uint8Array | null {
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  if (headerBytes.length > 0xffff) return null;
  const payload = buf.subarray(parsed.payloadOffset);
  const out = new Uint8Array(4 + headerBytes.length + payload.length);
  out[0] = FRAME_MAGIC;
  out[1] = parsed.version === 2 ? FRAME_V2 : FRAME_V1;
  out[2] = (headerBytes.length >> 8) & 0xff;
  out[3] = headerBytes.length & 0xff;
  out.set(headerBytes, 4);
  out.set(payload, 4 + headerBytes.length);
  return out;
}
