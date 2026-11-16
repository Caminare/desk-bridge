/**
 * Zoom/pan state for the remote-screen viewport.
 *
 * `x`/`y` are the top-left corner of the visible region in content-normalized
 * coordinates (0 = left/top edge of the remote screen, 1 = right/bottom), so the
 * visible region is [x, x + 1/zoom] × [y, y + 1/zoom]. Keeping it normalized makes
 * it independent of the viewport's pixel size.
 */

export interface ViewState {
  zoom: number;
  x: number;
  y: number;
}

/**
 * Where the picture sits inside the viewport box, in the same normalized units. The stream is
 * letterboxed (`object-contain`), so in a tall phone viewport a 16:9 screen covers only a band.
 * Panning is limited to the picture, not the black bars.
 */
export interface ContentBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const FULL_BOUNDS: ContentBounds = { left: 0, top: 0, width: 1, height: 1 };

/**
 * Extra room to pan past the picture's top edge, as a fraction of the viewport height, so the
 * top of the remote screen (browser tabs, title bars) can be pulled out from under overlays
 * such as the minimap or the stats panel. Optional `topInset` on the bounds.
 */
export interface PanInsets {
  topInset?: number;
}

/** Picture bounds for a viewport (boxW x boxH) showing an image (imgW x imgH) with object-contain. */
export function contentBounds(boxW: number, boxH: number, imgW: number, imgH: number): ContentBounds {
  if (boxW <= 0 || boxH <= 0 || imgW <= 0 || imgH <= 0) return FULL_BOUNDS;
  const boxAspect = boxW / boxH;
  const imgAspect = imgW / imgH;
  if (imgAspect > boxAspect) {
    const height = boxAspect / imgAspect;
    return { left: 0, top: (1 - height) / 2, width: 1, height };
  }
  const width = imgAspect / boxAspect;
  return { left: (1 - width) / 2, top: 0, width, height: 1 };
}

export const ZOOM_LEVELS = [1, 1.5, 2, 3, 4] as const;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const DEFAULT_VIEW: ViewState = { zoom: 1, x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function clampAxis(offset: number, visible: number, start: number, length: number): number {
  // Picture fits entirely along this axis: keep it centered.
  if (visible >= length) return start + length / 2 - visible / 2;
  return clamp(offset, start, start + length - visible);
}

/** Keeps zoom within limits and the visible region on the picture. */
export function clampView(v: ViewState, bounds: ContentBounds & PanInsets = FULL_BOUNDS): ViewState {
  const zoom = clamp(Number.isFinite(v.zoom) ? v.zoom : 1, MIN_ZOOM, MAX_ZOOM);
  if (zoom === MIN_ZOOM) return { zoom, x: 0, y: 0 };
  const visible = 1 / zoom;
  // The inset is in viewport-height units on screen; in content units it shrinks with zoom.
  const inset = Math.max(0, bounds.topInset ?? 0) / zoom;
  return {
    zoom,
    x: clampAxis(Number.isFinite(v.x) ? v.x : 0, visible, bounds.left, bounds.width),
    y: clampAxis(Number.isFinite(v.y) ? v.y : 0, visible, bounds.top - inset, bounds.height + inset),
  };
}

/**
 * Changes zoom while keeping the content under the focal point fixed on screen.
 * `fx`/`fy` are the focal point within the viewport (0..1), e.g. the pinch midpoint.
 */
export function zoomAt(v: ViewState, zoom: number, fx = 0.5, fy = 0.5, bounds: ContentBounds & PanInsets = FULL_BOUNDS): ViewState {
  const contentX = v.x + fx / v.zoom;
  const contentY = v.y + fy / v.zoom;
  const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  return clampView({ zoom: z, x: contentX - fx / z, y: contentY - fy / z }, bounds);
}

/** Moves the view by a finger drag of (dx, dy) pixels in a viewport of the given size. */
export function panByPixels(
  v: ViewState,
  dx: number,
  dy: number,
  width: number,
  height: number,
  bounds: ContentBounds & PanInsets = FULL_BOUNDS,
): ViewState {
  if (width <= 0 || height <= 0) return v;
  return clampView({ ...v, x: v.x - dx / (width * v.zoom), y: v.y - dy / (height * v.zoom) }, bounds);
}

/** Centers the visible region on a point given in viewport-box coordinates (0..1). */
export function centerOn(v: ViewState, cx: number, cy: number, bounds: ContentBounds & PanInsets = FULL_BOUNDS): ViewState {
  const half = 0.5 / v.zoom;
  return clampView({ ...v, x: cx - half, y: cy - half }, bounds);
}

/** Next preset zoom level in the given direction (snaps from in-between pinch levels). */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_LEVELS.find((l) => l > zoom + 1e-6) ?? MAX_ZOOM;
  return [...ZOOM_LEVELS].reverse().find((l) => l < zoom - 1e-6) ?? MIN_ZOOM;
}

/**
 * CSS transform for the content box (transform-origin 0 0). Percentages in translate()
 * are relative to the element's own (unscaled) size, which equals the viewport.
 */
export function viewToCss(v: ViewState): string {
  return `translate(${-v.x * v.zoom * 100}%, ${-v.y * v.zoom * 100}%) scale(${v.zoom})`;
}

export function formatZoom(zoom: number): string {
  return `${Number.isInteger(zoom) ? zoom : zoom.toFixed(1)}×`;
}
