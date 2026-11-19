using DeskBridge.Agent.Windows.Capture;
using Windows.Win32;
using Windows.Win32.UI.HiDpi;
using Xunit;

namespace DeskBridge.Agent.Windows.Tests.Capture;

/// <summary>
/// A test that touches the real desktop. Skipped when <c>DESKBRIDGE_SKIP_DESKTOP_TESTS=1</c>, or
/// (with <see cref="NeedsDxgi"/>) when Desktop Duplication cannot be created on this machine.
/// </summary>
public sealed class DesktopFactAttribute : FactAttribute
{
    private static readonly Lazy<string?> DxgiProblem = new(ProbeDxgi);

    static DesktopFactAttribute()
    {
        // The real agent is per-monitor DPI aware; tests must see physical pixels too.
        PInvoke.SetProcessDpiAwarenessContext(new DPI_AWARENESS_CONTEXT(-4)); // -4 = PER_MONITOR_AWARE_V2
    }

    public DesktopFactAttribute()
    {
        if (Environment.GetEnvironmentVariable("DESKBRIDGE_SKIP_DESKTOP_TESTS") == "1")
            Skip = "DESKBRIDGE_SKIP_DESKTOP_TESTS=1";
        else if (NeedsDxgi && DxgiProblem.Value is { } problem)
            Skip = "Desktop Duplication unavailable: " + problem;
    }

    public bool NeedsDxgi { get; set; }

    private static string? ProbeDxgi()
    {
        try
        {
            using var source = new DxgiFrameSource();
            return null;
        }
        catch (Exception ex)
        {
            return ex.Message;
        }
    }
}
