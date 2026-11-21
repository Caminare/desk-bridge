import { parseFrame, type AgentFrameStats } from './frameProtocol';

/**
 * Client-side frame compositor. Each host gets an off-DOM canvas that always
 * holds the latest complete picture: v1 frames and keyframes replace it,
 * v2 delta frames paint only their changed tiles on top.
 *
 * Frames are applied strictly in arrival order. Tile decoding happens off the
 * main thread (createImageBitmap); only the cheap drawImage calls run on it.
 * The promise returned for each frame resolves once it has been drawn, which
 * is when the controller acknowledges it, so the agent's pacing reflects what
 * the phone can actually display.
 */

export interface StreamStats {
  /** Frames drawn per second (last ~1s). */
  fps: number;
  /** Received bitrate, kbit/s (last ~1s). */
  kbpsIn: number;
  /** Average decode + draw time per frame, ms. */
  decodeMs: number;
  /** Frames currently waiting to be decoded/drawn. */
  queued: number;
  width: number;
  height: number;
  keyframes: number;
  /** Delta frames dropped because the picture was out of sync. */
  skipped: number;
  /** Most recent agent-side stats (v2 frames only). */
  agent?: AgentFrameStats;
}

export interface FrameResult {
  seq?: number;
  drawn: boolean;
}

type Listener = () => void;

const STATS_WINDOW_MS = 1000;

async function decodeBlob(blob: Blob): Promise<CanvasImageSource & { width: number; height: number; close?: () => void }> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob);
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function decodeUrl(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

export class HostFrameCompositor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  /** True once we hold a complete picture that deltas can be applied to. */
  private synced = false;
  /** Bumped when a keyframe is queued; older queued deltas can skip drawing. */
  private epoch = 0;
  private listeners = new Set<Listener>();
  private drawTimes: number[] = [];
  private byteLog: Array<[number, number]> = [];
  private decodeTotal = 0;
  private decodeCount = 0;
  private keyframes = 0;
  private skipped = 0;
  private lastAgentStats?: AgentFrameStats;
  /** Draw counter, used to tell whether a snapshot is outdated. */
  version = 0;

  constructor(private readonly onResyncNeeded: () => void) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 0;
    this.canvas.height = 0;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  get hasImage(): boolean {
    return this.canvas.width > 0 && this.canvas.height > 0;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.queued++;
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined).finally(() => {
      this.queued--;
    });
    return run;
  }

  private recordDraw(start: number) {
    const now = performance.now();
    this.decodeTotal += now - start;
    this.decodeCount++;
    this.drawTimes.push(now);
  }

  private ensureSize(w: number, h: number) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** Applies a binary frame (v1 or v2). */
  applyBinary(buf: ArrayBuffer): Promise<FrameResult> {
    const bytes = new Uint8Array(buf);
    const parsed = parseFrame(bytes);
    if (!parsed) return Promise.resolve({ drawn: false });
    this.byteLog.push([performance.now(), bytes.length]);
    if (parsed.header.stats) this.lastAgentStats = parsed.header.stats;
    const seq = parsed.header.seq;
    if (parsed.isKey) this.epoch++;
    const myEpoch = this.epoch;

    return this.enqueue(async () => {
      const start = performance.now();
      if (!parsed.isKey) {
        // A delta on top of the wrong picture would leave garbage on screen.
        if (!this.synced) {
          this.skipped++;
          return { seq, drawn: false };
        }
        // A newer keyframe is already queued and will repaint everything.
        if (myEpoch !== this.epoch) {
          this.skipped++;
          return { seq, drawn: false };
        }
      }

      try {
        const images = await Promise.all(
          parsed.tiles.map((t) => decodeBlob(new Blob([bytes.subarray(t.offset, t.offset + t.length)], { type: 'image/jpeg' }))),
        );
        if (parsed.version === 1) {
          const img = images[0];
          this.ensureSize(img.width, img.height);
          this.ctx.drawImage(img, 0, 0);
        } else {
          this.ensureSize(parsed.header.w!, parsed.header.h!);
          parsed.tiles.forEach((t, i) => this.ctx.drawImage(images[i], t.x, t.y, t.w, t.h));
        }
        images.forEach((img) => img.close?.());
        if (parsed.isKey) {
          this.synced = true;
          this.keyframes++;
        }
        this.recordDraw(start);
        this.notify();
        return { seq, drawn: true };
      } catch {
        // Undecodable frame: the picture can no longer be trusted until the next keyframe.
        this.synced = false;
        this.onResyncNeeded();
        return { seq, drawn: false };
      }
    });
  }

  /** Applies a complete image given as a URL (browser host JSON frames, cached frames). */
  applyImageUrl(src: string): Promise<FrameResult> {
    this.epoch++;
    return this.enqueue(async () => {
      const start = performance.now();
      try {
        const img = await decodeUrl(src);
        this.ensureSize(img.naturalWidth, img.naturalHeight);
        this.ctx.drawImage(img, 0, 0);
        this.synced = true;
        this.keyframes++;
        this.recordDraw(start);
        this.notify();
        return { drawn: true };
      } catch {
        return { drawn: false };
      }
    });
  }

  stats(): StreamStats {
    const now = performance.now();
    const cutoff = now - STATS_WINDOW_MS;
    this.drawTimes = this.drawTimes.filter((t) => t > cutoff);
    this.byteLog = this.byteLog.filter(([t]) => t > cutoff);
    const bytes = this.byteLog.reduce((n, [, b]) => n + b, 0);
    const decodeMs = this.decodeCount ? this.decodeTotal / this.decodeCount : 0;
    // Keep the average recent.
    if (this.decodeCount > 60) {
      this.decodeTotal = decodeMs * 30;
      this.decodeCount = 30;
    }
    return {
      fps: this.drawTimes.length,
      kbpsIn: Math.round((bytes * 8) / STATS_WINDOW_MS),
      decodeMs: Math.round(decodeMs * 10) / 10,
      queued: this.queued,
      width: this.canvas.width,
      height: this.canvas.height,
      keyframes: this.keyframes,
      skipped: this.skipped,
      agent: this.lastAgentStats,
    };
  }

  /** Current picture as a Blob (for thumbnails). */
  toBlob(quality = 0.7): Promise<Blob | null> {
    if (!this.hasImage) return Promise.resolve(null);
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/jpeg', quality));
  }
}

/** One compositor per host, created on demand. */
export class FrameStore {
  private compositors = new Map<string, HostFrameCompositor>();

  constructor(private readonly onResyncNeeded: (hostId: string) => void) {}

  get(hostId: string): HostFrameCompositor {
    let c = this.compositors.get(hostId);
    if (!c) {
      c = new HostFrameCompositor(() => this.onResyncNeeded(hostId));
      this.compositors.set(hostId, c);
    }
    return c;
  }

  peek(hostId: string): HostFrameCompositor | undefined {
    return this.compositors.get(hostId);
  }

  entries(): Array<[string, HostFrameCompositor]> {
    return Array.from(this.compositors.entries());
  }
}
