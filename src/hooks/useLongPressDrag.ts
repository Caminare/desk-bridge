import { useCallback, useEffect, useRef } from 'react';
import type { RemoteInputEvent } from '../types/deskbridge';
import { LONG_PRESS_MS, LongPressDrag } from '../lib/longPressDrag';

type SendInput = (input: RemoteInputEvent, targetHostId?: string, source?: 'touch' | 'keyboard') => void;

/**
 * Long-press-then-move drag (see LongPressDrag) wired to the remote left button. Owns the hold
 * timer and the host the button went down on, and always releases the button on that host:
 * when the finger lifts, the gesture is cancelled, the active host changes or the deck unmounts.
 * A left button stuck down on the PC would turn every later move into a drag.
 *
 * `flushMoves` must send any coalesced cursor moves, so they reach the PC before the button
 * changes state and the drag starts and ends where the finger did.
 */
export function useLongPressDrag(onSendInput: SendInput, activeHostId: string | null, flushMoves: () => void) {
  const gestureRef = useRef(new LongPressDrag());
  const timerRef = useRef<number | null>(null);
  const hostRef = useRef<string | null>(null);
  const startRef = useRef<() => void>(() => {});

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const release = useCallback(
    (wasDragging: boolean) => {
      clearTimer();
      const host = hostRef.current;
      hostRef.current = null;
      if (!wasDragging || !host) return false;
      flushMoves();
      onSendInput({ type: 'mouseup', button: 'left' }, host, 'touch');
      return true;
    },
    [flushMoves, onSendInput],
  );

  /**
   * A finger touched down. `beforeDown` runs right before the button press, e.g. to put the
   * cursor under the finger in tap-screen mode.
   */
  const begin = useCallback(
    (x: number, y: number, beforeDown?: () => void) => {
      clearTimer();
      const host = activeHostId;
      if (!host) return;
      gestureRef.current.down(x, y, Date.now());
      startRef.current = () => {
        clearTimer();
        flushMoves();
        beforeDown?.();
        hostRef.current = host;
        navigator.vibrate?.(15);
        onSendInput({ type: 'mousedown', button: 'left' }, host, 'touch');
      };
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (gestureRef.current.tick(Date.now())) startRef.current();
      }, LONG_PRESS_MS);
    },
    [activeHostId, flushMoves, onSendInput],
  );

  /** The finger moved. Returns true while a drag is active, so the caller moves instead of scrolling. */
  const move = useCallback((x: number, y: number) => {
    const gesture = gestureRef.current;
    // A timer that fires after the finger moved away is harmless: tick ignores it.
    if (gesture.move(x, y, Date.now())) startRef.current();
    return gesture.isDragging;
  }, []);

  /** Presses now instead of after the hold (a mouse or notebook trackpad has a real button). */
  const pressNow = useCallback(() => {
    if (gestureRef.current.pressNow()) startRef.current();
  }, []);

  /** The finger lifted. Returns true when it ended a drag, so the caller skips its tap logic. */
  const end = useCallback(() => release(gestureRef.current.up()), [release]);

  /** The gesture was interrupted (second finger, pointer cancel). Releases the button if held. */
  const cancel = useCallback(() => release(gestureRef.current.cancel()), [release]);

  // The button went down on the host that was active then: release it there on a host switch
  // or unmount. The ref keeps the latest cancel without re-running this effect on every render.
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => () => void cancelRef.current(), [activeHostId]);

  return { begin, move, pressNow, end, cancel, isDragging: () => gestureRef.current.isDragging };
}

