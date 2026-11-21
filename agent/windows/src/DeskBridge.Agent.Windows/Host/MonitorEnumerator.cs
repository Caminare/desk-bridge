using DeskBridge.Agent.Core.Displays;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.Graphics.Gdi;

namespace DeskBridge.Agent.Windows.Host;

public static unsafe class MonitorEnumerator
{
    // MONITORINFOF_PRIMARY
    private const uint PrimaryFlag = 1;

    /// <summary>
    /// Lists the attached monitors in Windows' enumeration order (the order the PowerShell agent's
    /// Screen.AllScreens uses). Bounds are physical pixels because the process is per-monitor DPI aware.
    /// </summary>
    public static IReadOnlyList<DisplayInfo> List()
    {
        var displays = new List<DisplayInfo>();
        PInvoke.EnumDisplayMonitors(HDC.Null, (RECT?)null, (hmon, _, _, _) =>
        {
            MONITORINFOEXW info = default;
            info.monitorInfo.cbSize = (uint)sizeof(MONITORINFOEXW);
            if (PInvoke.GetMonitorInfo(hmon, (MONITORINFO*)&info))
            {
                RECT r = info.monitorInfo.rcMonitor;
                displays.Add(new DisplayInfo(
                    (nint)hmon.Value,
                    info.szDevice.ToString(),
                    r.left, r.top, r.Width, r.Height,
                    (info.monitorInfo.dwFlags & PrimaryFlag) != 0));
            }
            return true;
        }, default);
        return displays;
    }
}
