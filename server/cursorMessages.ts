import type { CursorPosition, CursorShape } from '../src/types/deskbridge.js';

export const MAX_CURSOR_SIZE = 128;
const CURSOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function isIntIn(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

/** Exact byte length a canonical, padded base64 string decodes to, or -1 if it is not one. */
function base64ByteLength(value: string): number {
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) return -1;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** Validates an agent-supplied `host:cursor_shape` payload; null if anything is off. */
export function sanitizeCursorShape(value: unknown): CursorShape | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const { id, w, h, hotX, hotY, rgba } = rec;
  if (typeof id !== 'string' || !CURSOR_ID_PATTERN.test(id)) return null;
  if (!isIntIn(w, 1, MAX_CURSOR_SIZE) || !isIntIn(h, 1, MAX_CURSOR_SIZE)) return null;
  if (!isIntIn(hotX, 0, w - 1) || !isIntIn(hotY, 0, h - 1)) return null;
  if (typeof rgba !== 'string' || base64ByteLength(rgba) !== w * h * 4) return null;
  return { id, w, h, hotX, hotY, rgba };
}

/** Validates an agent-supplied `host:cursor` payload; null if anything is off. */
export function sanitizeCursorPosition(value: unknown): CursorPosition | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const { x, y, visible, shape } = rec;
  const inRange = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= -1 && n <= 2;
  if (!inRange(x) || !inRange(y) || typeof visible !== 'boolean') return null;
  return { x, y, visible, shape: typeof shape === 'string' && CURSOR_ID_PATTERN.test(shape) ? shape : null };
}
