import React from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { MAX_ZOOM, MIN_ZOOM, formatZoom } from '../../lib/viewTransform';

interface ZoomControlsProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Tapping the level label returns to 1×. */
  onReset: () => void;
  variant: 'toolbar' | 'hud';
}

/** − / level / + group. */
export function ZoomControls({ zoom, onZoomIn, onZoomOut, onReset, variant }: ZoomControlsProps) {
  const hud = variant === 'hud';
  const group = hud
    ? 'flex items-center rounded-xl bg-slate-800/90 shrink-0'
    : 'flex items-center rounded-lg border border-slate-200 dark:border-slate-700 shrink-0';
  const btn = `min-h-[36px] min-w-[34px] flex items-center justify-center disabled:opacity-35 ${
    hud ? 'text-slate-200' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
  }`;
  const label = `min-h-[36px] min-w-[38px] px-1 text-xs font-semibold tabular-nums ${
    zoom > 1 ? 'text-blue-500 dark:text-blue-400' : hud ? 'text-slate-300' : 'text-slate-600 dark:text-slate-300'
  }`;
  return (
    <div className={group} role="group" aria-label="Zoom">
      <button type="button" onClick={onZoomOut} disabled={zoom <= MIN_ZOOM} className={`${btn} rounded-l-[inherit]`} aria-label="Zoom out">
        <ZoomOut className="w-4 h-4" />
      </button>
      <button type="button" onClick={onReset} disabled={zoom <= MIN_ZOOM} className={label} aria-label={`Zoom ${formatZoom(zoom)}, tap to reset`}>
        {formatZoom(zoom)}
      </button>
      <button type="button" onClick={onZoomIn} disabled={zoom >= MAX_ZOOM} className={`${btn} rounded-r-[inherit]`} aria-label="Zoom in">
        <ZoomIn className="w-4 h-4" />
      </button>
    </div>
  );
}
