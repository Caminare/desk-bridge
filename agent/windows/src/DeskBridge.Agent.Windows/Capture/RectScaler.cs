using DeskBridge.Agent.Core.Streaming;

namespace DeskBridge.Agent.Windows.Capture;

/// <summary>Maps source-pixel rectangles to stream coordinates.</summary>
internal static class RectScaler
{
    /// <summary>More rectangles than this collapse into their bounding box; the diff cost outweighs the saving.</summary>
    public const int MaxRects = 128;

    /// <summary>
    /// Scales the half-open source rectangle [left,right) x [top,bottom), rounds outward, grows it by
    /// <paramref name="margin"/> stream pixels (the scaler's filter taps bleed past the edge) and clips it.
    /// Returns false when nothing is left.
    /// </summary>
    public static bool TryScale(int left, int top, int right, int bottom, int srcW, int srcH, int dstW, int dstH, int margin, out PixelRect result)
    {
        result = default;
        if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0 || right <= left || bottom <= top) return false;

        double sx = (double)dstW / srcW, sy = (double)dstH / srcH;
        int x0 = Math.Max(0, (int)Math.Floor(left * sx) - margin);
        int y0 = Math.Max(0, (int)Math.Floor(top * sy) - margin);
        int x1 = Math.Min(dstW, (int)Math.Ceiling(right * sx) + margin);
        int y1 = Math.Min(dstH, (int)Math.Ceiling(bottom * sy) + margin);
        if (x1 <= x0 || y1 <= y0) return false;

        result = new PixelRect(x0, y0, x1 - x0, y1 - y0);
        return true;
    }

    public static PixelRect Union(PixelRect a, PixelRect b)
    {
        if (a.Width <= 0 || a.Height <= 0) return b;
        if (b.Width <= 0 || b.Height <= 0) return a;
        int x0 = Math.Min(a.X, b.X), y0 = Math.Min(a.Y, b.Y);
        int x1 = Math.Max(a.X + a.Width, b.X + b.Width), y1 = Math.Max(a.Y + a.Height, b.Y + b.Height);
        return new PixelRect(x0, y0, x1 - x0, y1 - y0);
    }

    /// <summary>Collapses a long list into one bounding box so the consumer never diffs hundreds of slivers.</summary>
    public static void CapCount(List<PixelRect> rects)
    {
        if (rects.Count <= MaxRects) return;
        PixelRect all = rects[0];
        for (int i = 1; i < rects.Count; i++) all = Union(all, rects[i]);
        rects.Clear();
        rects.Add(all);
    }
}
