import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLockingInput } from '../src/lib/remoteInput.js';

test('detects Win+L in its common spellings', () => {
  for (const combo of ['Win+L', 'win+l', ' Win + L ', 'Meta+L', 'Cmd+l', 'Windows+L']) {
    assert.equal(isLockingInput({ type: 'hotkey', combo }), true, combo);
  }
  assert.equal(isLockingInput({ type: 'key', key: 'l', modifiers: ['win'] }), true);
  assert.equal(isLockingInput({ type: 'key', key: 'L', modifiers: ['win'] }), true);
});

test('does not flag other shortcuts or plain typing', () => {
  for (const combo of ['Win+D', 'Ctrl+L', 'Win+Shift+L', 'L', 'Win+LL']) {
    assert.equal(isLockingInput({ type: 'hotkey', combo }), false, combo);
  }
  assert.equal(isLockingInput({ type: 'key', key: 'l' }), false);
  assert.equal(isLockingInput({ type: 'key', key: 'l', modifiers: ['ctrl'] }), false);
  assert.equal(isLockingInput({ type: 'key', key: 'l', modifiers: ['win', 'shift'] }), false);
  assert.equal(isLockingInput({ type: 'type', text: 'Win+L' }), false);
  assert.equal(isLockingInput({ type: 'click', button: 'left' }), false);
});
