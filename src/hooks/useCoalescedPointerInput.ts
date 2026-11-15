import { useCallback, useEffect, useRef } from 'react';
import type { RemoteInputEvent } from '../types/deskbridge';

type SendInput = (input: RemoteInputEvent, targetHostId?: string, source?: 'touch' | 'keyboard' | 'ai') => void;

interface Pending {
  dx: number;
  dy: number;
  hostId: string | null;
}

const MOVE_FLUSH_MS = 16; // ~60Hz: pointermove fires at ~120Hz on many phones/tablets
const SCROLL_FLUSH_MS = 24;
const MIN_SCROLL_DELTA = 0.15;

/**
 * Batches high-frequency relative mouse moves and scroll deltas so the relay and
 * host see a steady ~60Hz stream instead of one message per pointer event.
 */
export function useCoalescedPointerInput(onSendInput: SendInput) {
  const pendingMoveRef = useRef<Pending>({ dx: 0, dy: 0, hostId: null });
  const moveTimerRef = useRef<number | null>(null);
  const pendingScrollRef = useRef<Pending>({ dx: 0, dy: 0, hostId: null });
  const scrollTimerRef = useRef<number | null>(null);

  const flushMove = useCallback(() => {
    if (moveTimerRef.current !== null) {
      window.clearTimeout(moveTimerRef.current);
      moveTimerRef.current = null;
    }
    const { dx, dy, hostId } = pendingMoveRef.current;
    if ((dx !== 0 || dy !== 0) && hostId) {
      pendingMoveRef.current.dx = 0;
      pendingMoveRef.current.dy = 0;
      onSendInput({ type: 'mousemove', x: 0, y: 0, relative: true, dx, dy }, hostId, 'touch');
    }
  }, [onSendInput]);

  const flushScroll = useCallback(() => {
    if (scrollTimerRef.current !== null) {
      window.clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = null;
    }
    const { dx, dy, hostId } = pendingScrollRef.current;
    if ((Math.abs(dx) >= MIN_SCROLL_DELTA || Math.abs(dy) >= MIN_SCROLL_DELTA) && hostId) {
      pendingScrollRef.current.dx = 0;
      pendingScrollRef.current.dy = 0;
      onSendInput(
        { type: 'scroll', deltaX: Number(dx.toFixed(2)), deltaY: Number(dy.toFixed(2)) },
        hostId,
        'touch',
      );
    }
  }, [onSendInput]);

  const queueMove = useCallback(
    (dx: number, dy: number, hostId: string) => {
      if (dx === 0 && dy === 0) return;
      pendingMoveRef.current.hostId = hostId;
      pendingMoveRef.current.dx += dx;
      pendingMoveRef.current.dy += dy;
      if (moveTimerRef.current === null) {
        moveTimerRef.current = window.setTimeout(flushMove, MOVE_FLUSH_MS);
      }
    },
    [flushMove],
  );

  const queueScroll = useCallback(
    (deltaX: number, deltaY: number, hostId: string) => {
      pendingScrollRef.current.hostId = hostId;
      pendingScrollRef.current.dx += deltaX;
      pendingScrollRef.current.dy += deltaY;
      if (scrollTimerRef.current === null) {
        scrollTimerRef.current = window.setTimeout(flushScroll, SCROLL_FLUSH_MS);
      }
    },
    [flushScroll],
  );

  useEffect(
    () => () => {
      if (moveTimerRef.current !== null) window.clearTimeout(moveTimerRef.current);
      if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
    },
    [],
  );

  return { queueMove, flushMove, queueScroll, flushScroll };
}
