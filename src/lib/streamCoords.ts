export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Maps a pointer position to normalized (0..1) coordinates on the remote screen.
 * The stream is rendered with `object-contain`, so when the image's aspect ratio
 * differs from its box the picture is letterboxed; the bars must be excluded.
 */
export function mapToStreamCoords(
  clientX: number,
  clientY: number,
  rect: RectLike,
  natural?: { width: number; height: number },
): { nx: number; ny: number } {
  let { left, top, width, height } = rect;

  if (natural && natural.width > 0 && natural.height > 0 && rect.width > 0 && rect.height > 0) {
    const imgRatio = natural.width / natural.height;
    const boxRatio = rect.width / rect.height;
    if (imgRatio > boxRatio) {
      height = rect.width / imgRatio;
      top = rect.top + (rect.height - height) / 2;
    } else {
      width = rect.height * imgRatio;
      left = rect.left + (rect.width - width) / 2;
    }
  }

  const nx = width > 0 ? Math.max(0, Math.min(1, (clientX - left) / width)) : 0;
  const ny = height > 0 ? Math.max(0, Math.min(1, (clientY - top) / height)) : 0;
  return { nx, ny };
}
