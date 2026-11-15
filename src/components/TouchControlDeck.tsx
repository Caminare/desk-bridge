import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, Bot, Keyboard, Lock, Maximize2, Monitor, MousePointerClick, QrCode, Touchpad, ZoomIn, ZoomOut } from 'lucide-react';
import type { HostProfile, RemoteInputEvent } from '../types/deskbridge';
import { useCoalescedPointerInput } from '../hooks/useCoalescedPointerInput';
import { mapToStreamCoords } from '../lib/streamCoords';
import type { FrameStore } from '../lib/frameCompositor';
import { AIAssistantPanel } from './AIAssistantPanel';
import { FullscreenHud, type InputMode } from './controlDeck/FullscreenHud';
import { HostChips } from './controlDeck/HostChips';
import { KeyboardDrawer, type KeyModifier } from './controlDeck/KeyboardDrawer';
import { MonitorPicker } from './controlDeck/MonitorPicker';
import { MobileAIDrawer } from './controlDeck/MobileAIDrawer';
import { QUALITY_OPTIONS, QUALITY_PRESETS, type StreamQualityPreset } from './controlDeck/qualityPresets';
import { StreamViewport } from './controlDeck/StreamViewport';
import { TrackpadPanel, type PointerHandlers } from './controlDeck/TrackpadPanel';

interface TouchControlDeckProps {
  hosts: HostProfile[];
  activeHost: HostProfile | null;
  activeFrame: string | null;
  frameStore: FrameStore;
  onSelectHost: (hostId: string) => void;
  onSendInput: (input: RemoteInputEvent, targetHostId?: string, source?: 'touch' | 'keyboard' | 'ai') => void;
  onOpenQrScanner: () => void;
  onOpenHostSetup: () => void;
}

