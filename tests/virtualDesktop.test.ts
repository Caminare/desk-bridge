import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIRTUAL_H,
  VIRTUAL_W,
  applyVirtualInput,
  createVirtualDesktopState,
  getFocusedWindowTitle,
} from '../src/lib/virtualDesktop.js';

test('relative and absolute mouse moves are clamped to the screen', () => {
  const s = createVirtualDesktopState();
  applyVirtualInput(s, { type: 'mousemove', x: 0, y: 0, relative: true, dx: -10_000, dy: 10_000 });
  assert.equal(s.cursorX, 0);
  assert.equal(s.cursorY, VIRTUAL_H - 4);
  applyVirtualInput(s, { type: 'mousemove', x: 0.5, y: 0.25 });
  assert.equal(s.cursorX, VIRTUAL_W / 2);
  assert.equal(s.cursorY, VIRTUAL_H / 4);
});

test('typing goes to the focused window and Enter starts a new line', () => {
  const s = createVirtualDesktopState();
  const before = s.windows.find((w) => w.id === s.focusedId)!.content.length;
  assert.match(applyVirtualInput(s, { type: 'type', text: 'hello' }) ?? '', /Typed "hello"/);
  const win = s.windows.find((w) => w.id === s.focusedId)!;
  assert.ok(win.content[win.content.length - 1].endsWith('hello'));
  applyVirtualInput(s, { type: 'key', key: 'Enter' });
  assert.equal(win.content.length, before + 1);
  applyVirtualInput(s, { type: 'key', key: 'Backspace' });
  assert.equal(win.content[win.content.length - 1], '');
});

test('Win+L locks, a click unlocks', () => {
  const s = createVirtualDesktopState();
  applyVirtualInput(s, { type: 'hotkey', combo: 'Win+L' });
  assert.equal(s.locked, true);
  assert.equal(applyVirtualInput(s, { type: 'click', button: 'left' }), 'Unlocked desktop');
  assert.equal(s.locked, false);
});

test('Win+D toggles all windows minimized', () => {
  const s = createVirtualDesktopState();
  applyVirtualInput(s, { type: 'hotkey', combo: 'Win+D' });
  assert.ok(s.windows.every((w) => w.minimized));
  applyVirtualInput(s, { type: 'hotkey', combo: 'Win+D' });
  assert.ok(s.windows.every((w) => !w.minimized));
});

test('launch focuses an existing app or opens a new window', () => {
  const s = createVirtualDesktopState();
  const count = s.windows.length;
  applyVirtualInput(s, { type: 'launch', target: 'powershell' });
  assert.equal(s.windows.length, count);
  assert.equal(getFocusedWindowTitle(s), 'Windows PowerShell');
  applyVirtualInput(s, { type: 'launch', target: 'notepad' });
  assert.equal(s.windows.length, count + 1);
  assert.match(getFocusedWindowTitle(s) ?? '', /notepad/);
});

test('shell commands are echoed into PowerShell', () => {
  const s = createVirtualDesktopState();
  applyVirtualInput(s, { type: 'shell', command: 'Get-Date' });
  const ps = s.windows.find((w) => w.app === 'powershell')!;
  assert.ok(ps.content.includes('PS> Get-Date'));
});

test('mouse moves and quality changes produce no status line', () => {
  const s = createVirtualDesktopState();
  assert.equal(applyVirtualInput(s, { type: 'mousemove', x: 0.1, y: 0.1 }), null);
  assert.equal(applyVirtualInput(s, { type: 'quality', maxWidth: 1280, jpegQuality: 60 }), null);
});
