# Keyboard input (K1)

Status: Agreed (2026-11-23). Source of truth: Notion Specs "Keyboard input (K1)". Terms: see `GLOSSARY.md` (Key event, Text input, Chord).

## Problem

Keyboard input grew as four separate paths, each with its own hard-coded subset:

1. Physical keyboard (`TouchControlDeck.tsx` window `keydown`): fullscreen only; a whitelist of Ctrl+C/V/S and Alt+Tab; 9 special keys; Shift dropped on non-character keys; Ctrl+Shift+V sent as Ctrl+V; dead keys (`'` `"` `` ` `` `~` `^` on ABNT2 / US-International) and AltGr characters dropped; no key holding.
2. Soft keyboard: text sent as Unicode (works), iOS may turn quotes curly.
3. Sticky modifiers + character: `key` message looked up in `VirtualKeys.cs`, a US-only table without `'` `"` `` ` `` `\`, shifted symbols, numpad or non-ASCII.
4. Combo box and shortcut buttons: `hotkey` strings parsed against the same table.

Adding shortcuts one by one does not scale. Replace all of it with the two-channel model remote desktop tools use.

## Model

Three keyboard messages in `client:input`. They replace `type`, `key` and `hotkey`. No capability flag: the new model is the default, and the agent release ships with the relay and controller deploy (R1 after K1).

| Message | Shape | Used by |
| --- | --- | --- |
| Key event | `{ type: 'key', code: string, down: boolean }` | Physical keyboard |
| Text input | `{ type: 'text', text: string }` | Soft keyboard, Dictation |
| Chord | `{ type: 'chord', modifiers: ('ctrl'\|'alt'\|'shift'\|'win')[], key: string }` | Combo box, shortcut buttons, sticky modifiers, soft-keyboard Backspace/Tab/Esc/Enter |

1. `code` is `KeyboardEvent.code` (physical position, e.g. `KeyA`, `Quote`, `IntlRo`, `NumpadEnter`). The agent maps it to a scancode (with the extended flag where needed) using the W3C UI Events code table and injects with `KEYEVENTF_SCANCODE`. The host's layout produces the character, so dead keys, AltGr and accents compose on the PC exactly as if typed there. Assumes the controller and PC use the same layout (owner: ABNT2 / US-International on both).
2. Chord `key` is either a named key from the W3C key values (`Enter`, `F5`, `ArrowUp`, `Escape`, `Home`, ...) or a single character. A character is resolved with `VkKeyScanExW` on the layout of the foreground window's thread; if the layout needs Shift (or AltGr) for it, that is added. Pressed and released in one `SendInput` batch.
3. Text input keeps today's behaviour (`KEYEVENTF_UNICODE`, `\n` → Enter, `\t` → Tab).

## Controller

1. Physical keyboard capture stays fullscreen-only. Every `keydown`/`keyup` becomes a key event and is `preventDefault`ed; nothing is interpreted in the browser (no whitelist, no composition handling).
2. Repeat `keydown`s (`e.repeat`) are forwarded as extra downs, because injected keys don't auto-repeat on Windows.
3. On entering fullscreen, request Keyboard Lock (`navigator.keyboard.lock()`, desktop Chromium) so Ctrl+W/N/T, Esc and Alt+Tab reach the PC. Leaving fullscreen is then a long Esc press. Where Keyboard Lock is unavailable, browser-reserved shortcuts stay with the browser (use the combo box).
4. On blur, `visibilitychange` to hidden and fullscreen exit, send `down: false` for every key still held.
5. Soft keyboard: text input via the existing live diff; Backspace/Tab/Escape/Enter as chords without modifiers; sticky modifiers + a typed character become a chord.
6. Combo box: parse `Ctrl+Shift+T` into a chord (existing `COMBO_PATTERN`). Shortcut buttons send chords.
7. iOS: if testing shows smart punctuation still turns `'` `"` into `’` `”` with `autoCorrect="off"`, straighten them before sending. Only if confirmed.
8. Lock warning (`isLockingInput`) covers Win+L as a chord and as key events (Win held, `KeyL` down).

## Agent

1. `InputParser` parses the three messages; `VirtualKeys` name table is replaced by a code → scancode table and a named-key → VK table for chords.
2. Tracks held keys from key events. Releases all of them when the controller disconnects, sharing is paused, or the relay connection drops.
3. Special cases from both key events and chords: Win+L → `LockWorkStation()`; Ctrl+Shift+Esc → start Task Manager.
4. Unknown codes or keys are logged once (existing `IgnoredInputLog`) and dropped.

## Relay

Passes `client:input` through unchanged today; no relay logic change expected beyond tests and types.

## Out of scope

1. Ctrl+Alt+Del, the lock screen, elevated windows (T14 / UIPI).
2. Mixed layouts between controller and PC (physical keys follow the PC's layout, like RDP).
3. Capture outside fullscreen.

## Done when

1. In fullscreen on a desktop browser with ABNT2 or US-International on both sides: Ctrl+A, Ctrl+N, Ctrl+Shift+V, Ctrl+Z/Y/F/W/T, Ctrl+Arrow, Shift+Arrow selection, Shift+click, Alt+Tab cycling, Alt+F4, F1-F12, Home/End/PgUp/PgDn, numpad, quotes, accents and AltGr characters all work on the PC.
2. Holding Backspace repeats; no key stays stuck after blur, fullscreen exit or disconnect.
3. From the phone: combo box `Ctrl+"` and ``Ctrl+` `` work; sticky Ctrl + typed character works; soft-keyboard text unchanged.
4. Win+L and Ctrl+Shift+Esc behave as today.
5. Tests: controller event → message mapping, chord parsing, agent code → scancode, chord resolution against a fake layout, release-all, special cases. `npm run check` and the .NET tests green.
6. Released as `agent-v0.2.0` (R1) together with the relay and controller deploy.
