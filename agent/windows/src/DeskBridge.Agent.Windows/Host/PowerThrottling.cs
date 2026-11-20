using Windows.Win32;
using Windows.Win32.System.Threading;

namespace DeskBridge.Agent.Windows.Host;

public static class PowerThrottling
{
    /// <summary>
    /// Opts the process out of execution-speed throttling (EcoQoS). The agent usually has no foreground window,
    /// so Windows treats it as background work and runs it on efficiency cores at low clock, which made JPEG
    /// encoding several times slower than in a foreground run (T4). Returns false when the call failed
    /// (Windows 10 before 1709 lacks it).
    /// </summary>
    public static unsafe bool OptOutOfExecutionSpeedThrottling()
    {
        var state = new PROCESS_POWER_THROTTLING_STATE
        {
            Version = PInvoke.PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask = PInvoke.PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
            StateMask = 0, // controlled, and off
        };
        return PInvoke.SetProcessInformation(PInvoke.GetCurrentProcess(), PROCESS_INFORMATION_CLASS.ProcessPowerThrottling,
            &state, (uint)sizeof(PROCESS_POWER_THROTTLING_STATE));
    }
}
