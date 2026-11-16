import React, { useRef } from 'react';
import type { FrameStore } from '../../lib/frameCompositor';
import { formatZoom, type ContentBounds, type ViewState } from '../../lib/viewTransform';
import { LiveStreamCanvas } from '../LiveStreamCanvas';

interface ZoomMinimapProps {
  store: FrameStore;
  hostId: string;
  view: ViewState;
  /** Picture bounds inside the viewport; the view rectangle is drawn relative to the picture. */
  bounds: ContentBounds;
  /** Picture width / height. */
  aspect: number;
  /** Center the view on a point of the picture (0..1). */
  onCenter: (mx: number, my: number) => void;
}

/** Overview of the whole screen with the visible region; drag it to move around while zoomed. */
export function ZoomMinimap({ store, hostId, view, bounds, aspect, onCenter }: ZoomMinimapProps) {
  const visible = 1 / view.zoom;
  const left = (view.x - bounds.left) / bounds.width;
  const top = (view.y - bounds.top) / bounds.height;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const centerFrom = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    onCenter((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  };

  return (
    <div
      ref={boxRef}
      className="absolute top-2 right-2 z-20 w-32 sm:w-40 rounded-md overflow-hidden border border-white/40 bg-black/80 shadow-lg touch-none select-none cursor-grab"
      style={{ aspectRatio: String(aspect || 16 / 9) }}
      onPointerDown={(e) => {
        e.stopPropagation();
        dragging.current = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // synthetic pointers cannot be captured
        }
        centerFrom(e);
      }}
      onPointerMove={(e) => {
        e.stopPropagation();
        if (dragging.current) centerFrom(e);
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      aria-label="Zoom overview: drag to move around the screen"
      role="slider"
      aria-valuetext={`Showing ${Math.round(Math.max(0, left) * 100)}% from left, ${Math.round(Math.max(0, top) * 100)}% from top`}
    >
      <LiveStreamCanvas
        store={store}
        hostId={hostId}
        ariaLabel="Screen overview"
        className="w-full h-full object-fill pointer-events-none"
      />
      <div
        className="absolute border-2 border-blue-400 bg-blue-400/15 pointer-events-none rounded-[2px]"
        style={{
          left: `${Math.max(0, left) * 100}%`,
          top: `${Math.max(0, top) * 100}%`,
          width: `${Math.min(1, visible / bounds.width) * 100}%`,
          height: `${Math.min(1, visible / bounds.height) * 100}%`,
        }}
      />
      <span className="absolute bottom-0.5 right-1 text-[10px] font-semibold text-white/90 pointer-events-none">
        {formatZoom(view.zoom)}
      </span>
    </div>
  );
}
