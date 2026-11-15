import React, { useEffect, useRef, useState } from 'react';
import type { FrameStore } from '../lib/frameCompositor';

interface LiveStreamCanvasProps {
  store: FrameStore;
  hostId: string;
  className?: string;
  ariaLabel: string;
  canvasRef?: React.MutableRefObject<HTMLCanvasElement | null>;
  /** Rendered while no frame has arrived yet. */
  fallback?: React.ReactNode;
}

/**
 * Shows a host's composited stream. Redraws at most once per animation frame when
 * the compositor changes, without going through React state.
 */
export function LiveStreamCanvas({ store, hostId, className, ariaLabel, canvasRef, fallback }: LiveStreamCanvasProps) {
  const localRef = useRef<HTMLCanvasElement | null>(null);
  const [hasImage, setHasImage] = useState(() => store.get(hostId).hasImage);

  useEffect(() => {
    const compositor = store.get(hostId);
    let raf = 0;
    const paint = () => {
      raf = 0;
      const canvas = localRef.current;
      const src = compositor.canvas;
      if (!canvas || !compositor.hasImage) return;
      if (canvas.width !== src.width || canvas.height !== src.height) {
        canvas.width = src.width;
        canvas.height = src.height;
      }
      canvas.getContext('2d')?.drawImage(src, 0, 0);
    };
    const schedule = () => {
      setHasImage((had) => had || compositor.hasImage);
      if (!raf) raf = requestAnimationFrame(paint);
    };
    setHasImage(compositor.hasImage);
    schedule();
    const unsubscribe = compositor.subscribe(schedule);
    return () => {
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [store, hostId]);

  return (
    <>
      <canvas
        ref={(el) => {
          localRef.current = el;
          if (canvasRef) canvasRef.current = el;
        }}
        role="img"
        aria-label={ariaLabel}
        className={`${className ?? ''} ${hasImage ? '' : 'hidden'}`}
      />
      {!hasImage && fallback}
    </>
  );
}
