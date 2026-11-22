import type { CursorPosition, CursorShape, HostProfile, RemoteInputEvent } from '../types/deskbridge';

/**
 * Longest the controller shows its own predicted position after the last local pointer input.
 * Normally it hands over sooner, as soon as the agent reports the predicted position: earlier agent
 * positions are echoes of older input (a full round trip behind, which can be long on tunnelled
 * paths), so showing them would make the cursor jump back and replay its path.
 */
export const PREDICTION_TIMEOUT_MS = 1500;
/** An agent position this close to the prediction (physical px) means the agent has caught up. */
const HANDOVER_TOLERANCE_PX = 2;
const MAX_SHAPES = 32;

// Classic arrow, B = black, W = white. Used when the agent's shape is unknown (conversion failed,
// evicted from the cache), so the cursor never silently disappears.
const FALLBACK_ARROW = [
  'B...........',
  'BB..........',
  'BWB.........',
  'BWWB........',
  'BWWWB.......',
  'BWWWWB......',
  'BWWWWWB.....',
  'BWWWWWWB....',
  'BWWWWWWWB...',
  'BWWWWWWWWB..',
  'BWWWWWWWWWB.',
  'BWWWWWWBBBBB',
  'BWWWBWWB....',
  'BWWBBWWB....',
  'BWB..BWWB...',
  'BB...BWWB...',
  'B.....BWWB..',
  '......BWWB..',
  '.......BB...',
];

function toBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63];
    out += i + 1 < bytes.length ? chars[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? chars[n & 63] : '=';
  }
  return out;
}

function buildFallbackArrow(): CursorShape {
  const h = FALLBACK_ARROW.length;
  const w = FALLBACK_ARROW[0].length;
  const rgba = new Uint8Array(w * h * 4);
  FALLBACK_ARROW.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const c = row[x];
      if (c === '.') continue;
      const v = c === 'W' ? 255 : 0;
      rgba.set([v, v, v, 255], (y * w + x) * 4);
    }
  });
  return { id: 'builtin-arrow', w, h, hotX: 0, hotY: 0, rgba: toBase64(rgba) };
}

export const FALLBACK_CURSOR_SHAPE: CursorShape = buildFallbackArrow();

export interface MonitorSize {
  width: number;
  height: number;
}

export interface CursorView {
  /** Hotspot position, normalized on the streamed monitor. */
  x: number;
  y: number;
  shape: CursorShape;
}

/** Physical size of the monitor being streamed, which agent cursor sizes and deltas refer to. */
export function activeMonitorSize(host: HostProfile): MonitorSize {
  const active = host.monitors?.find((m) => m.index === host.activeMonitor);
  return active ? { width: active.width, height: active.height } : { width: host.screenWidth, height: host.screenHeight };
}

/**
 * One host's cursor as the controller should draw it: the agent's reported position and shape,
 * overridden by a local prediction while the user is moving the pointer.
 */
export class RemoteCursor {
  private readonly shapes = new Map<string, CursorShape>();
  private remote: CursorPosition | null = null;
  private predicted: { x: number; y: number } | null = null;
  private predictedOn: MonitorSize | null = null;
  private lastLocalAt = Number.NEGATIVE_INFINITY;
  private readonly listeners = new Set<() => void>();

  onShape(shape: CursorShape) {
    this.shapes.delete(shape.id); // re-insert so the newest shapes survive eviction
    this.shapes.set(shape.id, shape);
    if (this.shapes.size > MAX_SHAPES) this.shapes.delete(this.shapes.keys().next().value!);
    this.notify();
  }

  onRemote(position: CursorPosition, now: number) {
    this.remote = position;
    if (this.isPredicting(now) && this.matchesPrediction(position)) this.predicted = null;
    this.notify();
  }

  /** Predicts the effect of an input the controller just sent to the agent. */
  onLocalInput(input: RemoteInputEvent, monitor: MonitorSize, now: number) {
    let next: { x: number; y: number } | null = null;
    if (input.type === 'mousemove' && input.relative) {
      const base = this.isPredicting(now) ? this.predicted : this.remote;
      if (base && monitor.width > 0 && monitor.height > 0) {
        // Same maths as the agent: physical pixels, clamped to the monitor, no acceleration.
        next = {
          x: clampPixel(base.x * monitor.width + (input.dx ?? 0), monitor.width) / monitor.width,
          y: clampPixel(base.y * monitor.height + (input.dy ?? 0), monitor.height) / monitor.height,
        };
      }
    } else if ((input.type === 'mousemove' || input.type === 'click') && isFiniteCoord(input.x) && isFiniteCoord(input.y)) {
      next = { x: input.x, y: input.y };
    }
    if (!next) return;
    this.predicted = next;
    this.predictedOn = monitor;
    this.lastLocalAt = now;
    this.notify();
  }

  /** When the current prediction times out, or null when not predicting (the view repaints then). */
  predictionEndsAt(): number | null {
    return this.predicted ? this.lastLocalAt + PREDICTION_TIMEOUT_MS : null;
  }

  /** What to draw at time `now`, or null for no cursor. */
  state(now: number): CursorView | null {
    const r = this.remote;
    if (!r) return null;
    const shape = (r.shape ? this.shapes.get(r.shape) : undefined) ?? FALLBACK_CURSOR_SHAPE;
    if (this.isPredicting(now)) return { x: this.predicted!.x, y: this.predicted!.y, shape };
    if (!r.visible || r.x < 0 || r.x > 1 || r.y < 0 || r.y > 1) return null;
    return { x: r.x, y: r.y, shape };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private isPredicting(now: number) {
    return this.predicted !== null && now - this.lastLocalAt < PREDICTION_TIMEOUT_MS;
  }

  private matchesPrediction(position: CursorPosition) {
    const p = this.predicted!;
    const size = this.predictedOn;
    const w = size && size.width > 0 ? size.width : 1000;
    const h = size && size.height > 0 ? size.height : 1000;
    // Tolerance plus a hair for float noise in the normalized coordinates.
    const tol = HANDOVER_TOLERANCE_PX + 1e-6;
    return Math.abs(position.x - p.x) * w <= tol && Math.abs(position.y - p.y) * h <= tol;
  }

  private notify() {
    this.listeners.forEach((l) => l());
  }
}

/** Per-host cursors, kept outside React state like `FrameStore`. */
export class RemoteCursorStore {
  private readonly cursors = new Map<string, RemoteCursor>();

  get(hostId: string): RemoteCursor {
    let c = this.cursors.get(hostId);
    if (!c) {
      c = new RemoteCursor();
      this.cursors.set(hostId, c);
    }
    return c;
  }
}

function clampPixel(value: number, size: number) {
  return Math.min(size - 1, Math.max(0, Math.round(value)));
}

function isFiniteCoord(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
