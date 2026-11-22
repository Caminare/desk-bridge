import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';

/**
 * Owner authentication for DeskBridge.
 *
 * - Controllers (the phone / browser UI) log in with a single access token and
 *   receive a signed, HttpOnly session cookie. The cookie is sent automatically
 *   with REST calls and with the WebSocket upgrade.
 * - Host agents enroll with a one-time code minted by a logged-in owner
 *   (POST /api/agent/enroll) and receive a per-host secret used to authenticate
 *   subsequent WebSocket registrations.
 */

export const SESSION_COOKIE = 'db_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_TOKEN_LENGTH = 16;

interface AuthStore {
  accessToken?: string;
  sessionKey: string;
}

export interface AuthConfig {
  accessToken: string;
  /** True when the token lives in the auth store (not the env) and should be shown at startup. */
  tokenFromStore: boolean;
  /** True when the token was created during this start. */
  generatedToken: boolean;
  signingKey: Buffer;
}

function randomSecret(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function loadAuthConfig(
  storePath: string,
  configuredToken: string | undefined = process.env.DESKBRIDGE_ACCESS_TOKEN,
): AuthConfig {
  let store: Partial<AuthStore> = {};
  try {
    if (fs.existsSync(storePath)) {
      store = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Partial<AuthStore>;
    }
  } catch (err) {
    console.warn('Could not read auth store, regenerating secrets:', err);
  }

  const envToken = (configuredToken || '').trim();
  if (envToken && envToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`DESKBRIDGE_ACCESS_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters long.`);
  }

  let generatedToken = false;
  let changed = false;
  if (!store.sessionKey) {
    store.sessionKey = randomSecret(32);
    changed = true;
  }
  if (!envToken && !store.accessToken) {
    store.accessToken = randomSecret(18);
    generatedToken = true;
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  const accessToken = envToken || store.accessToken!;
  // Bind sessions to the current access token: changing the token logs everyone out.
  const signingKey = crypto.createHmac('sha256', store.sessionKey).update(accessToken).digest();

  return {
    accessToken,
    tokenFromStore: !envToken,
    generatedToken,
    signingKey,
  };
}

/** Constant-time string comparison that does not leak length. */
export function safeEqual(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export function verifySecret(secret: unknown, expectedHash: string): boolean {
  if (typeof secret !== 'string' || !secret) return false;
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function generateHostSecret(): string {
  return randomSecret(32);
}

function sign(key: Buffer, data: string): string {
  return crypto.createHmac('sha256', key).update(data).digest('base64url');
}

export function createSessionToken(cfg: AuthConfig): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const nonce = randomSecret(12);
  const body = `${exp}.${nonce}`;
  return `${body}.${sign(cfg.signingKey, body)}`;
}

export function verifySessionToken(cfg: AuthConfig, token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expStr, nonce, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = Buffer.from(sign(cfg.signingKey, `${expStr}.${nonce}`));
  const actual = Buffer.from(sig);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function isRequestAuthenticated(cfg: AuthConfig, req: IncomingMessage): boolean {
  return verifySessionToken(cfg, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

function isHttps(req: IncomingMessage): boolean {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https' || Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

export function buildSessionCookie(req: IncomingMessage, token: string): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isHttps(req)) attrs.push('Secure');
  return attrs.join('; ');
}

export function buildClearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Browsers always send an Origin header on WebSocket upgrades. Reject sessions
 * from foreign origins so a malicious page cannot ride the owner's cookie.
 * Native agents send no Origin and authenticate with their per-host secret.
 */
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const candidates = [req.headers.host, String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()]
      .filter(Boolean)
      .map(String);
    const appUrl = process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL' ? process.env.APP_URL : '';
    if (appUrl) {
      try {
        candidates.push(new URL(appUrl).host);
      } catch {
        // ignore malformed APP_URL
      }
    }
    return candidates.includes(originHost);
  } catch {
    return false;
  }
}

/** Simple fixed-window limiter for failed login attempts. */
export class LoginRateLimiter {
  private attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  isBlocked(key: string): boolean {
    const entry = this.attempts.get(key);
    if (!entry) return false;
    if (entry.resetAt < Date.now()) {
      this.attempts.delete(key);
      return false;
    }
    return entry.count >= this.maxFailures;
  }

  recordFailure(key: string) {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt < now) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count++;
    }
  }

  reset(key: string) {
    this.attempts.delete(key);
  }
}
