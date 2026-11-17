import type { RemoteInputEvent } from '../types/deskbridge';

const WIN_ALIASES = new Set(['win', 'windows', 'meta', 'cmd', 'super']);

/**
 * True for inputs that lock the Windows session (Win+L). Once locked, the PC can't be unlocked
 * remotely: the PIN box lives on the secure desktop, which a user-session agent can't type into.
 */
export function isLockingInput(input: RemoteInputEvent): boolean {
  if (input.type === 'hotkey') {
    const parts = input.combo
      .split('+')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    return parts.length === 2 && parts[1] === 'l' && WIN_ALIASES.has(parts[0]);
  }
  if (input.type === 'key') {
    const mods = input.modifiers ?? [];
    return input.key.toLowerCase() === 'l' && mods.length === 1 && mods[0] === 'win';
  }
  return false;
}

export const LOCK_WARNING =
  "Lock this PC?\n\nYou won't be able to unlock it from DeskBridge: Windows doesn't let remote apps type the PIN or password on the lock screen. Someone at the PC will have to unlock it.";
