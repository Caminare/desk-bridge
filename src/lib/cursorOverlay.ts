import type { ContentBounds } from './viewTransform';

/** Smallest on-screen cursor height (CSS px), so it stays visible on a phone showing a large desktop. */
export const MIN_CURSOR_CSS_PX = 16;

export interface CursorBox {
  /** Hotspot position as a percentage of the (zoom-transformed) stream container. */
  leftPct: number;
  topPct: number;
  /** Image size in container px (before the zoom transform). */
  width: number;
  height: number;
  /** Translation that puts the hotspot, not the image corner, at the position (container px). */
  offsetX: number;
  offsetY: number;
}

/**
 * Where and how large to draw the cursor image. The shape is in the PC's physical pixels and
 * scales with the picture (including zoom), but is never shorter than MIN_CURSOR_CSS_PX on screen.
 */
export function cursorBox(
  pos: { x: number; y: number },
  shape: { w: number; h: number; hotX: number; hotY: number },
  monitor: { width: number; height: number },
  bounds: ContentBounds,
  viewport: { width: number; height: number },
  zoom: number,
): CursorBox {
  const pictureOnScreen = bounds.width * viewport.width * zoom;
  const pictureScale = monitor.width > 0 ? pictureOnScreen / monitor.width : 1;
  const screenScale = Math.max(pictureScale, MIN_CURSOR_CSS_PX / Math.max(1, shape.h));
  // The overlay lives inside the zoomed container, so undo the zoom for its own size.
  const scale = screenScale / Math.max(zoom, 1e-6);
  return {
    leftPct: (bounds.left + pos.x * bounds.width) * 100,
    topPct: (bounds.top + pos.y * bounds.height) * 100,
    width: shape.w * scale,
    height: shape.h * scale,
    offsetX: -shape.hotX * scale,
    offsetY: -shape.hotY * scale,
  };
}
