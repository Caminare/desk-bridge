using System.Runtime.InteropServices;
using DeskBridge.Agent.Core.Logging;

namespace DeskBridge.Agent.App;

/// <summary>
/// The agent's log: a rolling file under the state folder, plus the terminal when started with <c>--console</c>
/// (the exe is a GUI app, so it has no console of its own). Never pass secrets.
/// </summary>
internal static class AgentLog
{
    public const long MaxFileBytes = 1_000_000;

    private static RollingFileLog? s_file;
    private static TextWriter? s_console;

    public static string? FilePath => s_file?.FilePath;

    public static void Start(string stateDir, bool console)
    {
        s_file = new RollingFileLog(Path.Combine(stateDir, "logs", "agent.log"), MaxFileBytes);
        if (console) s_console = AttachConsole();
    }

    public static void Write(string message)
    {
        string line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}";
        s_file?.WriteLine(line);
        try
        {
            s_console?.WriteLine(line);
        }
        catch (IOException)
        {
            // The terminal was closed; the file still has the line.
        }
    }

    public static void Stop()
    {
        s_file?.Dispose();
        s_file = null;
    }

    /// <summary>Uses the terminal the agent was started from, or opens a console window if there is none.</summary>
    private static TextWriter AttachConsole()
    {
        if (!AttachConsoleNative(AttachParentProcess)) AllocConsole();
        var writer = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };
        Console.SetOut(writer);
        return writer;
    }

    private const int AttachParentProcess = -1;

    [DllImport("kernel32.dll", EntryPoint = "AttachConsole", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachConsoleNative(int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AllocConsole();
}
