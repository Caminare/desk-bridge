export type PointerPoints = Map<number, { x: number; y: number }>;

export interface PointerDownInfo {
  pointerId: number;
  x: number;
  y: number;
  pointerType: string;
  isPrimary: boolean;
}

/**
 * Records a pointer going down in a gesture's pointer map. Returns true when stale entries were
 * dropped, in which case the caller must also reset any gesture state (pinch, pan, tap).
 *
 * A pointer whose `pointerup` / `pointercancel` never reached the element (lost capture, the
 * element re-rendering mid-touch, the OS taking over the gesture) would otherwise stay in the map
 * forever: every later one-finger touch then counts as a second finger, so taps never register
 * and dragging pinch-zooms. Pointer Events mark the first contact of a new touch interaction as
 * `isPrimary`, which means no other finger is really down, so anything still in the map is stale.
 */
export function registerPointerDown(points: PointerPoints, info: PointerDownInfo): boolean {
  let dropped = false;
  if (info.pointerType === 'touch' && info.isPrimary && points.size > 0) {
    points.clear();
    dropped = true;
  }
  points.set(info.pointerId, { x: info.x, y: info.y });
  return dropped;
}
