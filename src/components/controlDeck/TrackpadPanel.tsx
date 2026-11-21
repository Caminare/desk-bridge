import React from 'react';
import { ChevronDown, ChevronUp, Touchpad } from 'lucide-react';

export interface PointerHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
  /** Capture lost without a pointerup/cancel: treat it as a cancel so no finger stays "down". */
  onLostPointerCapture?: (e: React.PointerEvent<HTMLDivElement>) => void;
}

interface TrackpadPanelProps {
  /** Dark translucent variant shown over the fullscreen stream. */
  overlay?: boolean;
  sensitivity: number;
  onSensitivityChange: (value: number) => void;
  surfaceHandlers: PointerHandlers;
  onScroll: (deltaY: number) => void;
  onClick: (button: 'left' | 'right') => void;
}

export function TrackpadPanel({
  overlay = false,
  sensitivity,
  onSensitivityChange,
  surfaceHandlers,
  onScroll,
  onClick,
}: TrackpadPanelProps) {
  const scrollButtonClass = `flex-1 min-h-[40px] rounded-xl border flex items-center justify-center active:scale-[0.98] ${
    overlay
      ? 'bg-slate-900 border-slate-800 text-slate-200'
      : 'bg-slate-100 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
  }`;
  const clickButtonClass = `min-h-[44px] rounded-xl text-sm font-medium active:scale-[0.98] transition-transform ${
    overlay
      ? 'bg-slate-800 hover:bg-slate-700 text-white'
      : 'bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-900 dark:text-white'
  }`;

  return (
    <div
      className={
        overlay
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
            onChange={(e) => onSensitivityChange(Number(e.target.value))}
            className="w-20 accent-blue-600"
          />
        </label>
      </div>

      <div className="grid grid-cols-12 gap-2">
        <div
          {...surfaceHandlers}
          // A held finger is a drag (long press): the browser's own long-press menu or callout
          // would cancel the pointer and release the remote button straight away.
          onContextMenu={(e) => e.preventDefault()}
          style={{ WebkitTouchCallout: 'none' }}
          className={`col-span-10 ${
            overlay
              ? 'h-32 sm:h-36 bg-slate-900 border-slate-800'
              : 'h-44 sm:h-48 bg-slate-100 dark:bg-slate-950 border-slate-200 dark:border-slate-800'
          } rounded-xl border touch-none select-none flex flex-col items-center justify-center gap-1 text-slate-400 dark:text-slate-500 active:border-blue-500 transition-colors`}
        >
          <Touchpad className="w-5 h-5" />
          <span className="text-xs font-medium">Touchpad Surface</span>
        </div>

        <div className="col-span-2 flex flex-col gap-2">
          <button type="button" onClick={() => onScroll(-5)} className={scrollButtonClass} aria-label="Scroll up">
            <ChevronUp className="w-5 h-5" />
          </button>
          <button type="button" onClick={() => onScroll(5)} className={scrollButtonClass} aria-label="Scroll down">
            <ChevronDown className="w-5 h-5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => onClick('left')} className={clickButtonClass}>
          Left Click
        </button>
        <button type="button" onClick={() => onClick('right')} className={clickButtonClass}>
          Right Click
        </button>
      </div>
    </div>
  );
}