export function TouchControlDeck({
  hosts,
  activeHost,
  activeFrame,
  frameStore,
  onSelectHost,
  onSendInput,
  onOpenQrScanner,
  onOpenHostSetup,
}: TouchControlDeckProps) {
  const [inputMode, setInputMode] = useState<InputMode>('trackpad');
  const [streamQuality, setStreamQuality] = useState<StreamQualityPreset>('hd');
  const [zoomed, setZoomed] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hudHidden, setHudHidden] = useState(false);
  const [showFullscreenTrackpad, setShowFullscreenTrackpad] = useState(false);
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [showMobileAI, setShowMobileAI] = useState(false);
  const [textBuffer, setTextBuffer] = useState('');
  const [liveTyping, setLiveTyping] = useState(true);
  const [modifiers, setModifiers] = useState<KeyModifier[]>([]);
  const [sensitivity, setSensitivity] = useState(3.2);
  const [tapFeedback, setTapFeedback] = useState<{ x: number; y: number; id: number } | null>(null);

  const streamCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [showStats, setShowStats] = useState(false);
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

  const { queueMove, flushMove, queueScroll, flushScroll } = useCoalescedPointerInput(onSendInput);

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
    const canvas = streamCanvasRef.current;
    const rect = (canvas && canvas.width > 0 ? canvas : fallbackEl).getBoundingClientRect();
    const natural = canvas && canvas.width > 0 ? { width: canvas.width, height: canvas.height } : undefined;
    return mapToStreamCoords(clientX, clientY, rect, natural);
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
    flushScroll();

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
      flushScroll();
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

    queueMove(dx, dy, activeHost.hostId);
  };

  const handleTrackpadPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersMapRef.current.delete(e.pointerId);
    flushMove();
    flushScroll();

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
    if (modifiers.length > 0 && val.length > textBuffer.length) {
      // With sticky modifiers active, a typed character becomes a shortcut (e.g. Ctrl + c),
      // not text, and is kept out of the buffer.
      sendKey(val.slice(-1));
      return;
    }
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

  const trackpadHandlers: PointerHandlers = {
    onPointerDown: handleTrackpadPointerDown,
    onPointerMove: handleTrackpadPointerMove,
    onPointerUp: handleTrackpadPointerUp,
    onPointerCancel: handleTrackpadPointerUp,
  };
  const directHandlers: PointerHandlers = {
    onPointerDown: handleDirectPointerDown,
    onPointerMove: handleDirectPointerMove,
    onPointerUp: handleDirectPointerUp,
    onPointerCancel: handleDirectPointerCancel,
  };

  const sendClick = (button: 'left' | 'right') => onSendInput({ type: 'click', button }, activeHost.hostId, 'touch');
  const sendScroll = (deltaY: number) => onSendInput({ type: 'scroll', deltaX: 0, deltaY }, activeHost.hostId, 'touch');
  const sendKey = (key: string) => {
    if (modifiers.length > 0) {
      onSendInput({ type: 'key', key, modifiers }, activeHost.hostId, 'keyboard');
      setModifiers([]);
      return;
    }
    onSendInput({ type: 'key', key }, activeHost.hostId, 'keyboard');
  };
  const sendCombo = (combo: string) => onSendInput({ type: 'hotkey', combo }, activeHost.hostId, 'keyboard');
  const toggleModifier = (m: KeyModifier) =>
    setModifiers((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  const selectMonitor = (index: number) => onSendInput({ type: 'monitor', index }, activeHost.hostId, 'touch');
  const sendText = (text: string) => onSendInput({ type: 'type', text }, activeHost.hostId, 'keyboard');
  const getScreenshot = () => frameStore.peek(activeHost.hostId)?.toDataUrl();
  const dispatchAiInput = (input: RemoteInputEvent, hostId?: string) =>
    onSendInput(input, hostId || activeHost.hostId, 'ai');

  const closeKeyboard = () => {
    showKeyboardRef.current = false;
    keyboardFocusLockRef.current = false;
    setShowKeyboard(false);
    keyboardInputRef.current?.blur();
  };

  const renderDesktopStreamViewport = (fullscreen: boolean) => {
    const useGestureTrackpad = fullscreen && inputMode === 'trackpad' && !showFullscreenTrackpad;
    return (
      <StreamViewport
        host={activeHost}
        frameStore={frameStore}
        fullscreen={fullscreen}
        showStats={showStats}
        zoomed={zoomed}
        crosshair={!useGestureTrackpad}
        pointerHandlers={useGestureTrackpad ? trackpadHandlers : directHandlers}
        onWheel={handleViewportWheel}
        canvasRef={streamCanvasRef}
        tapFeedback={tapFeedback}
      />
    );
  };

  const renderKeyboardDrawer = (compact = false) => (
    <KeyboardDrawer
      compact={compact}
      visible={showKeyboard}
      value={textBuffer}
      liveTyping={liveTyping}
      inputRef={compact ? keyboardInputRef : undefined}
      onChange={handleTextChange}
      onSubmit={handleSendTextSubmit}
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
      onClose={compact ? closeKeyboard : undefined}
      onLiveTypingChange={setLiveTyping}
      onSendKey={sendKey}
      onSendText={sendText}
      modifiers={modifiers}
      onToggleModifier={toggleModifier}
      onSendCombo={sendCombo}
    />
  );

  const renderTrackpadPanel = (overlay = false) => (
    <TrackpadPanel
      overlay={overlay}
      sensitivity={sensitivity}
      onSensitivityChange={setSensitivity}
      surfaceHandlers={trackpadHandlers}
      onScroll={sendScroll}
      onClick={sendClick}
    />
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

          <FullscreenHud
            host={activeHost}
            hosts={hosts}
            hidden={hudHidden}
            inputMode={inputMode}
            showTrackpad={showFullscreenTrackpad}
            streamQuality={streamQuality}
            zoomed={zoomed}
            keyboardOpen={showKeyboard}
            trackpadPanel={renderTrackpadPanel(true)}
            onSelectHost={onSelectHost}
            onToggleInputMode={() => setInputMode(inputMode === 'trackpad' ? 'direct' : 'trackpad')}
            onToggleTrackpad={() => setShowFullscreenTrackpad((v) => !v)}
            onClick={sendClick}
            onScroll={sendScroll}
            onQualityChange={handleQualityChange}
            onSelectMonitor={selectMonitor}
            onToggleZoom={() => setZoomed((z) => !z)}
            statsOpen={showStats}
            onToggleStats={() => setShowStats((v) => !v)}
            onToggleKeyboard={toggleKeyboardDrawer}
            onOpenAI={() => setShowMobileAI(true)}
            onHide={() => setHudHidden(true)}
            onShow={() => setHudHidden(false)}
            onExit={exitFullscreen}
          />
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="space-y-4">
      <HostChips hosts={hosts} activeHostId={activeHost.hostId} onSelectHost={onSelectHost} />

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

                <MonitorPicker
                  host={activeHost}
                  onSelect={selectMonitor}
                  className="min-h-[36px] px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200"
                />

                <select
                  value={streamQuality}
                  onChange={(e) => handleQualityChange(e.target.value as StreamQualityPreset)}
                  aria-label="Stream quality"
                  className="min-h-[36px] px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200"
                >
                  {QUALITY_OPTIONS.map(([value, preset]) => (
                    <option key={value} value={value}>
                      {preset.label}
                    </option>
                  ))}
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
                  onClick={() => setShowStats((v) => !v)}
                  aria-pressed={showStats}
                  className={`min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border ${
                    showStats
                      ? 'border-blue-600 bg-blue-600 text-white'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                  aria-label={showStats ? 'Hide stream stats' : 'Show stream stats'}
                >
                  <Activity className="w-4 h-4" />
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
                { label: 'Undo', combo: 'Ctrl+Z' },
                { label: 'Explorer', combo: 'Win+E' },
                { label: 'Close', combo: 'Alt+F4' },
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
            getScreenshot={getScreenshot}
            onDispatchInput={dispatchAiInput}
            onSwitchHost={onSelectHost}
          />
        </div>
      </div>

      {fullscreenOverlay}

      {showMobileAI && (
        <MobileAIDrawer
          host={activeHost}
          hosts={hosts}
          frame={activeFrame}
          getScreenshot={getScreenshot}
          onDispatchInput={dispatchAiInput}
          onSwitchHost={onSelectHost}
          onClose={() => setShowMobileAI(false)}
        />
      )}
    </div>
  );
}
