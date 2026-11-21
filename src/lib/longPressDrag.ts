export const LONG_PRESS_MS = 350;
export const LONG_PRESS_SLOP_PX = 8;

type Phase = 'idle' | 'pending' | 'free' | 'dragging';

/**
 * Long-press-then-move drag for one finger: holding still for `holdMs` (within `slopPx` of the
 * touch-down point) presses the remote left button, later moves drag, and lifting releases it.
 * Moving away before the hold time leaves the touch to the normal gesture (cursor move, scroll,
 * pan), so taps and swipes keep working without any added delay.
 *
 * Pure and clock-free: the caller passes timestamps and calls `tick` from a timer. Methods that
 * return true tell the caller to send button down (`tick`, `move`) or button up (`up`, `cancel`).
 */
export class LongPressDrag {
  private phase: Phase = 'idle';
  private startX = 0;
  private startY = 0;
  private startTime = 0;
  private readonly holdMs: number;
  private readonly slopPx: number;

  constructor(opts: { holdMs?: number; slopPx?: number } = {}) {
    this.holdMs = opts.holdMs ?? LONG_PRESS_MS;
    this.slopPx = opts.slopPx ?? LONG_PRESS_SLOP_PX;
  }

  get isDragging(): boolean {
    return this.phase === 'dragging';
  }

  /** A finger touched down: arm the long press. */
  down(x: number, y: number, now: number): void {
    this.phase = 'pending';
    this.startX = x;
    this.startY = y;
    this.startTime = now;
  }

  /** The hold timer fired. True when the drag starts now (send button down). */
  tick(now: number): boolean {
    if (this.phase !== 'pending' || now - this.startTime < this.holdMs) return false;
    this.phase = 'dragging';
    return true;
  }

  /**
   * The finger moved. True when the drag starts now, which happens when the timer ran late and
   * this move is the first event past the hold time.
   */
  move(x: number, y: number, now: number): boolean {
    if (this.phase !== 'pending') return false;
    if (Math.hypot(x - this.startX, y - this.startY) > this.slopPx) {
      this.phase = 'free';
      return false;
    }
    return this.tick(now);
  }

  /**
   * Starts the drag now, without waiting for the hold: for a mouse or notebook trackpad, whose
   * button is really pressed. True when the drag starts now (send button down).
   */
  pressNow(): boolean {
    if (this.phase !== 'pending' && this.phase !== 'free') return false;
    this.phase = 'dragging';
    return true;
  }

  /** The finger lifted. True when a drag was active (send button up). */
  up(): boolean {
    const wasDragging = this.phase === 'dragging';
    this.phase = 'idle';
    return wasDragging;
  }

  /** The gesture was interrupted (second finger, pointer cancel, host switch). Same contract as `up`. */
  cancel(): boolean {
    return this.up();
  }
}
