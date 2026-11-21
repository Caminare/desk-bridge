using DeskBridge.Agent.Core.Relay;

namespace DeskBridge.Agent.Core.Displays;

/// <summary>
/// A monitor as Windows reports it to a per-monitor DPI aware process: bounds in physical
/// virtual-desktop pixels (the origin is negative for monitors left of or above the primary).
/// </summary>
/// <param name="Handle">HMONITOR; only valid until the display configuration changes.</param>
/// <param name="DeviceName">GDI device name such as <c>\\.\DISPLAY1</c>; stable across re-enumeration.</param>
public sealed record DisplayInfo(nint Handle, string DeviceName, int X, int Y, int Width, int Height, bool Primary);

/// <summary>
/// The known monitors and which one is streamed. The wire index of a monitor is its position in the
/// list. Not thread safe; <see cref="SwitchableFrameSource"/> serializes access.
/// </summary>
public sealed class MonitorSelector
{
    private IReadOnlyList<DisplayInfo> _displays;

    public MonitorSelector(IReadOnlyList<DisplayInfo> displays)
    {
        if (displays.Count == 0) throw new ArgumentException("At least one monitor is required.", nameof(displays));
        _displays = displays.ToArray();
        ActiveIndex = PrimaryIndex(_displays);
    }

    public IReadOnlyList<DisplayInfo> Displays => _displays;

    public int ActiveIndex { get; private set; }

    public DisplayInfo Active => _displays[ActiveIndex];

    /// <summary>Streams monitor <paramref name="index"/>, or the primary when there is no such monitor (as the PowerShell agent does).</summary>
    /// <returns>True when the active monitor changed.</returns>
    public bool Select(int index)
    {
        int resolved = index >= 0 && index < _displays.Count ? index : PrimaryIndex(_displays);
        if (resolved == ActiveIndex) return false;
        ActiveIndex = resolved;
        return true;
    }

    /// <summary>
    /// Replaces the monitor list after a display change. The active monitor is followed by device name,
    /// because indexes shift when monitors come and go; when it is gone, the primary takes over.
    /// An empty list (seen mid-reconfiguration) is ignored.
    /// </summary>
    /// <returns>True when any monitor or the active one changed.</returns>
    public bool Refresh(IReadOnlyList<DisplayInfo> displays)
    {
        if (displays.Count == 0) return false;
        DisplayInfo previous = Active;
        int index = -1;
        for (int i = 0; i < displays.Count; i++)
        {
            if (displays[i].DeviceName == previous.DeviceName) { index = i; break; }
        }
        bool changed = !displays.SequenceEqual(_displays);
        _displays = displays.ToArray();
        ActiveIndex = index >= 0 ? index : PrimaryIndex(_displays);
        return changed || Active != previous;
    }

    public RegistrationSnapshot Snapshot(string os) =>
        new(Active.Width, Active.Height, Models(), ActiveIndex, os);

    public HostUpdatePayload Update() =>
        new(Active.Width, Active.Height, ActiveIndex, Models());

    private MonitorModel[] Models() =>
        _displays.Select((d, i) => new MonitorModel(i, d.X, d.Y, d.Width, d.Height, d.Primary, ShortName(d.DeviceName))).ToArray();

    // "\\.\DISPLAY1" -> "DISPLAY1", as the PowerShell agent reports it.
    private static string ShortName(string deviceName) => deviceName.Replace("\\", "").Replace(".", "");

    private static int PrimaryIndex(IReadOnlyList<DisplayInfo> displays)
    {
        for (int i = 0; i < displays.Count; i++)
        {
            if (displays[i].Primary) return i;
        }
        return 0;
    }
}
