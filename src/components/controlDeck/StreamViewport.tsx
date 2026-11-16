import React, { useEffect, useState } from 'react';
import { Monitor } from 'lucide-react';
import type { HostProfile } from '../../types/deskbridge';
import type { FrameStore } from '../../lib/frameCompositor';
import { viewToCss, type ContentBounds, type ViewState } from '../../lib/viewTransform';
import { LiveStreamCanvas } from '../LiveStreamCanvas';
import { StreamStatsOverlay } from './StreamStatsOverlay';
import { ZoomMinimap } from './ZoomMinimap';
import type { PointerHandlers } from './TrackpadPanel';

interface StreamViewportProps {
  host: HostProfile;
  frameStore: FrameStore;
  fullscreen: boolean;
  view: ViewState;
  /** Where the letterboxed picture sits inside the viewport (normalized). */
  bounds: ContentBounds;
  /** Animate view changes (button zoom); off while a finger is panning/pinching. */
  animateView: boolean;
  /** Show a crosshair cursor (direct-tap mode) instead of trackpad gestures. */
  crosshair: boolean;
  showStats: boolean;
  pointerHandlers: PointerHandlers;
  /** Native, non-passive wheel listener so Ctrl+wheel can zoom without zooming the page. */
  onWheel: (e: WheelEvent) => void;
  onMinimapCenter: (cx: number, cy: number) => void;
  viewportRef: React.MutableRefObject<HTMLDivElement | null>;
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  tapFeedback: { x: number; y: number; id: number } | null;
}

export function StreamViewport({
  host,
  frameStore,
  fullscreen,
  view,
  bounds,
  animateView,
  crosshair,
  showStats,
  pointerHandlers,
  onWheel,
  onMinimapCenter,
  viewportRef,
  canvasRef,
  tapFeedback,
}: StreamViewportProps) {
  const [aspect, setAspect] = useState(16 / 9);

  // Track the viewport's aspect ratio (fullscreen follows the window) for the minimap.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) setAspect(el.clientWidth / el.clientHeight);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewportRef, fullscreen]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewportRef, onWheel]);

  const zoomed = view.zoom > 1;

  return (
    <div
      ref={viewportRef}
      className={`relative bg-black select-none overflow-hidden touch-none ${
        fullscreen ? 'w-full h-full' : 'aspect-video w-full bg-slate-950'
      } ${crosshair ? 'cursor-crosshair' : ''}`}
    >
      {showStats && <StreamStatsOverlay store={frameStore} hostId={host.hostId} />}
      {zoomed && (
        <ZoomMinimap
          store={frameStore}
          hostId={host.hostId}
          view={view}
          bounds={bounds}
          aspect={(aspect * bounds.width) / bounds.height}
          onCenter={onMinimapCenter}
        />
      )}
      <div
        {...pointerHandlers}
        onContextMenu={(e) => e.preventDefault()}
        className={`relative flex items-center justify-center w-full h-full ${
          animateView ? 'transition-transform duration-150 ease-out' : ''
        }`}
        style={{ transform: viewToCss(view), transformOrigin: '0 0' }}
      >
        <LiveStreamCanvas
          store={frameStore}
          hostId={host.hostId}
          canvasRef={canvasRef}
          ariaLabel={`Live desktop stream of ${host.name}`}
          className="w-full h-full max-w-full max-h-full object-contain pointer-events-none select-none"
          fallback={
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
          }
        />

        {tapFeedback && (
          <div
            key={tapFeedback.id}
            style={{ left: `${tapFeedback.x}%`, top: `${tapFeedback.y}%`, transform: `translate(-50%, -50%) scale(${1 / view.zoom})` }}
            className="pointer-events-none absolute w-8 h-8 rounded-full border-2 border-blue-400 bg-blue-500/20"
          />
        )}
      </div>
    </div>
  );
}
