import React, { useEffect, useRef } from 'react';
import type { CursorShape, HostProfile } from '../../types/deskbridge';
import { activeMonitorSize, type RemoteCursorStore } from '../../lib/remoteCursor';
import { cursorBox } from '../../lib/cursorOverlay';
import type { ContentBounds } from '../../lib/viewTransform';

interface RemoteCursorOverlayProps {
  store: RemoteCursorStore;
  host: HostProfile;
  bounds: ContentBounds;
  zoom: number;
  viewportRef: React.MutableRefObject<HTMLDivElement | null>;
}

// Decoded once per shape id (a hash of the pixels, so equal ids mean equal images, across hosts too).
const shapeUrls = new Map<string, string>();

function shapeUrl(shape: CursorShape): string {
  const cached = shapeUrls.get(shape.id);
  if (cached) return cached;
  const bytes = Uint8ClampedArray.from(atob(shape.rgba), (c) => c.charCodeAt(0));
  const canvas = document.createElement('canvas');
  canvas.width = shape.w;
  canvas.height = shape.h;
  canvas.getContext('2d')?.putImageData(new ImageData(bytes, shape.w, shape.h), 0, 0);
  const url = canvas.toDataURL();
  shapeUrls.set(shape.id, url);
  if (shapeUrls.size > 64) shapeUrls.delete(shapeUrls.keys().next().value!);
  return url;
}

/**
 * Draws the host's cursor over the stream. Lives inside the zoom-transformed container (like the
 * tap feedback) and repaints per animation frame from the store, without React state.
 */
export function RemoteCursorOverlay({ store, host, bounds, zoom, viewportRef }: RemoteCursorOverlayProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const layoutRef = useRef({ bounds, zoom, monitor: activeMonitorSize(host) });
  layoutRef.current = { bounds, zoom, monitor: activeMonitorSize(host) };
  const repaintRef = useRef<() => void>(() => {});

  useEffect(() => {
    const cursor = store.get(host.hostId);
    let raf = 0;
    let handOver = 0;
    const paint = () => {
      raf = 0;
      const img = imgRef.current;
      const vp = viewportRef.current;
      if (!img || !vp) return;
      const now = performance.now();
      const view = cursor.state(now);
      if (!view) {
        img.style.display = 'none';
      } else {
        const { bounds: b, zoom: z, monitor } = layoutRef.current;
        const box = cursorBox(view, view.shape, monitor, b, { width: vp.clientWidth, height: vp.clientHeight }, z);
        const url = shapeUrl(view.shape);
        if (img.getAttribute('src') !== url) img.src = url;
        img.style.display = 'block';
        img.style.left = `${box.leftPct}%`;
        img.style.top = `${box.topPct}%`;
        img.style.width = `${box.width}px`;
        img.style.height = `${box.height}px`;
        img.style.transform = `translate(${box.offsetX}px, ${box.offsetY}px)`;
      }
      // Repaint when the prediction hands over to the agent's position.
      const end = cursor.predictionEndsAt();
      window.clearTimeout(handOver);
      if (end !== null && end > now) handOver = window.setTimeout(schedule, end - now + 1);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };
    repaintRef.current = schedule;
    schedule();
    const unsubscribe = cursor.subscribe(schedule);
    return () => {
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(handOver);
    };
  }, [store, host.hostId, viewportRef]);

  // Layout changes (zoom, letterbox, monitor switch) move the cursor too.
  useEffect(() => repaintRef.current(), [bounds, zoom, host.monitors, host.activeMonitor, host.screenWidth, host.screenHeight]);

  return (
    <img
      ref={imgRef}
      alt=""
      aria-hidden="true"
      draggable={false}
      className="pointer-events-none select-none absolute left-0 top-0"
      style={{ display: 'none', imageRendering: 'auto' }}
    />
  );
}
