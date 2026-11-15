import React from 'react';
import { Monitor } from 'lucide-react';
import type { HostProfile } from '../../types/deskbridge';
import type { PointerHandlers } from './TrackpadPanel';

interface StreamViewportProps {
  host: HostProfile;
  frame: string | null;
  fullscreen: boolean;
  zoomed: boolean;
  /** Show a crosshair cursor (direct-tap mode) instead of trackpad gestures. */
  crosshair: boolean;
  pointerHandlers: PointerHandlers;
  onWheel: (e: React.WheelEvent<HTMLDivElement>) => void;
  imgRef: React.Ref<HTMLImageElement>;
  tapFeedback: { x: number; y: number; id: number } | null;
}

export function StreamViewport({
  host,
  frame,
  fullscreen,
  zoomed,
  crosshair,
  pointerHandlers,
  onWheel,
  imgRef,
  tapFeedback,
}: StreamViewportProps) {
  return (
    <div
      onWheel={onWheel}
      className={`relative bg-black select-none ${zoomed ? 'overflow-auto' : 'overflow-hidden'} ${
        fullscreen ? 'w-full h-full flex items-center justify-center' : 'bg-slate-950'
      } ${!zoomed ? 'touch-none' : ''} ${crosshair ? 'cursor-crosshair' : ''}`}
    >
      <div
        {...pointerHandlers}
        onContextMenu={(e) => e.preventDefault()}
        className={`relative flex items-center justify-center transition-transform duration-200 ${
          fullscreen ? 'w-full h-full' : 'aspect-video w-full'
        } ${zoomed ? 'scale-150 origin-center' : 'scale-100'}`}
      >
        {frame ? (
          <img
            ref={imgRef}
            src={frame}
            alt={`Live desktop stream of ${host.name}`}
            referrerPolicy="no-referrer"
            draggable={false}
            className="w-full h-full max-w-full max-h-full object-contain pointer-events-none select-none"
          />
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-slate-400">
            <Monitor className="w-10 h-10 text-slate-600" />
            <p className="text-sm font-medium text-slate-300">
              {host.status === 'online' ? 'Waiting for next video frame from Windows host...' : `${host.name} is offline`}
            </p>
            <p className="text-xs text-slate-500 max-w-sm">
              {host.status === 'online'
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
}
