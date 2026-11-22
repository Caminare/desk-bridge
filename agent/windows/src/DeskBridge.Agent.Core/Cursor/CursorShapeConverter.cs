namespace DeskBridge.Agent.Core.Cursor;

/// <summary>
/// Turns Windows pointer shapes into plain RGBA a browser can draw. Pixels that invert the screen
/// (the text I-beam, XOR cursors) cannot be reproduced by an overlay, so they become black with a
/// 1 px white outline, which stays visible on light and dark backgrounds.
/// </summary>
public static class CursorShapeConverter
{
    /// <summary>Largest width/height the relay accepts; bigger shapes are downscaled.</summary>
    public const int MaxSize = 128;

    public static CursorShapeData Convert(CursorShapeType type, ReadOnlySpan<byte> data, int width, int rawHeight, int pitch, int hotX, int hotY) =>
        TryConvert(type, data, width, rawHeight, pitch, hotX, hotY) ?? throw new ArgumentException("Invalid cursor shape.");

    /// <returns>The converted shape, or null when the dimensions or buffer are invalid.</returns>
    public static CursorShapeData? TryConvert(CursorShapeType type, ReadOnlySpan<byte> data, int width, int rawHeight, int pitch, int hotX, int hotY)
    {
        bool mono = type == CursorShapeType.Monochrome;
        if (width <= 0 || rawHeight <= 0 || (mono && rawHeight % 2 != 0)) return null;
        int height = mono ? rawHeight / 2 : rawHeight;
        int rowBytes = mono ? (width + 7) / 8 : width * 4;
        if (pitch < rowBytes || (long)pitch * (rawHeight - 1) + rowBytes > data.Length) return null;

        var rgba = new byte[width * height * 4];
        var invert = new bool[width * height];
        for (int y = 0; y < height; y++)
        {
            for (int x = 0; x < width; x++)
            {
                int o = (y * width + x) * 4;
                switch (type)
                {
                    case CursorShapeType.Color:
                    {
                        int p = y * pitch + x * 4;
                        Set(rgba, o, data[p + 2], data[p + 1], data[p], data[p + 3]);
                        break;
                    }
                    case CursorShapeType.MaskedColor:
                    {
                        int p = y * pitch + x * 4;
                        if (data[p + 3] == 0) Set(rgba, o, data[p + 2], data[p + 1], data[p], 255);
                        else if ((data[p] | data[p + 1] | data[p + 2]) != 0) invert[y * width + x] = true;
                        break;
                    }
                    case CursorShapeType.Monochrome:
                    {
                        int bit = 0x80 >> (x & 7);
                        bool and = (data[y * pitch + (x >> 3)] & bit) != 0;
                        bool xor = (data[(y + height) * pitch + (x >> 3)] & bit) != 0;
                        if (!and) Set(rgba, o, xor ? (byte)255 : (byte)0, xor ? (byte)255 : (byte)0, xor ? (byte)255 : (byte)0, 255);
                        else if (xor) invert[y * width + x] = true;
                        break;
                    }
                    default:
                        return null;
                }
            }
        }
        Outline(rgba, invert, width, height);

        hotX = Math.Clamp(hotX, 0, width - 1);
        hotY = Math.Clamp(hotY, 0, height - 1);
        if (width > MaxSize || height > MaxSize) (rgba, width, height, hotX, hotY) = Downscale(rgba, width, height, hotX, hotY);
        return new CursorShapeData(HashId(rgba, width, height, hotX, hotY), width, height, hotX, hotY, rgba);
    }

    private static void Set(byte[] rgba, int o, byte r, byte g, byte b, byte a)
    {
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = a;
    }

    private static void Outline(byte[] rgba, bool[] invert, int width, int height)
    {
        for (int y = 0; y < height; y++)
        {
            for (int x = 0; x < width; x++)
            {
                if (!invert[y * width + x]) continue;
                Set(rgba, (y * width + x) * 4, 0, 0, 0, 255);
                for (int ny = Math.Max(0, y - 1); ny <= Math.Min(height - 1, y + 1); ny++)
                {
                    for (int nx = Math.Max(0, x - 1); nx <= Math.Min(width - 1, x + 1); nx++)
                    {
                        int n = ny * width + nx;
                        if (!invert[n] && rgba[n * 4 + 3] == 0) Set(rgba, n * 4, 255, 255, 255, 255);
                    }
                }
            }
        }
    }

    // Nearest-neighbour by an integer factor: only very large accessibility cursors get here.
    private static (byte[], int, int, int, int) Downscale(byte[] rgba, int width, int height, int hotX, int hotY)
    {
        int f = (int)Math.Ceiling(Math.Max(width, height) / (double)MaxSize);
        int w = Math.Max(1, width / f), h = Math.Max(1, height / f);
        var dst = new byte[w * h * 4];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
                Array.Copy(rgba, (y * f * width + x * f) * 4, dst, (y * w + x) * 4, 4);
        return (dst, w, h, Math.Min(hotX / f, w - 1), Math.Min(hotY / f, h - 1));
    }

    // FNV-1a 64: identifies a shape so the controller can reuse its decoded image.
    private static string HashId(byte[] rgba, int width, int height, int hotX, int hotY)
    {
        ulong hash = 14695981039346656037UL;
        void Mix(int v)
        {
            for (int i = 0; i < 4; i++)
            {
                hash ^= (byte)(v >> (i * 8));
                hash *= 1099511628211UL;
            }
        }
        Mix(width);
        Mix(height);
        Mix(hotX);
        Mix(hotY);
        foreach (byte b in rgba)
        {
            hash ^= b;
            hash *= 1099511628211UL;
        }
        return hash.ToString("x16");
    }
}
