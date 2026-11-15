import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Keyboard,
  Lock,
  Maximize2,
  Minimize2,
  Monitor,
  MousePointerClick,
  QrCode,
  Send,
  Touchpad,
  Wifi,
  WifiOff,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { HostProfile, RemoteInputEvent } from '../types/deskbridge';
import { AIAssistantPanel } from './AIAssistantPanel';

type StreamQualityPreset = 'sd' | 'hd' | 'ultra';

const QUALITY_PRESETS: Record<StreamQualityPreset, { label: string; maxWidth: number; jpegQuality: number }> = {
  sd: { label: 'SD', maxWidth: 854, jpegQuality: 52 },
  hd: { label: 'HD', maxWidth: 1152, jpegQuality: 62 },
  ultra: { label: 'Ultra', maxWidth: 1600, jpegQuality: 78 },
};

interface TouchControlDeckProps {
  hosts: HostProfile[];
  activeHost: HostProfile | null;
  activeFrame: string | null;
  onSelectHost: (hostId: string) => void;
  onSendInput: (input: RemoteInputEvent, targetHostId?: string, source?: 'touch' | 'keyboard' | 'ai') => void;
  onOpenQrScanner: () => void;
  onOpenHostSetup: () => void;
}

export function TouchControlDeck({
  hosts,
  activeHost,
  activeFrame,
  onSelectHost,
  onSendInput,
  onOpenQrScanner,
  onOpenHostSetup,
}: TouchControlDeckProps) {
  const [inputMode, setInputMode] = useState<'trackpad' | 'direct'>('trackpad');
  const [streamQuality, setStreamQuality] = useState<StreamQualityPreset>('hd');
  const [zoomed, setZoomed] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hudHidden, setHudHidden] = useState(false);
  const [showFullscreenTrackpad, setShowFullscreenTrackpad] = useState(false);
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [showMobileAI, setShowMobileAI] = useState(false);
  const [textBuffer, setTextBuffer] = useState('');
  const [liveTyping, setLiveTyping] = useState(true);
  const [sensitivity, setSensitivity] = useState(3.2);
  const [tapFeedback, setTapFeedback] = useState<{ x: number; y: number; id: number } | null>(null);

  const streamImgRef = useRef<HTMLImageElement | null>(null);
  const keyboardInputRef = useRef<HTMLInputElement | null>(null);
  const enteredNativeFsRef = useRef(false);
  const showKeyboardRef = useRef(false);
  showKeyboardRef.current = showKeyboard;
  const keyboardFocusLockRef = useRef(false);

  const pointersMapRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const twoFingerTapRef = useRef<boolean>(false);
  const twoFingerMovedRef = useRef<boolean>(false);
  const twoFingerMidRef = useRef<{ x: number; y: number } | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number; startX: number; startY: number; startTime: number } | null>(null);
  const lastTapTimeRef = useRef<number>(0);

  const directPointerRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    nx: number;
    ny: number;
    isScrolling: boolean;
    scrollCursorMoved: boolean;
  } | null>(null);

  // Coalesce high-frequency pointermove events (~120Hz on mobile/iPad) into 16ms batches (~60Hz)
  const pendingMoveRef = useRef<{ dx: number; dy: number; hostId: string | null }>({
    dx: 0,
    dy: 0,
    hostId: null,
  });
  const moveFlushTimerRef = useRef<number | null>(null);

  // Coalesce high-frequency scroll gestures into 24ms wheel batches
  const pendingScrollRef = useRef<{ dx: number; dy: number; hostId: string | null }>({
    dx: 0,
    dy: 0,
    hostId: null,
  });
  const scrollFlushTimerRef = useRef<number | null>(null);

  const flushPendingMove = useCallback(() => {
    if (moveFlushTimerRef.current !== null) {
      window.clearTimeout(moveFlushTimerRef.current);
      moveFlushTimerRef.current = null;
    }
    const { dx, dy, hostId } = pendingMoveRef.current;
    if ((dx !== 0 || dy !== 0) && hostId) {
      pendingMoveRef.current.dx = 0;
      pendingMoveRef.current.dy = 0;
      onSendInput({ type: 'mousemove', x: 0, y: 0, relative: true, dx, dy }, hostId, 'touch');
    }
  }, [onSendInput]);

  const flushPendingScroll = useCallback(() => {
    if (scrollFlushTimerRef.current !== null) {
      window.clearTimeout(scrollFlushTimerRef.current);
      scrollFlushTimerRef.current = null;
    }
    const { dx, dy, hostId } = pendingScrollRef.current;
    if ((Math.abs(dx) >= 0.15 || Math.abs(dy) >= 0.15) && hostId) {
      pendingScrollRef.current.dx = 0;
      pendingScrollRef.current.dy = 0;
      onSendInput(
        { type: 'scroll', deltaX: Number(dx.toFixed(2)), deltaY: Number(dy.toFixed(2)) },
        hostId,
        'touch',
      );
    }
  }, [onSendInput]);

  const queueScroll = useCallback(
    (deltaX: number, deltaY: number, hostId: string) => {
      pendingScrollRef.current.hostId = hostId;
      pendingScrollRef.current.dx += deltaX;
      pendingScrollRef.current.dy += deltaY;
      if (scrollFlushTimerRef.current === null) {
        scrollFlushTimerRef.current = window.setTimeout(flushPendingScroll, 24);
      }
    },
    [flushPendingScroll],
  );

  useEffect(() => {
    return () => {
      if (moveFlushTimerRef.current !== null) {
        window.clearTimeout(moveFlushTimerRef.current);
      }
      if (scrollFlushTimerRef.current !== null) {
        window.clearTimeout(scrollFlushTimerRef.current);
      }
    };
  }, []);

  // Lock body scroll while fullscreen overlay is active (prevents iPad/iPhone Safari page bounce)
  useEffect(() => {
    if (!isFullscreen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isFullscreen]);

  useEffect(() => {
    const handleFsChange = () => {
      const docAny = document as Document & { webkitFullscreenElement?: Element | null };
      const fsEl = document.fullscreenElement || docAny.webkitFullscreenElement;
      if (!fsEl && enteredNativeFsRef.current) {
        enteredNativeFsRef.current = false;
        const activeTag = document.activeElement?.tagName;
        if (
          showKeyboardRef.current ||
          keyboardFocusLockRef.current ||
          activeTag === 'INPUT' ||
          activeTag === 'TEXTAREA'
        ) {
          if (showKeyboardRef.current) {
            window.setTimeout(() => keyboardInputRef.current?.focus(), 40);
          }
          return;
        }
        setIsFullscreen(false);
        setHudHidden(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isFullscreen || !activeHost || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const lower = e.key.toLowerCase();
        if (lower === 'c') {
          e.preventDefault();
          onSendInput({ type: 'hotkey', combo: 'Ctrl+C' }, activeHost.hostId, 'keyboard');
          return;
        }
        if (lower === 'v') {
          e.preventDefault();
          onSendInput({ type: 'hotkey', combo: 'Ctrl+V' }, activeHost.hostId, 'keyboard');
          return;
        }
        if (lower === 's') {
          e.preventDefault();
          onSendInput({ type: 'hotkey', combo: 'Ctrl+S' }, activeHost.hostId, 'keyboard');
          return;
        }
      }

      if (e.altKey && e.key === 'Tab') {
        e.preventDefault();
        onSendInput({ type: 'hotkey', combo: 'Alt+Tab' }, activeHost.hostId, 'keyboard');
        return;
      }

      const specialKeys = new Set([
        'Enter',
        'Tab',
        'Escape',
        'Backspace',
        'Delete',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
      ]);
      if (specialKeys.has(e.key)) {
        e.preventDefault();
        onSendInput({ type: 'key', key: e.key }, activeHost.hostId, 'keyboard');
        return;
      }

      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        onSendInput({ type: 'type', text: e.key }, activeHost.hostId, 'keyboard');
      }
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    document.addEventListener('webkitfullscreenchange', handleFsChange);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
      document.removeEventListener('webkitfullscreenchange', handleFsChange);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isFullscreen, activeHost, onSendInput]);

  // Call requestFullscreen synchronously inside user gesture for iPadOS Safari + Android Chrome
  const enterFullscreen = () => {
    setHudHidden(false);
    setIsFullscreen(true);
    try {
      const root = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void> | void;
      };
      const req = root.requestFullscreen?.() ?? root.webkitRequestFullscreen?.();
      if (req && typeof (req as Promise<void>).then === 'function') {
        (req as Promise<void>)
          .then(() => {
            enteredNativeFsRef.current = true;
          })
          .catch(() => {
            enteredNativeFsRef.current = false;
          });
      }
    } catch {
      enteredNativeFsRef.current = false;
    }
  };

  const exitFullscreen = async () => {
    enteredNativeFsRef.current = false;
    keyboardFocusLockRef.current = false;
    showKeyboardRef.current = false;
    setShowKeyboard(false);
    keyboardInputRef.current?.blur();
    setIsFullscreen(false);
    setHudHidden(false);
    try {
      const docAny = document as Document & {
        webkitFullscreenElement?: Element | null;
        webkitExitFullscreen?: () => Promise<void> | void;
      };
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (docAny.webkitFullscreenElement && docAny.webkitExitFullscreen) {
        await docAny.webkitExitFullscreen();
      }
    } catch {
      // ignore exitFullscreen failure
    }
  };

  const handleQualityChange = (preset: StreamQualityPreset) => {
    setStreamQuality(preset);
    if (!activeHost) return;
    const cfg = QUALITY_PRESETS[preset];
    onSendInput(
      { type: 'quality', maxWidth: cfg.maxWidth, jpegQuality: cfg.jpegQuality },
      activeHost.hostId,
      'touch',
    );
  };

  if (!activeHost) {
    return (
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 sm:p-12 text-center space-y-5">
        <div className="w-12 h-12 rounded-xl bg-blue-600/10 text-blue-600 dark:text-blue-400 flex items-center justify-center mx-auto">
          <Monitor className="w-6 h-6" />
        </div>
        <div className="space-y-2 max-w-md mx-auto">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
            Select or pair a Windows computer
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Scan a QR code on your Windows PC or open the Windows Host app to stream a live desktop into the Control Deck.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={onOpenQrScanner}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors"
          >
            <QrCode className="w-4 h-4" />
            <span>Scan QR Code</span>
          </button>
          <button
            type="button"
            onClick={onOpenHostSetup}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium transition-colors"
          >
            <Monitor className="w-4 h-4" />
            <span>Open Windows Host</span>
          </button>
        </div>
      </div>
    );
  }

  const computeNormalizedCoords = (clientX: number, clientY: number, fallbackEl: HTMLElement) => {
    const img = streamImgRef.current;
    const rect = (img || fallbackEl).getBoundingClientRect();
    let left = rect.left;
    let top = rect.top;
    let width = rect.width;
    let height = rect.height;

    if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
      const imgRatio = img.naturalWidth / img.naturalHeight;
      const boxRatio = rect.width / rect.height;
      if (imgRatio > boxRatio) {
        height = rect.width / imgRatio;
        top = rect.top + (rect.height - height) / 2;
      } else {
        width = rect.height * imgRatio;
        left = rect.left + (rect.width - width) / 2;
      }
    }

    const nx = Math.max(0, Math.min(1, (clientX - left) / width));
    const ny = Math.max(0, Math.min(1, (clientY - top) / height));
    return { nx, ny };
  };

  const handleDirectPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button === 2) {
      const { nx, ny } = computeNormalizedCoords(e.clientX, e.clientY, e.currentTarget);
      onSendInput({ type: 'click', button: 'right', x: nx, y: ny }, activeHost.hostId, 'touch');
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const { nx, ny } = computeNormalizedCoords(e.clientX, e.clientY, e.currentTarget);
    directPointerRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      nx,
      ny,
      isScrolling: false,
      scrollCursorMoved: false,
    };
  };

  const handleDirectPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const dp = directPointerRef.current;
    if (!dp || dp.pointerId !== e.pointerId) return;
    const totalDist = Math.hypot(e.clientX - dp.startX, e.clientY - dp.startY);
    if (!dp.isScrolling && totalDist > 10) {
      dp.isScrolling = true;
      if (!dp.scrollCursorMoved) {
        dp.scrollCursorMoved = true;
        onSendInput({ type: 'mousemove', x: dp.nx, y: dp.ny, relative: false }, activeHost.hostId, 'touch');
      }
    }
    if (dp.isScrolling) {
      const dy = e.clientY - dp.lastY;
      const dx = e.clientX - dp.lastX;
      dp.lastX = e.clientX;
      dp.lastY = e.clientY;
      queueScroll(-dx / 18, -dy / 12, activeHost.hostId);
    }
  };

  const handleDirectPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const dp = directPointerRef.current;
    if (!dp || dp.pointerId !== e.pointerId) return;
    directPointerRef.current = null;
    flushPendingScroll();

    if (dp.isScrolling) return;

    const now = Date.now();
    const isDouble = now - lastTapTimeRef.current < 320;
    lastTapTimeRef.current = now;

    const containerRect = e.currentTarget.getBoundingClientRect();
    const fbX = ((e.clientX - containerRect.left) / containerRect.width) * 100;
    const fbY = ((e.clientY - containerRect.top) / containerRect.height) * 100;
    setTapFeedback({ x: fbX, y: fbY, id: now });
    window.setTimeout(() => setTapFeedback(null), 350);

    onSendInput({ type: 'click', button: 'left', double: isDouble, x: dp.nx, y: dp.ny }, activeHost.hostId, 'touch');
  };

  const handleDirectPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (directPointerRef.current?.pointerId === e.pointerId) {
      directPointerRef.current = null;
      flushPendingScroll();
    }
  };

  const handleTrackpadPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointersMapRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersMapRef.current.size >= 2) {
      twoFingerTapRef.current = true;
      twoFingerMovedRef.current = false;
      const pts = Array.from(pointersMapRef.current.values());
      twoFingerMidRef.current = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
      };
    } else {
      twoFingerTapRef.current = false;
      twoFingerMovedRef.current = false;
      twoFingerMidRef.current = null;
      lastPointerRef.current = {
        x: e.clientX,
        y: e.clientY,
        startX: e.clientX,
        startY: e.clientY,
        startTime: Date.now(),
      };
    }
  };

  const handleTrackpadPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointersMapRef.current.has(e.pointerId)) {
      pointersMapRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (pointersMapRef.current.size >= 2) {
      const pts = Array.from(pointersMapRef.current.values());
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      if (twoFingerMidRef.current) {
        const dx = midX - twoFingerMidRef.current.x;
        const dy = midY - twoFingerMidRef.current.y;
        if (Math.hypot(dx, dy) > 2) {
          twoFingerMovedRef.current = true;
        }
        queueScroll(-dx / 18, -dy / 10, activeHost.hostId);
      }
      twoFingerMidRef.current = { x: midX, y: midY };
      return;
    }

    if (!lastPointerRef.current) return;
    const rawDx = e.clientX - lastPointerRef.current.x;
    const rawDy = e.clientY - lastPointerRef.current.y;
    lastPointerRef.current.x = e.clientX;
    lastPointerRef.current.y = e.clientY;

    const speed = Math.hypot(rawDx, rawDy);
    const accel = speed > 12 ? 1.75 : speed > 5 ? 1.25 : 1.0;
    const dx = Math.round(rawDx * sensitivity * accel);
    const dy = Math.round(rawDy * sensitivity * accel);

    if (dx !== 0 || dy !== 0) {
      pendingMoveRef.current.hostId = activeHost.hostId;
      pendingMoveRef.current.dx += dx;
      pendingMoveRef.current.dy += dy;
      if (moveFlushTimerRef.current === null) {
        moveFlushTimerRef.current = window.setTimeout(flushPendingMove, 16);
      }
    }
  };

  const handleTrackpadPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersMapRef.current.delete(e.pointerId);
    flushPendingMove();
    flushPendingScroll();

    if (pointersMapRef.current.size === 1) {
      const remaining = Array.from(pointersMapRef.current.values())[0];
      twoFingerMidRef.current = null;
      lastPointerRef.current = {
        x: remaining.x,
        y: remaining.y,
        startX: remaining.x,
        startY: remaining.y,
        startTime: Date.now(),
      };
      return;
    }

    if (pointersMapRef.current.size === 0) {
      twoFingerMidRef.current = null;
      const lp = lastPointerRef.current;
      lastPointerRef.current = null;

      if (twoFingerTapRef.current) {
        const wasTap = !twoFingerMovedRef.current;
        twoFingerTapRef.current = false;
        twoFingerMovedRef.current = false;
        if (wasTap) {
          onSendInput({ type: 'click', button: 'right' }, activeHost.hostId, 'touch');
        }
        return;
      }

      if (lp) {
        const dist = Math.hypot(e.clientX - lp.startX, e.clientY - lp.startY);
        const elapsed = Date.now() - lp.startTime;
        if (dist < 10 && elapsed < 260) {
          const now = Date.now();
          const isDouble = now - lastTapTimeRef.current < 300;
          lastTapTimeRef.current = now;
          onSendInput({ type: 'click', button: 'left', double: isDouble }, activeHost.hostId, 'touch');
        }
      }
    }
  };

  const handleViewportWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (zoomed) return;
    const scale = e.deltaMode === 1 ? 1 : 1 / 40;
    const dy = e.deltaY * scale;
    const dx = e.deltaX * scale;
    if (dx !== 0 || dy !== 0) {
      queueScroll(dx, dy, activeHost.hostId);
    }
  };

  const handleSendTextSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (liveTyping) {
      onSendInput({ type: 'key', key: 'Enter' }, activeHost.hostId, 'keyboard');
      setTextBuffer('');
      return;
    }
    if (!textBuffer) {
      onSendInput({ type: 'key', key: 'Enter' }, activeHost.hostId, 'keyboard');
      return;
    }
    onSendInput({ type: 'type', text: textBuffer }, activeHost.hostId, 'keyboard');
    setTextBuffer('');
  };

  const handleTextChange = (val: string) => {
    if (liveTyping) {
      let common = 0;
      const minLen = Math.min(textBuffer.length, val.length);
      while (common < minLen && textBuffer[common] === val[common]) {
        common++;
      }
      const deletions = textBuffer.length - common;
      for (let i = 0; i < deletions; i++) {
        onSendInput({ type: 'key', key: 'Backspace' }, activeHost.hostId, 'keyboard');
      }
      const addition = val.slice(common);
      if (addition.length > 0) {
        onSendInput({ type: 'type', text: addition }, activeHost.hostId, 'keyboard');
      }
    }
    setTextBuffer(val);
  };

  const handleKeyboardInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && textBuffer.length === 0) {
      e.preventDefault();
      onSendInput({ type: 'key', key: 'Backspace' }, activeHost.hostId, 'keyboard');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onSendInput({ type: 'key', key: 'Tab' }, activeHost.hostId, 'keyboard');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onSendInput({ type: 'key', key: 'Escape' }, activeHost.hostId, 'keyboard');
    }
  };

  const toggleKeyboardDrawer = () => {
    const next = !showKeyboard;
    showKeyboardRef.current = next;
    keyboardFocusLockRef.current = next;
    setShowKeyboard(next);
    if (next) {
      keyboardInputRef.current?.focus();
    } else {
      keyboardInputRef.current?.blur();
    }
  };

  const renderDesktopStreamViewport = (fullscreen: boolean) => {
    const useGestureTrackpad = fullscreen && inputMode === 'trackpad' && !showFullscreenTrackpad;
    return (
      <div
        onWheel={handleViewportWheel}
        className={`relative bg-black select-none ${
          zoomed ? 'overflow-auto' : 'overflow-hidden'
        } ${fullscreen ? 'w-full h-full flex items-center justify-center' : 'bg-slate-950'} ${
          !zoomed ? 'touch-none' : ''
        } ${useGestureTrackpad ? '' : 'cursor-crosshair'}`}
      >
        <div
          onPointerDown={useGestureTrackpad ? handleTrackpadPointerDown : handleDirectPointerDown}
          onPointerMove={useGestureTrackpad ? handleTrackpadPointerMove : handleDirectPointerMove}
          onPointerUp={useGestureTrackpad ? handleTrackpadPointerUp : handleDirectPointerUp}
          onPointerCancel={useGestureTrackpad ? handleTrackpadPointerUp : handleDirectPointerCancel}
          onContextMenu={(e) => e.preventDefault()}
          className={`relative flex items-center justify-center transition-transform duration-200 ${
            fullscreen ? 'w-full h-full' : 'aspect-video w-full'
          } ${zoomed ? 'scale-150 origin-center' : 'scale-100'}`}
        >
          {activeFrame ? (
            <img
              ref={streamImgRef}
              src={activeFrame}
              alt={`Live desktop stream of ${activeHost.name}`}
              referrerPolicy="no-referrer"
              draggable={false}
              className="w-full h-full max-w-full max-h-full object-contain pointer-events-none select-none"
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-slate-400">
              <Monitor className="w-10 h-10 text-slate-600" />
              <p className="text-sm font-medium text-slate-300">
                {activeHost.status === 'online'
                  ? 'Waiting for next video frame from Windows host...'
                  : `${activeHost.name} is offline`}
              </p>
              <p className="text-xs text-slate-500 max-w-sm">
                {activeHost.status === 'online'
                  ? 'Touchpad, keyboard, and AI commands are active.'
                  : 'Start the DeskBridge Host agent on that computer to resume streaming.'}
              </p>
            </div>
          )}

          {tapFeedback && (
            <div
              key={tapFeedback.id}
              style={{ left: `${tapFeedback.x}%`, top: `${tapFeedback.y}%` }}
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full border-2 border-blue-400 bg-blue-500/20"
            />
          )}
        </div>
      </div>
    );
  };

  const renderKeyboardDrawer = (compact = false) => (
    <div
      className={`rounded-2xl border border-slate-200 dark:border-slate-800 ${
        compact ? 'bg-slate-900/95 backdrop-blur-md p-3 shadow-2xl border-slate-700/80' : 'bg-white dark:bg-slate-900 p-4'
      } space-y-2.5`}
    >
      <form onSubmit={handleSendTextSubmit} className="flex items-center gap-2">
        <input
          ref={compact ? keyboardInputRef : undefined}
          type="text"
          value={textBuffer}
          onChange={(e) => handleTextChange(e.target.value)}
          onKeyDown={handleKeyboardInputKeyDown}
          onFocus={() => {
            keyboardFocusLockRef.current = true;
          }}
          onBlur={() => {
            window.setTimeout(() => {
              if (!showKeyboardRef.current) {
                keyboardFocusLockRef.current = false;
              }
            }, 350);
          }}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="send"
          tabIndex={compact && !showKeyboard ? -1 : 0}
          placeholder={liveTyping ? 'Type live keystrokes to Windows...' : 'Type text to send to Windows...'}
          className={`flex-1 min-h-[44px] px-3.5 py-2 rounded-xl border text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 ${
            compact
              ? 'bg-slate-950 border-slate-700 text-white'
              : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white'
          }`}
        />
        <button
          type="submit"
          className="min-h-[44px] px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 shrink-0"
        >
          <Send className="w-3.5 h-3.5" />
          <span>{liveTyping ? 'Enter' : 'Send'}</span>
        </button>
        {compact && (
          <button
            type="button"
            onClick={() => {
              showKeyboardRef.current = false;
              keyboardFocusLockRef.current = false;
              setShowKeyboard(false);
              keyboardInputRef.current?.blur();
            }}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-slate-800 text-slate-300 hover:text-white shrink-0"
            aria-label="Close keyboard"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </form>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete'] as const).map((keyName) => (
            <button
              key={keyName}
              type="button"
              onClick={() => onSendInput({ type: 'key', key: keyName }, activeHost.hostId, 'keyboard')}
              className={`min-h-[38px] px-2.5 py-1 rounded-lg border text-xs font-mono hover:border-blue-500 ${
                compact
                  ? 'border-slate-700 bg-slate-950 text-slate-200'
                  : 'border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-200'
              }`}
            >
              {keyName === 'Escape' ? 'Esc' : keyName}
            </button>
          ))}
          <button
            type="button"
            onClick={() => onSendInput({ type: 'type', text: ' ' }, activeHost.hostId, 'keyboard')}
            className={`min-h-[38px] px-2.5 py-1 rounded-lg border text-xs font-mono hover:border-blue-500 ${
              compact
                ? 'border-slate-700 bg-slate-950 text-slate-200'
                : 'border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-200'
            }`}
          >
            Space
          </button>
          <button
            type="button"
            onClick={() => onSendInput({ type: 'key', key: 'ArrowLeft' }, activeHost.hostId, 'keyboard')}
            className={`min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg border ${
              compact
                ? 'border-slate-700 bg-slate-950 text-slate-200'
                : 'border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-200'
            }`}
            aria-label="Left arrow"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => onSendInput({ type: 'key', key: 'ArrowUp' }, activeHost.hostId, 'keyboard')}
            className={`min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg border ${
              compact
                ? 'border-slate-700 bg-slate-950 text-slate-200'
                : 'border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-200'
            }`}
            aria-label="Up arrow"
          >
            <ArrowUp className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => onSendInput({ type: 'key', key: 'ArrowDown' }, activeHost.hostId, 'keyboard')}
            className={`min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg border ${
              compact
                ? 'border-slate-700 bg-slate-950 text-slate-200'
                : 'border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-200'
            }`}
            aria-label="Down arrow"
          >
            <ArrowDown className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => onSendInput({ type: 'key', key: 'ArrowRight' }, activeHost.hostId, 'keyboard')}
            className={`min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg border ${
              compact
                ? 'border-slate-700 bg-slate-950 text-slate-200'
                : 'border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-200'
            }`}
            aria-label="Right arrow"
          >
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>

        <label className="inline-flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={liveTyping}
            onChange={(e) => setLiveTyping(e.target.checked)}
            className="rounded border-slate-300 dark:border-slate-700 text-blue-600"
          />
          <span>Live keystrokes</span>
        </label>
      </div>
    </div>
  );

  const renderTrackpadPanel = (fullscreenOverlay = false) => (
    <div
      className={
        fullscreenOverlay
          ? 'bg-slate-950/90 backdrop-blur-md border-t border-slate-800 p-2.5 space-y-2 pb-safe'
          : 'rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 space-y-2.5'
      }
    >
      <div className="flex items-center justify-between px-1 text-xs text-slate-400">
        <span>Drag = move · 2-finger drag = scroll · Tap = click</span>
        <label className="inline-flex items-center gap-2 shrink-0 ml-2">
          <span>Speed</span>
          <input
            type="range"
            min={1.0}
            max={6.0}
            step={0.2}
            value={sensitivity}
            onChange={(e) => setSensitivity(Number(e.target.value))}
            className="w-20 accent-blue-600"
          />
        </label>
      </div>

      <div className="grid grid-cols-12 gap-2">
        <div
          onPointerDown={handleTrackpadPointerDown}
          onPointerMove={handleTrackpadPointerMove}
          onPointerUp={handleTrackpadPointerUp}
          onPointerCancel={handleTrackpadPointerUp}
          className={`col-span-10 ${
            fullscreenOverlay ? 'h-32 sm:h-36 bg-slate-900 border-slate-800' : 'h-44 sm:h-48 bg-slate-100 dark:bg-slate-950 border-slate-200 dark:border-slate-800'
          } rounded-xl border touch-none select-none flex flex-col items-center justify-center gap-1 text-slate-400 dark:text-slate-500 active:border-blue-500 transition-colors`}
        >
          <Touchpad className="w-5 h-5" />
          <span className="text-xs font-medium">Touchpad Surface</span>
        </div>

        <div className="col-span-2 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => onSendInput({ type: 'scroll', deltaX: 0, deltaY: -5 }, activeHost.hostId, 'touch')}
            className={`flex-1 min-h-[40px] rounded-xl border flex items-center justify-center active:scale-[0.98] ${
              fullscreenOverlay
                ? 'bg-slate-900 border-slate-800 text-slate-200'
                : 'bg-slate-100 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
            }`}
            aria-label="Scroll up"
          >
            <ChevronUp className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={() => onSendInput({ type: 'scroll', deltaX: 0, deltaY: 5 }, activeHost.hostId, 'touch')}
            className={`flex-1 min-h-[40px] rounded-xl border flex items-center justify-center active:scale-[0.98] ${
              fullscreenOverlay
                ? 'bg-slate-900 border-slate-800 text-slate-200'
                : 'bg-slate-100 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
            }`}
            aria-label="Scroll down"
          >
            <ChevronDown className="w-5 h-5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onSendInput({ type: 'click', button: 'left' }, activeHost.hostId, 'touch')}
          className={`min-h-[44px] rounded-xl text-sm font-medium active:scale-[0.98] transition-transform ${
            fullscreenOverlay
              ? 'bg-slate-800 hover:bg-slate-700 text-white'
              : 'bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-900 dark:text-white'
          }`}
        >
          Left Click
        </button>
        <button
          type="button"
          onClick={() => onSendInput({ type: 'click', button: 'right' }, activeHost.hostId, 'touch')}
          className={`min-h-[44px] rounded-xl text-sm font-medium active:scale-[0.98] transition-transform ${
            fullscreenOverlay
              ? 'bg-slate-800 hover:bg-slate-700 text-white'
              : 'bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-900 dark:text-white'
          }`}
        >
          Right Click
        </button>
      </div>
    </div>
  );

  const fullscreenOverlay = isFullscreen
    ? createPortal(
        <div
          className="fixed inset-0 z-[9999] w-screen h-[100dvh] bg-black overflow-hidden"
          role="dialog"
          aria-label="Full screen remote desktop"
        >
          {renderDesktopStreamViewport(true)}

          {/* Top-positioned fullscreen keyboard drawer stays above Android/iPad OS virtual keyboards */}
          <div
            aria-hidden={!showKeyboard}
            className={`absolute top-2 left-2 right-2 z-30 flex justify-center pt-safe transition-opacity duration-150 ${
              showKeyboard ? 'pointer-events-none opacity-100' : 'pointer-events-none opacity-0 -translate-y-4'
            }`}
          >
            <div className={`${showKeyboard ? 'pointer-events-auto' : 'pointer-events-none'} w-full max-w-lg`}>
              {renderKeyboardDrawer(true)}
            </div>
          </div>

          {/* Bottom-positioned floating HUD keeps the entire top Windows titlebar / Edge tabs 100% clear */}
          {!hudHidden ? (
            <div className="absolute bottom-2 left-2 right-2 z-10 pointer-events-none flex flex-col items-center gap-2 pb-safe">
              {inputMode === 'trackpad' && showFullscreenTrackpad && (
                <div className="pointer-events-auto w-full max-w-md rounded-2xl overflow-hidden border border-slate-700/70 shadow-2xl">
                  {renderTrackpadPanel(true)}
                </div>
              )}

              <div className="pointer-events-auto max-w-full px-2.5 py-1.5 rounded-2xl bg-slate-950/80 backdrop-blur-md border border-slate-700/70 flex items-center gap-1.5 overflow-x-auto shadow-lg">
                <span className="text-xs font-semibold text-white truncate max-w-[96px] sm:max-w-[160px] pl-1">
                  {activeHost.name}
                </span>

                {hosts.length > 1 && (
                  <select
                    value={activeHost.hostId}
                    onChange={(e) => onSelectHost(e.target.value)}
                    aria-label="Switch computer"
                    className="min-h-[34px] px-2 py-0.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-200"
                  >
                    {hosts.map((h) => (
                      <option key={h.hostId} value={h.hostId}>
                        {h.groupLabel} · {h.name}
                      </option>
                    ))}
                  </select>
                )}

                <button
                  type="button"
                  onClick={() => setInputMode(inputMode === 'trackpad' ? 'direct' : 'trackpad')}
                  className="min-h-[36px] inline-flex items-center gap-1 px-2.5 rounded-xl bg-slate-800/90 text-xs font-medium text-white shrink-0"
                >
                  {inputMode === 'trackpad' ? (
                    <>
                      <Touchpad className="w-3.5 h-3.5 text-blue-400" />
                      <span>Drag Mouse</span>
                    </>
                  ) : (
                    <>
                      <MousePointerClick className="w-3.5 h-3.5 text-blue-400" />
                      <span>Tap Screen</span>
                    </>
                  )}
                </button>

                {inputMode === 'trackpad' && !showFullscreenTrackpad && (
                  <>
                    <button
                      type="button"
                      onClick={() => onSendInput({ type: 'click', button: 'left' }, activeHost.hostId, 'touch')}
                      className="min-h-[36px] px-2 rounded-xl bg-slate-800/90 text-xs font-medium text-white shrink-0"
                    >
                      L
                    </button>
                    <button
                      type="button"
                      onClick={() => onSendInput({ type: 'click', button: 'right' }, activeHost.hostId, 'touch')}
                      className="min-h-[36px] px-2 rounded-xl bg-slate-800/90 text-xs font-medium text-white shrink-0"
                    >
                      R
                    </button>
                    <button
                      type="button"
                      onClick={() => onSendInput({ type: 'scroll', deltaX: 0, deltaY: -5 }, activeHost.hostId, 'touch')}
                      className="min-h-[36px] min-w-[34px] rounded-xl bg-slate-800/90 text-slate-200 flex items-center justify-center shrink-0"
                      aria-label="Scroll up"
                    >
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onSendInput({ type: 'scroll', deltaX: 0, deltaY: 5 }, activeHost.hostId, 'touch')}
                      className="min-h-[36px] min-w-[34px] rounded-xl bg-slate-800/90 text-slate-200 flex items-center justify-center shrink-0"
                      aria-label="Scroll down"
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                  </>
                )}

                {inputMode === 'trackpad' && (
                  <button
                    type="button"
                    onClick={() => setShowFullscreenTrackpad((v) => !v)}
                    className={`min-h-[36px] px-2.5 rounded-xl text-xs font-medium shrink-0 ${
                      showFullscreenTrackpad ? 'bg-blue-600 text-white' : 'bg-slate-800/90 text-slate-300'
                    }`}
                  >
                    {showFullscreenTrackpad ? 'Hide Pad' : 'Pad'}
                  </button>
                )}

                <select
                  value={streamQuality}
                  onChange={(e) => handleQualityChange(e.target.value as StreamQualityPreset)}
                  aria-label="Stream quality"
                  className="min-h-[36px] px-2 rounded-xl bg-slate-800/90 border border-slate-700 text-xs font-medium text-slate-200 shrink-0"
                >
                  <option value="sd">SD</option>
                  <option value="hd">HD</option>
                  <option value="ultra">Ultra</option>
                </select>

                <button
                  type="button"
                  onClick={() => setZoomed((z) => !z)}
                  className={`min-h-[36px] min-w-[36px] flex items-center justify-center rounded-xl shrink-0 ${
                    zoomed ? 'bg-blue-600 text-white' : 'bg-slate-800/90 text-slate-200'
                  }`}
                  aria-label={zoomed ? 'Reset zoom' : 'Zoom screen'}
                >
                  {zoomed ? <ZoomOut className="w-4 h-4" /> : <ZoomIn className="w-4 h-4" />}
                </button>

                <button
                  type="button"
                  onClick={toggleKeyboardDrawer}
                  className={`min-h-[36px] min-w-[36px] flex items-center justify-center rounded-xl shrink-0 ${
                    showKeyboard ? 'bg-blue-600 text-white' : 'bg-slate-800/90 text-slate-200'
                  }`}
                  aria-label="Toggle keyboard"
                >
                  <Keyboard className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={() => setShowMobileAI(true)}
                  className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-xl bg-slate-800/90 text-blue-400 shrink-0"
                  aria-label="Open AI Voice Assistant"
                >
                  <Bot className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={() => setHudHidden(true)}
                  className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-xl bg-slate-800/90 text-slate-300 shrink-0"
                  aria-label="Hide controls"
                >
                  <EyeOff className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={exitFullscreen}
                  className="min-h-[36px] inline-flex items-center gap-1 px-2.5 rounded-xl bg-red-600/90 hover:bg-red-600 text-xs font-semibold text-white shrink-0"
                  aria-label="Exit full screen"
                >
                  <Minimize2 className="w-3.5 h-3.5" />
                  <span>Exit</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="fixed bottom-3 left-3 z-[10000] flex items-center gap-1.5 pb-safe">
              <button
                type="button"
                onClick={() => setHudHidden(false)}
                className="min-h-[40px] px-3 rounded-full bg-slate-950/75 border border-slate-700 text-xs font-medium text-white backdrop-blur-md inline-flex items-center gap-1.5"
              >
                <Eye className="w-3.5 h-3.5" />
                <span>Controls</span>
              </button>
              <button
                type="button"
                onClick={exitFullscreen}
                className="min-h-[40px] min-w-[40px] rounded-full bg-slate-950/75 border border-slate-700 text-white backdrop-blur-md flex items-center justify-center"
                aria-label="Exit full screen"
              >
                <Minimize2 className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="space-y-4">
      {hosts.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {hosts.map((host) => {
            const selected = host.hostId === activeHost.hostId;
            return (
              <button
                key={host.hostId}
                type="button"
                onClick={() => onSelectHost(host.hostId)}
                className={`min-h-[40px] inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  selected
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                {host.status === 'online' ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                <span>{host.groupLabel}</span>
                <span aria-hidden="true">·</span>
                <span className="max-w-[140px] truncate">{host.name}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        <div className="lg:col-span-7 xl:col-span-8 space-y-3">
          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-semibold text-slate-900 dark:text-white truncate">
                    {activeHost.name}
                  </span>
                  <span aria-hidden="true" className="text-slate-400">·</span>
                  <span className="text-slate-500 dark:text-slate-400 truncate">
                    {activeHost.activeWindow || 'Windows Desktop'}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800">
                  <button
                    type="button"
                    onClick={() => setInputMode('trackpad')}
                    className={`min-h-[34px] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                      inputMode === 'trackpad'
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    <Touchpad className="w-3.5 h-3.5" />
                    <span>Trackpad</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setInputMode('direct')}
                    className={`min-h-[34px] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                      inputMode === 'direct'
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    <MousePointerClick className="w-3.5 h-3.5" />
                    <span>Tap Screen</span>
                  </button>
                </div>

                <select
                  value={streamQuality}
                  onChange={(e) => handleQualityChange(e.target.value as StreamQualityPreset)}
                  aria-label="Stream quality"
                  className="min-h-[36px] px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200"
                >
                  <option value="sd">SD</option>
                  <option value="hd">HD</option>
                  <option value="ultra">Ultra</option>
                </select>

                <button
                  type="button"
                  onClick={() => setZoomed((z) => !z)}
                  className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                  aria-label={zoomed ? 'Reset zoom' : 'Zoom screen'}
                >
                  {zoomed ? <ZoomOut className="w-4 h-4" /> : <ZoomIn className="w-4 h-4" />}
                </button>

                <button
                  type="button"
                  onClick={enterFullscreen}
                  className="min-h-[36px] inline-flex items-center gap-1.5 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium"
                  aria-label="Enter full screen"
                >
                  <Maximize2 className="w-4 h-4" />
                  <span>Full Screen</span>
                </button>
              </div>
            </div>

            {!isFullscreen && renderDesktopStreamViewport(false)}

            <div className="px-3 py-2.5 border-t border-slate-200 dark:border-slate-800 flex items-center gap-2 overflow-x-auto">
              <button
                type="button"
                onClick={enterFullscreen}
                className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-xs font-medium whitespace-nowrap shrink-0"
              >
                <Maximize2 className="w-4 h-4" />
                <span>Full Screen</span>
              </button>

              <button
                type="button"
                onClick={() => setShowKeyboard((k) => !k)}
                className={`min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                  showKeyboard
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                }`}
              >
                <Keyboard className="w-4 h-4" />
                <span>Keyboard</span>
              </button>

              <button
                type="button"
                onClick={() => setShowMobileAI(true)}
                className="lg:hidden min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600/10 border border-blue-600/30 text-blue-600 dark:text-blue-400 text-xs font-semibold whitespace-nowrap shrink-0"
              >
                <Bot className="w-4 h-4" />
                <span>AI Voice</span>
              </button>

              {[
                { label: 'Win+D', combo: 'Win+D' },
                { label: 'Alt+Tab', combo: 'Alt+Tab' },
                { label: 'Copy', combo: 'Ctrl+C' },
                { label: 'Paste', combo: 'Ctrl+V' },
                { label: 'Task Mgr', combo: 'Ctrl+Shift+Esc' },
              ].map((sc) => (
                <button
                  key={sc.combo}
                  type="button"
                  onClick={() => onSendInput({ type: 'hotkey', combo: sc.combo }, activeHost.hostId, 'keyboard')}
                  className="min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs font-medium text-slate-700 dark:text-slate-300 hover:border-blue-500 transition-colors whitespace-nowrap shrink-0"
                >
                  {sc.label}
                </button>
              ))}

              <button
                type="button"
                onClick={() => onSendInput({ type: 'hotkey', combo: 'Win+L' }, activeHost.hostId, 'keyboard')}
                className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors whitespace-nowrap shrink-0"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Lock PC</span>
              </button>
            </div>
          </div>

          {showKeyboard && renderKeyboardDrawer(false)}

          {inputMode === 'trackpad' && renderTrackpadPanel(false)}
        </div>

        <div className="hidden lg:block lg:col-span-5 xl:col-span-4">
          <AIAssistantPanel
            activeHost={activeHost}
            hosts={hosts}
            activeFrame={activeFrame}
            onDispatchInput={(input, hostId) => onSendInput(input, hostId || activeHost.hostId, 'ai')}
            onSwitchHost={onSelectHost}
          />
        </div>
      </div>

      {fullscreenOverlay}

      {showMobileAI &&
        createPortal(
          <div
            className="fixed inset-0 z-[10001] lg:hidden flex items-end bg-black/60 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
          >
            <div className="w-full rounded-t-3xl bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800">
                <span className="text-sm font-semibold text-slate-900 dark:text-white">
                  AI Voice & Command Drawer
                </span>
                <button
                  type="button"
                  onClick={() => setShowMobileAI(false)}
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-500"
                  aria-label="Close AI drawer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-3">
                <AIAssistantPanel
                  compact
                  activeHost={activeHost}
                  hosts={hosts}
                  activeFrame={activeFrame}
                  onDispatchInput={(input, hostId) => onSendInput(input, hostId || activeHost.hostId, 'ai')}
                  onSwitchHost={onSelectHost}
                />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
