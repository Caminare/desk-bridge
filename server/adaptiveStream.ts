/**
 * Adaptive stream quality, driven by the round-trip time the agent measures
 * between sending a frame and receiving its ack (that path covers the agent's
 * upload, the relay and the controller's download + decode).
 *
 * A long path (PC -> tunnel -> relay -> tunnel -> phone) has a high RTT even
 * when nothing is congested, so absolute RTT says nothing about whether the
 * link can carry more. We therefore track the path's baseline (the minimum
 * RTT seen over a sliding window) and react to *queuing delay* = RTT -
 * baseline: it grows only when frames pile up somewhere. Too much queuing ->
 * step down; little queuing for a while -> step back up, never above the
 * user's chosen cap.
 */

export interface QualityLevel {
  maxWidth: number;
  jpegQuality: number;
}

/** Index 0 is the best quality. */
export const QUALITY_LADDER: readonly QualityLevel[] = [
  { maxWidth: 1920, jpegQuality: 80 },
  { maxWidth: 1600, jpegQuality: 75 },
  { maxWidth: 1366, jpegQuality: 68 },
  { maxWidth: 1152, jpegQuality: 62 },
  { maxWidth: 960, jpegQuality: 55 },
  { maxWidth: 800, jpegQuality: 48 },
  { maxWidth: 640, jpegQuality: 40 },
];

const LOWEST = QUALITY_LADDER.length - 1;

/** Best ladder level whose width does not exceed `maxWidth`. */
export function capLevelFor(maxWidth: number): number {
  const idx = QUALITY_LADDER.findIndex((l) => l.maxWidth <= maxWidth);
  return idx === -1 ? LOWEST : idx;
}

export interface AdaptiveOptions {
  /** Step down when queuing delay (RTT above baseline) exceeds this. */
  downQueueMs?: number;
  /** Step up only when queuing delay is below this. */
  upQueueMs?: number;
  /** Length of each baseline window; the baseline is the minimum over the last two. */
  baselineWindowMs?: number;
  /** Minimum time between step-downs (lets the previous change take effect). */
  downHoldMs?: number;
  /** Minimum calm time before stepping up. */
  upHoldMs?: number;
}

export class AdaptiveQuality {
  /** Current ladder index. */
  level: number;
  /** Best index allowed by the user's preset. */
  cap: number;
  /** Latest queuing delay estimate, ms. */
  queueMs = 0;
  private lastChange = 0;
  private prevWindowMin = Infinity;
  private curWindowMin = Infinity;
  private windowStart: number | null = null;
  private readonly downQueue: number;
  private readonly upQueue: number;
  private readonly baselineWindow: number;
  private readonly downHold: number;
  private readonly upHold: number;

  constructor(capMaxWidth = 1152, opts: AdaptiveOptions = {}) {
    this.cap = capLevelFor(capMaxWidth);
    this.level = this.cap;
    this.downQueue = opts.downQueueMs ?? 250;
    this.upQueue = opts.upQueueMs ?? 100;
    this.baselineWindow = opts.baselineWindowMs ?? 15_000;
    this.downHold = opts.downHoldMs ?? 1000;
    this.upHold = opts.upHoldMs ?? 4000;
  }

  /** Path baseline RTT: minimum over the current and previous window. */
  get baselineMs(): number {
    return Math.min(this.prevWindowMin, this.curWindowMin);
  }

  private observe(rttMs: number, now: number) {
    if (this.windowStart === null) this.windowStart = now;
    if (now - this.windowStart >= this.baselineWindow) {
      // Rolling windows let the baseline rise again if the path itself changed.
      this.prevWindowMin = this.curWindowMin;
      this.curWindowMin = Infinity;
      this.windowStart = now;
    }
    this.curWindowMin = Math.min(this.curWindowMin, rttMs);
  }

  get current(): QualityLevel {
    return QUALITY_LADDER[this.level];
  }

  /** User picked a preset. Returns the level to apply now. */
  setCap(maxWidth: number, now = Date.now()): QualityLevel {
    this.cap = capLevelFor(maxWidth);
    // Try the new cap straight away; the controller backs off if the link cannot carry it.
    this.level = this.cap;
    this.lastChange = now;
    return this.current;
  }

  /**
   * Feed one RTT sample (the agent's smoothed value). Returns the new level if
   * it changed, otherwise null.
   */
  onRttSample(rttMs: number, now = Date.now()): QualityLevel | null {
    if (!Number.isFinite(rttMs) || rttMs < 0) return null;
    this.observe(rttMs, now);
    const queue = Math.max(0, rttMs - this.baselineMs);
    this.queueMs = queue;
    const since = now - this.lastChange;

    if (queue > this.downQueue && since >= this.downHold && this.level < LOWEST) {
      const steps = queue > this.downQueue * 2 ? 2 : 1;
      this.level = Math.min(LOWEST, this.level + steps);
      this.lastChange = now;
      return this.current;
    }

    if (queue < this.upQueue && since >= this.upHold && this.level > this.cap) {
      this.level -= 1;
      this.lastChange = now;
      return this.current;
    }

    return null;
  }
}
