import crypto from 'node:crypto';

/**
 * Crockford base32 without the characters people misread (0/O, 1/I/L) or that
 * Crockford already omits (U). 30 symbols, 8 characters: about 2^39 codes.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

export interface EnrollmentCodesOptions {
  ttlMs?: number;
  maxOutstanding?: number;
  now?: () => number;
}

export interface MintedCode {
  /** Display form, XXXX-XXXX. */
  code: string;
  expiresAt: number;
}

/** Uppercases and strips separators; returns null if the result cannot be a code. */
export function normalizeEnrollmentCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const compact = input.toUpperCase().replace(/[\s-]/g, '');
  return CODE_PATTERN.test(compact) ? compact : null;
}

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/**
 * One-time enrollment codes, held only in memory and only as hashes.
 * A restart wipes them; the owner simply mints another.
 */
export class EnrollmentCodes {
  private readonly ttlMs: number;
  private readonly maxOutstanding: number;
  private readonly now: () => number;
  /** hash -> expiry, in mint order (Map preserves insertion order). */
  private readonly pending = new Map<string, number>();

  constructor(opts: EnrollmentCodesOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.maxOutstanding = opts.maxOutstanding ?? 5;
    this.now = opts.now ?? Date.now;
  }

  mint(): MintedCode {
    this.dropExpired();
    let raw = '';
    for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[crypto.randomInt(ALPHABET.length)];
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(hashCode(raw), expiresAt);
    while (this.pending.size > this.maxOutstanding) {
      const oldest = this.pending.keys().next().value as string;
      this.pending.delete(oldest);
    }
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
  }

  /** Consumes the code if it is pending and unexpired. */
  redeem(input: unknown): boolean {
    const code = normalizeEnrollmentCode(input);
    if (!code) return false;
    const hash = hashCode(code);
    const expiresAt = this.pending.get(hash);
    if (expiresAt === undefined) return false;
    this.pending.delete(hash);
    return expiresAt > this.now();
  }

  private dropExpired() {
    const now = this.now();
    for (const [hash, expiresAt] of this.pending) {
      if (expiresAt <= now) this.pending.delete(hash);
    }
  }
}
