namespace DeskBridge.Agent.Windows.Input;

/// <summary>Monitor or virtual-desktop rectangle in physical pixels.</summary>
public readonly record struct ScreenRect(int X, int Y, int Width, int Height);

/// <summary>One SendInput keyboard step: a virtual key when <see cref="VirtualKey"/> is non-zero, else a Unicode UTF-16 unit.</summary>
public readonly record struct TextStep(ushort VirtualKey, char Unit);

/// <summary>Pure coordinate and input math. Kept free of P/Invoke so it can be unit tested.</summary>
public static class InputMath
{
    /// <summary>Vertical wheel notch size (WHEEL_DELTA).</summary>
    public const int WheelDelta = 120;

    /// <summary>
    /// Maps a normalized (0..1) position on <paramref name="monitor"/> to a physical pixel. Values
    /// outside 0..1 are clamped to the monitor edges, as the PowerShell agent does.
    /// </summary>
    public static (int X, int Y) NormalizedToPixel(double x, double y, ScreenRect monitor)
    {
        return (
            monitor.X + ClampedOffset(x, monitor.Width),
            monitor.Y + ClampedOffset(y, monitor.Height));
    }

    /// <summary>
    /// Maps a physical pixel to the 0..65535 space used by MOUSEEVENTF_ABSOLUTE with
    /// MOUSEEVENTF_VIRTUALDESK. The virtual screen origin may be negative (monitors left of or
    /// above the primary).
    /// </summary>
    public static (int Dx, int Dy) PixelToAbsolute(int x, int y, ScreenRect virtualScreen)
    {
        return (
            ScaleToAbsolute(x - virtualScreen.X, virtualScreen.Width),
            ScaleToAbsolute(y - virtualScreen.Y, virtualScreen.Height));
    }

    /// <summary>
    /// Cursor position after a relative move, clamped to the monitor. Like the PowerShell agent, the
    /// clamp keeps the cursor on the active monitor.
    /// </summary>
    public static (int X, int Y) RelativeTarget(int cursorX, int cursorY, int dx, int dy, ScreenRect monitor)
    {
        return (
            Math.Clamp(CheckedSum(cursorX, dx), monitor.X, monitor.X + monitor.Width - 1),
            Math.Clamp(CheckedSum(cursorY, dy), monitor.Y, monitor.Y + monitor.Height - 1));
    }

    /// <summary>
    /// Wheel data for one scroll axis. Vertical is negated: the browser's positive deltaY scrolls
    /// down, while a positive wheel value scrolls up.
    /// </summary>
    public static int WheelData(double notches, bool horizontal)
    {
        double units = Math.Round(notches * WheelDelta);
        if (!horizontal)
        {
            units = -units;
        }
        return (int)Math.Clamp(units, int.MinValue, int.MaxValue);
    }

    /// <summary>
    /// Splits text into keyboard steps. LF becomes Enter and TAB becomes Tab, CR is dropped, and
    /// every other UTF-16 code unit becomes a Unicode step. Emoji outside the BMP therefore go out
    /// as their two surrogate halves.
    /// </summary>
    public static IEnumerable<TextStep> PlanText(string text)
    {
        foreach (char c in text)
        {
            switch (c)
            {
                case '\r':
                    break;
                case '\n':
                    yield return new TextStep(0x0D, '\0');
                    break;
                case '\t':
                    yield return new TextStep(0x09, '\0');
                    break;
                default:
                    yield return new TextStep(0, c);
                    break;
            }
        }
    }

    /// <summary>Keys that need KEYEVENTF_EXTENDEDKEY, copied from the PowerShell agent.</summary>
    public static bool IsExtendedKey(ushort vk)
    {
        return (vk >= 0x21 && vk <= 0x28)
            || vk == 0x2C
            || vk == 0x2D
            || vk == 0x2E
            || vk == 0x5B
            || vk == 0x5C
            || vk == 0x5D
            || vk == 0x6F
            || vk == 0x90;
    }

    private static int ClampedOffset(double fraction, int size)
    {
        double clamped = Math.Clamp(fraction, 0, 1);
        int offset = (int)Math.Round(clamped * size, MidpointRounding.ToEven);
        return Math.Clamp(offset, 0, Math.Max(size - 1, 0));
    }

    private static int ScaleToAbsolute(int offset, int size)
    {
        long scaled = (long)offset * 65535 / Math.Max(size - 1, 1);
        return (int)Math.Clamp(scaled, 0, 65535);
    }

    private static int CheckedSum(int a, int b) => (int)Math.Clamp((long)a + b, int.MinValue, int.MaxValue);
}
