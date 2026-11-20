using Windows.Win32;
using Windows.Win32.UI.HiDpi;

namespace DeskBridge.Agent.Windows.Host;

public static class DpiAwareness
{
    /// <summary>
    /// Makes the process per-monitor DPI aware (v2). Must run before any monitor or screen-size query:
    /// otherwise monitors whose scaling differs from the primary report scaled bounds and capture or
    /// input coordinates come out wrong. Returns false when the call failed (already set, or old Windows).
    /// </summary>
    public static bool EnablePerMonitorV2()
    {
        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 is the pseudo-handle -4.
        return PInvoke.SetProcessDpiAwarenessContext(new DPI_AWARENESS_CONTEXT(-4));
    }
}
