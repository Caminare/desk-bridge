using Windows.Win32;

namespace DeskBridge.Agent.Windows.Host;

public static class ThreadCycles
{
    /// <summary>
    /// CPU cycles the calling thread has used so far (QueryThreadCycleTime), or 0 if the call fails.
    /// Cycles divided by wall time give the effective clock a piece of work ran at.
    /// </summary>
    public static unsafe ulong Current()
    {
        ulong cycles;
        return PInvoke.QueryThreadCycleTime(PInvoke.GetCurrentThread(), &cycles) ? cycles : 0;
    }
}
