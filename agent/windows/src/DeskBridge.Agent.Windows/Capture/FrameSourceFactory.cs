using DeskBridge.Agent.Core.Streaming;

namespace DeskBridge.Agent.Windows.Capture;

public static class FrameSourceFactory
{
    /// <summary>
    /// Desktop Duplication when it can be created, otherwise GDI (RDP sessions, some VMs, no GPU driver).
    /// </summary>
    /// <param name="monitor">HMONITOR to capture; 0 selects the primary monitor.</param>
    /// <param name="log">Receives the reason when DXGI is skipped.</param>
    /// <param name="allowDxgi">False forces GDI, e.g. from a command-line switch.</param>
    public static IFrameSource Create(nint monitor = 0, Action<string>? log = null, bool allowDxgi = true)
    {
        if (allowDxgi)
        {
            try
            {
                return new DxgiFrameSource(monitor);
            }
            catch (Exception ex)
            {
                log?.Invoke($"DXGI capture unavailable, using GDI: {ex.Message}");
            }
        }
        return new GdiFrameSource(monitor);
    }
}
