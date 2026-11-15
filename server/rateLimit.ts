/**
 * Sliding-window rate limiter keyed by an arbitrary string (e.g. a session token).
 * In-memory only: limits reset when the relay restarts.
 */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit and returns 0 if allowed, or the milliseconds until the next slot frees up. */
  take(key: string, now = Date.now()): number {
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) || []).filter((t) => t > cutoff);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return list[0] + this.windowMs - now;
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.prune(cutoff);
    return 0;
  }

  private prune(cutoff: number) {
    for (const [key, list] of this.hits) {
      if (!list.some((t) => t > cutoff)) this.hits.delete(key);
    }
  }
}
