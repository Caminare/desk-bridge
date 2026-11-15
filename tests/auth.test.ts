import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LoginRateLimiter,
  createSessionToken,
  hashSecret,
  loadAuthConfig,
  parseCookies,
  safeEqual,
  verifySecret,
  verifySessionToken,
} from '../server/auth.js';
import { SlidingWindowLimiter } from '../server/rateLimit.js';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskbridge-auth-'));
  return { file: path.join(dir, 'auth.json'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('generated token persists across loads with 0600 permissions', () => {
  const { file, cleanup } = tempStore();
  try {
    const first = loadAuthConfig(file, '');
    assert.equal(first.generatedToken, true);
    assert.equal(first.tokenFromStore, true);
    const second = loadAuthConfig(file, '');
    assert.equal(second.generatedToken, false);
    assert.equal(second.accessToken, first.accessToken);
    assert.equal(second.enrollKey, first.enrollKey);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    cleanup();
  }
});

test('short configured tokens are refused', () => {
  const { file, cleanup } = tempStore();
  try {
    assert.throws(() => loadAuthConfig(file, 'short'), /at least 16/);
  } finally {
    cleanup();
  }
});

test('session tokens verify, and changing the access token invalidates them', () => {
  const { file, cleanup } = tempStore();
  try {
    const cfg = loadAuthConfig(file, 'first-token-0123456789');
    const token = createSessionToken(cfg);
    assert.equal(verifySessionToken(cfg, token), true);
    assert.equal(verifySessionToken(cfg, token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), false);
    assert.equal(verifySessionToken(cfg, undefined), false);
    assert.equal(verifySessionToken(cfg, 'a.b'), false);
    const rotated = loadAuthConfig(file, 'second-token-0123456789');
    assert.equal(verifySessionToken(rotated, token), false);
  } finally {
    cleanup();
  }
});

test('expired session tokens are rejected', () => {
  const { file, cleanup } = tempStore();
  try {
    const cfg = loadAuthConfig(file, 'first-token-0123456789');
    const token = createSessionToken(cfg);
    const [, nonce, sig] = token.split('.');
    assert.equal(verifySessionToken(cfg, `${Date.now() - 1}.${nonce}.${sig}`), false);
  } finally {
    cleanup();
  }
});

test('secret helpers', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual(undefined, 'abc'), false);
  const h = hashSecret('s3cret');
  assert.equal(verifySecret('s3cret', h), true);
  assert.equal(verifySecret('wrong', h), false);
  assert.equal(verifySecret('', h), false);
});

test('cookie parsing', () => {
  assert.deepEqual(parseCookies('a=1; db_session=x.y.z; bad; c=%20d'), { a: '1', db_session: 'x.y.z', c: ' d' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('login limiter blocks after max failures and resets on success', () => {
  const l = new LoginRateLimiter(3, 60_000);
  for (let i = 0; i < 3; i++) l.recordFailure('ip');
  assert.equal(l.isBlocked('ip'), true);
  assert.equal(l.isBlocked('other'), false);
  l.reset('ip');
  assert.equal(l.isBlocked('ip'), false);
});

test('sliding window limiter', () => {
  const l = new SlidingWindowLimiter(2, 1000);
  assert.equal(l.take('k', 0), 0);
  assert.equal(l.take('k', 100), 0);
  assert.equal(l.take('k', 200), 800);
  assert.equal(l.take('k', 1001), 0);
});
