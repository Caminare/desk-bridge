using System.Reflection;
using DeskBridge.Agent.Core.Enrollment;
using DeskBridge.Agent.Core.Hosting;
using DeskBridge.Agent.Core.Power;
using DeskBridge.Agent.Core.Startup;
using DeskBridge.Agent.Core.Status;
using DeskBridge.Agent.Windows.Host;
using Microsoft.Win32;

namespace DeskBridge.Agent.App;

internal static class Program
{
    /// <summary>
    /// A tray app: the UI thread runs the WinForms message loop (tray icon, enrollment window) while the supervisor
    /// runs the agent on the thread pool. Not async: an async Main would lose the STA apartment after the first await.
    /// </summary>
    [STAThread]
    private static int Main(string[] args)
    {
        // Must come before anything that queries monitors or screen sizes.
        DpiAwareness.EnablePerMonitorV2();

        string configPath = ArgValue(args, "--config")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DeskBridge", "agent.json");
        string stateDir = Path.GetDirectoryName(Path.GetFullPath(configPath))!;
        AgentLog.Start(stateDir, console: args.Contains("--console"));
        try
        {
            return Run(args, configPath, stateDir);
        }
        catch (Exception ex)
        {
            Log($"Fatal: {ex}");
            throw;
        }
        finally
        {
            AgentLog.Stop();
        }
    }

    private static int Run(string[] args, string configPath, string stateDir)
    {
        string version = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown";
        Log($"DeskBridge agent {version}");
        if (!PowerThrottling.OptOutOfExecutionSpeedThrottling()) Log("Could not opt out of power throttling; encoding may be slow.");

        var stateFile = new AgentStateFile(configPath);

        // Saved before the single-instance check, so it also works while an agent is running (it applies on the next start).
        if (args.Contains("--keep-awake"))
        {
            bool? keepAwakeSetting = ArgValue(args, "--keep-awake") switch { "on" => true, "off" => false, _ => null };
            if (keepAwakeSetting is null)
            {
                Log("Usage: --keep-awake on|off");
                return 2;
            }
            AgentState saved = stateFile.Load(out _);
            saved.KeepAwake = keepAwakeSetting.Value;
            stateFile.Save(saved);
            Log($"Keep-awake {(keepAwakeSetting.Value ? "on" : "off")} saved to {stateFile.Path}.");
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        // One agent per Windows user: a second one would fight over the host id, and --reenroll from a
        // second process would rotate the secret out from under the running one.
        using var instance = new Mutex(initiallyOwned: true, @"Local\DeskBridge.Agent", out bool firstInstance);
        if (!firstInstance)
        {
            string message = "DeskBridge agent is already running for this user. Use its tray icon (Re-enroll, Keep PC awake), or Quit it there first."
                + (args.Contains("--keep-awake") ? " The keep-awake setting applies when it next starts." : "");
            Log(message);
            if (args.Contains("--reenroll")) MessageBox.Show(message, "DeskBridge", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 3;
        }

        // Created here so the agent's background threads can post to the UI thread before Application.Run starts.
        var ui = new WindowsFormsSynchronizationContext();
        SynchronizationContext.SetSynchronizationContext(ui);

        var secrets = new DpapiHostSecretStore(Path.Combine(stateDir, "host-secret.bin"));
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        var status = new AgentStatusTracker();
        status.Changed += s => Log($"Status: {s.Summary}");
        var host = new AgentHost(stateFile, secrets, new EnrollmentClient(http), status, ui, ArgValue(args, "--perf-log"), Log);
        var supervisor = new AgentSupervisor(host, status, Log);

        // Opt-in, switchable from the tray: held for the agent's whole run, across disconnects and reconnects, so the
        // PC is still awake and unlocked when a controller comes back.
        using var powerHold = new PowerRequestHold(Log);
        using var keepAwake = new KeepAwakeController(powerHold, stateFile.Load(out _).KeepAwake, Environment.TickCount64);
        using var nudgeTimer = new System.Threading.Timer(_ => keepAwake.Tick(Environment.TickCount64), null, 10_000, 10_000);
        if (keepAwake.Enabled) Log("Keep-awake on: the PC and display stay awake and unlocked while the agent runs.");

        var autostart = new Autostart(new RegistryRunKey(), Environment.ProcessPath!);
        using var tray = new TrayApp(supervisor, status, keepAwake, stateFile, autostart, version, Log);

        Console.CancelKeyPress += (_, e) =>
        {
            // --console: Ctrl+C in the terminal quits like the tray's Quit.
            e.Cancel = true;
            supervisor.Stop();
        };
        // Close the relay connection cleanly on sign-out or shutdown.
        SystemEvents.SessionEnding += (_, _) => supervisor.Stop();

        SupervisorExit exit = SupervisorExit.Stopped;
        _ = Task.Run(async () =>
        {
            try
            {
                exit = await supervisor.RunAsync(reenrollFirst: args.Contains("--reenroll"));
            }
            catch (Exception ex)
            {
                Log($"Agent crashed: {ex}");
            }
            finally
            {
                tray.Exit();
            }
        });

        Application.Run(tray);
        Log("Stopped.");
        return exit == SupervisorExit.EnrollmentCancelled ? 1 : 0;
    }

    private static void Log(string message) => AgentLog.Write(message);

    private static string? ArgValue(string[] args, string name)
    {
        int i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }
}
