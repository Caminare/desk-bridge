import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EnrollmentCodes } from '../server/enrollmentCodes.js';

describe('EnrollmentCodes', () => {
  test('a minted code redeems once', () => {
    const codes = new EnrollmentCodes();
    const { code } = codes.mint();
    assert.equal(codes.redeem(code), true);
    assert.equal(codes.redeem(code), false);
  });

  test('codes look like XXXX-XXXX without look-alike characters', () => {
    const codes = new EnrollmentCodes({ maxOutstanding: 100 });
    for (let i = 0; i < 50; i++) {
      assert.match(codes.mint().code, /^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
    }
  });

  test('input is case-insensitive and ignores dashes and spaces', () => {
    const codes = new EnrollmentCodes();
    const { code } = codes.mint();
    const sloppy = ` ${code.replace('-', ' ').toLowerCase()} `;
    assert.equal(codes.redeem(sloppy), true);
  });

  test('a code expires after the ttl', () => {
    let now = 1_000_000;
    const codes = new EnrollmentCodes({ ttlMs: 10 * 60 * 1000, now: () => now });
    const { code, expiresAt } = codes.mint();
    assert.equal(expiresAt, now + 10 * 60 * 1000);
    now = expiresAt;
    assert.equal(codes.redeem(code), false);
  });

  test('a code is still valid just before expiry', () => {
    let now = 1_000_000;
    const codes = new EnrollmentCodes({ ttlMs: 1000, now: () => now });
    const { code } = codes.mint();
    now += 999;
    assert.equal(codes.redeem(code), true);
  });

  test('minting beyond the limit revokes the oldest code', () => {
    const codes = new EnrollmentCodes({ maxOutstanding: 5 });
    const minted = Array.from({ length: 6 }, () => codes.mint().code);
    assert.equal(codes.redeem(minted[0]), false);
    for (const code of minted.slice(1)) assert.equal(codes.redeem(code), true);
  });

  test('unknown and malformed input is rejected', () => {
    const codes = new EnrollmentCodes();
    codes.mint();
    for (const bad of ['ABCD-EFGH', '', 'short', 'IIII-OOOO', 12345678, null, undefined, { code: 'x' }]) {
      assert.equal(codes.redeem(bad), false, `accepted ${String(bad)}`);
    }
  });
});
