using DeskBridge.Agent.Core.Streaming;

namespace DeskBridge.Agent.Windows.Capture;

/// <summary>
/// Composites a Desktop Duplication pointer shape onto a top-down 32-bit BGRA buffer, scaled by the
/// stream/source ratio. Shape layouts follow DXGI_OUTDUPL_POINTER_SHAPE_TYPE.
/// </summary>
internal static class CursorBlender
{
    public const uint Monochrome = 1;
    public const uint Color = 2;
    public const uint MaskedColor = 4;

    /// <summary>The stream-space rectangle a shape at source position (<paramref name="srcX"/>, <paramref name="srcY"/>) covers, clipped to the image.</summary>
    public static PixelRect Bounds(int shapeW, int shapeRawH, uint shapeType, int srcX, int srcY, double scaleX, double scaleY, int dstW, int dstH)
    {
        int shapeH = shapeType == Monochrome ? shapeRawH / 2 : shapeRawH; // mono: AND mask on top, XOR mask below
        if (shapeW <= 0 || shapeH <= 0) return default;

        int x0 = (int)Math.Floor(srcX * scaleX), y0 = (int)Math.Floor(srcY * scaleY);
        int w = Math.Max(1, (int)Math.Ceiling(shapeW * scaleX)), h = Math.Max(1, (int)Math.Ceiling(shapeH * scaleY));
        int cx0 = Math.Max(0, x0), cy0 = Math.Max(0, y0);
        int cx1 = Math.Min(dstW, x0 + w), cy1 = Math.Min(dstH, y0 + h);
        return cx1 > cx0 && cy1 > cy0 ? new PixelRect(cx0, cy0, cx1 - cx0, cy1 - cy0) : default;
    }

    /// <summary>Draws the shape and returns the stream-space rectangle it touched (empty when fully off-screen).</summary>
    public static PixelRect Draw(
        Span<byte> dst, int dstW, int dstH, int dstStride,
        uint shapeType, ReadOnlySpan<byte> shape, int shapeW, int shapeRawH, int shapePitch,
        int srcX, int srcY, double scaleX, double scaleY)
    {
        int shapeH = shapeType == Monochrome ? shapeRawH / 2 : shapeRawH;
        PixelRect clipped = Bounds(shapeW, shapeRawH, shapeType, srcX, srcY, scaleX, scaleY, dstW, dstH);
        if (clipped.Width == 0) return clipped;

        int originX = (int)Math.Floor(srcX * scaleX), originY = (int)Math.Floor(srcY * scaleY);
        for (int y = clipped.Y; y < clipped.Y + clipped.Height; y++)
        {
            double v0 = (y - originY) / scaleY, v1 = (y - originY + 1) / scaleY;
            int row = y * dstStride;
            for (int x = clipped.X; x < clipped.X + clipped.Width; x++)
            {
                double u0 = (x - originX) / scaleX, u1 = (x - originX + 1) / scaleX;
                int d = row + x * 4;
                switch (shapeType)
                {
                    case Color:
                        BlendColor(dst, d, shape, shapeW, shapeH, shapePitch, u0, u1, v0, v1);
                        break;
                    case MaskedColor:
                        BlendMasked(dst, d, shape, shapeW, shapeH, shapePitch, u0, u1, v0, v1);
                        break;
                    case Monochrome:
                        BlendMono(dst, d, shape, shapeW, shapeH, shapePitch, u0, u1, v0, v1);
                        break;
                }
            }
        }
        return clipped;
    }

    // Box-filter the source block that maps onto this destination pixel, so a downscaled arrow keeps soft edges.
    private static void BlendColor(Span<byte> dst, int d, ReadOnlySpan<byte> shape, int w, int h, int pitch, double u0, double u1, double v0, double v1)
    {
        int sx0 = Math.Clamp((int)Math.Floor(u0), 0, w - 1), sx1 = Math.Clamp((int)Math.Ceiling(u1), sx0 + 1, w);
        int sy0 = Math.Clamp((int)Math.Floor(v0), 0, h - 1), sy1 = Math.Clamp((int)Math.Ceiling(v1), sy0 + 1, h);
        long sumA = 0, sumB = 0, sumG = 0, sumR = 0;
        int n = 0;
        for (int sy = sy0; sy < sy1; sy++)
        {
            int p = sy * pitch + sx0 * 4;
            for (int sx = sx0; sx < sx1; sx++, p += 4)
            {
                int a = shape[p + 3];
                sumB += shape[p] * a; sumG += shape[p + 1] * a; sumR += shape[p + 2] * a; sumA += a;
                n++;
            }
        }
        if (sumA == 0) return;
        int alpha = (int)(sumA / n);
        dst[d] = Mix((int)(sumB / sumA), dst[d], alpha);
        dst[d + 1] = Mix((int)(sumG / sumA), dst[d + 1], alpha);
        dst[d + 2] = Mix((int)(sumR / sumA), dst[d + 2], alpha);
    }

    // Alpha 0 replaces the screen pixel, alpha 0xFF XORs the colour into it (the text I-beam).
    private static void BlendMasked(Span<byte> dst, int d, ReadOnlySpan<byte> shape, int w, int h, int pitch, double u0, double u1, double v0, double v1)
    {
        int sx = Math.Clamp((int)((u0 + u1) * 0.5), 0, w - 1), sy = Math.Clamp((int)((v0 + v1) * 0.5), 0, h - 1);
        int p = sy * pitch + sx * 4;
        if (shape[p + 3] == 0)
        {
            dst[d] = shape[p]; dst[d + 1] = shape[p + 1]; dst[d + 2] = shape[p + 2];
        }
        else
        {
            dst[d] ^= shape[p]; dst[d + 1] ^= shape[p + 1]; dst[d + 2] ^= shape[p + 2];
        }
    }

    // 1 bpp, MSB first: result = (screen AND andMask) XOR xorMask. The XOR mask is the lower half of the bitmap.
    private static void BlendMono(Span<byte> dst, int d, ReadOnlySpan<byte> shape, int w, int h, int pitch, double u0, double u1, double v0, double v1)
    {
        int sx = Math.Clamp((int)((u0 + u1) * 0.5), 0, w - 1), sy = Math.Clamp((int)((v0 + v1) * 0.5), 0, h - 1);
        int bit = 0x80 >> (sx & 7);
        bool and = (shape[sy * pitch + (sx >> 3)] & bit) != 0;
        bool xor = (shape[(sy + h) * pitch + (sx >> 3)] & bit) != 0;
        for (int c = 0; c < 3; c++)
        {
            byte v = and ? dst[d + c] : (byte)0;
            dst[d + c] = xor ? (byte)~v : v;
        }
    }

    private static byte Mix(int src, int dst, int alpha) => (byte)((src * alpha + dst * (255 - alpha) + 127) / 255);
}
