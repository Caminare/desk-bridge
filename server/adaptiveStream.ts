/**
 * Adaptive stream quality, driven by the round-trip time the agent measures
 * between sending a frame and receiving its ack (that path covers the agent's
 * upload, the relay and the controller's download + decode). When frames queue
 * up anywhere on that path the RTT grows, so we step down resolution/quality;
 * when it stays low we step back up, never above the user's chosen cap.
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
  /** Step down when smoothed RTT exceeds this. */
  downRttMs?: number;
  /** Step up only when smoothed RTT is below this. */
  upRttMs?: number;
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
  private lastChange = 0;
  private readonly downRtt: number;
  private readonly upRtt: number;
  private readonly downHold: number;
  private readonly upHold: number;

  constructor(capMaxWidth = 1152, opts: AdaptiveOptions = {}) {
    this.cap = capLevelFor(capMaxWidth);
    this.level = this.cap;
    this.downRtt = opts.downRttMs ?? 450;
    this.upRtt = opts.upRttMs ?? 180;
    this.downHold = opts.downHoldMs ?? 1000;
    this.upHold = opts.upHoldMs ?? 4000;
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
    const since = now - this.lastChange;

    if (rttMs > this.downRtt && since >= this.downHold && this.level < LOWEST) {
      const steps = rttMs > this.downRtt * 2 ? 2 : 1;
      this.level = Math.min(LOWEST, this.level + steps);
      this.lastChange = now;
      return this.current;
    }

    if (rttMs < this.upRtt && since >= this.upHold && this.level > this.cap) {
      this.level -= 1;
      this.lastChange = now;
      return this.current;
    }

    return null;
  }
}
