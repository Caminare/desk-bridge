using System.Reflection;
using DeskBridge.Agent.App;
using DeskBridge.Agent.Core.Displays;
using DeskBridge.Agent.Core.Enrollment;
using DeskBridge.Agent.Core.Input;
using DeskBridge.Agent.Core.Power;
using DeskBridge.Agent.Core.Relay;
using DeskBridge.Agent.Core.Streaming;
using DeskBridge.Agent.Windows.Capture;
using DeskBridge.Agent.Windows.Encoding;
using DeskBridge.Agent.Windows.Host;
using DeskBridge.Agent.Windows.Input;

// Must come before anything that queries monitors or screen sizes.
DpiAwareness.EnablePerMonitorV2();

string version = Assembly.GetExecutingAssembly()
    .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown";
Log($"DeskBridge agent {version}");
if (!PowerThrottling.OptOutOfExecutionSpeedThrottling()) Log("Could not opt out of power throttling; encoding may be slow.");

string configPath = ArgValue(args, "--config")
    ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DeskBridge", "agent.json");
string stateDir = Path.GetDirectoryName(Path.GetFullPath(configPath))!;
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

// One agent per Windows user: a second one would fight over the host id, and --reenroll from a
// second process would rotate the secret out from under the running one.
using var instance = new Mutex(initiallyOwned: true, @"Local\DeskBridge.Agent", out bool firstInstance);
if (!firstInstance)
{
    string message = "DeskBridge agent is already running for this user. Close it first (Ctrl+C in its window)."
        + (args.Contains("--keep-awake") ? " The keep-awake setting applies when it next starts." : "");
    Log(message);
    if (args.Contains("--reenroll")) MessageBox.Show(message, "DeskBridge", MessageBoxButtons.OK, MessageBoxIcon.Information);
    return 3;
}

var secrets = new DpapiHostSecretStore(Path.Combine(stateDir, "host-secret.bin"));
using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
var enrollment = new EnrollmentClient(http);
bool reenroll = args.Contains("--reenroll");
// Per-frame timing CSV for latency work; off unless asked for.
string? perfLogPath = ArgValue(args, "--perf-log");

// Opt-in (--keep-awake on): for the agent's whole run, across disconnects and reconnects, so the PC is still awake
// and unlocked when a controller comes back.
using var powerHold = stateFile.Load(out _).KeepAwake ? new PowerRequestHold(Log) : null;
using var keepAwake = powerHold is null ? null : new KeepAwakeController(powerHold, Environment.TickCount64);
using var nudgeTimer = keepAwake is null ? null : new System.Threading.Timer(_ => keepAwake.Tick(Environment.TickCount64), null, 10_000, 10_000);
if (keepAwake is not null) Log("Keep-awake on: the PC and display stay awake and unlocked while the agent runs.");

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    cts.Cancel();
};

while (!cts.IsCancellationRequested)
{
    AgentState state = stateFile.Load(out string? stateError);
    if (stateError is not null) Log(stateError);

    if (reenroll || !state.IsEnrolled || secrets.Load() is null)
    {
        Log(reenroll && state.IsEnrolled ? $"Re-enrolling {state.HostId}." : "This PC is not enrolled. Opening the enrollment window.");
        var outcome = EnrollmentForm.Run(enrollment, state.Name, state.IsEnrolled ? state.HostId : null);
        if (outcome is null)
        {
            Log("Enrollment cancelled.");
            return 1;
        }
        secrets.Save(outcome.Credentials.HostSecret);
        state.RelayUrl = outcome.Target.WebSocketUri.ToString();
        state.HostId = outcome.Credentials.HostId;
        state.Name = outcome.Name;
        stateFile.Save(state);
        reenroll = false;
        Log($"Enrolled as {state.HostId} on {outcome.Target.RelayBase}.");
    }

    RelayStopReason reason = await RunAgentAsync(state, secrets, perfLogPath, cts.Token);
    if (reason != RelayStopReason.Revoked) break;
    stateFile.ForgetEnrollment();
}
Log("Stopped.");
return 0;

static async Task<RelayStopReason> RunAgentAsync(AgentState state, IHostSecretStore secrets, string? perfLogPath, CancellationToken ct)
{
    var options = new RelayOptions(state.RelayUri!, state.HostId, state.Name, state.GroupLabel);

    // Streams the primary monitor until the controller picks another; follows display changes.
    using var source = new SwitchableFrameSource(MonitorEnumerator.List, d => FrameSourceFactory.Create(d.Handle, Log), Log);
    using var encoder = new TurboJpegTileEncoder();
    Log($"Capture: {source.Method} {DescribeMonitor(source.Active)}. Host id {state.HostId}. Relay {state.RelayUri}");

    var injector = new InputInjector(() =>
    {
        DisplayInfo d = source.Active;
        return (d.X, d.Y, d.Width, d.Height);
    });
    using var input = new InputWorker(injector, ex => Log($"Input error: {ex.GetType().Name}"));

    var relay = new RelayClient(
        options,
        () =>
        {
            // Monitors may have changed while disconnected; a difference is sent as host:update right after.
            source.RequestRefresh();
            return source.Snapshot(Environment.OSVersion.VersionString);
        },
        secrets,
        new ClientWebSocketTransportFactory());
    source.DisplaysChanged += () =>
    {
        Log($"Streaming {DescribeMonitor(source.Active)} ({source.Method}).");
        _ = SendHostUpdateAsync(relay, source.Update());
    };

    var ignoredInput = new IgnoredInputLog(Log);
    using CsvPerfLog? perfLog = perfLogPath is null ? null : CsvPerfLog.Create(perfLogPath);
    if (perfLog is not null) Log($"Writing per-frame timing to {Path.GetFullPath(perfLogPath!)}");

    var settings = new StreamSettings(state.MaxWidth, state.JpegQuality);
    StreamingEngine? engineRef = null;
    using var engine = new StreamingEngine(relay, source, encoder, settings,
        payload =>
        {
            switch (InputParser.Parse(payload))
            {
                case SelectMonitor m:
                    // Applied by the capture thread; wake it so the switch shows promptly.
                    source.RequestMonitor(m.Index);
                    engineRef?.NotifyInputApplied();
                    break;
                case { } command:
                    input.TryEnqueue(command);
                    break;
                default:
                    ignoredInput.Report(payload);
                    break;
            }
        },
        Log,
        perfLog is null ? null : new FramePerfOptions(perfLog, ThreadCycles.Current));
    engineRef = engine;
    input.InputApplied += engine.NotifyInputApplied;

    Log("Running. Press Ctrl+C to stop.");
    return await engine.RunAsync(ct);
}

static string DescribeMonitor(DisplayInfo d) =>
    $"{d.DeviceName} {d.Width}x{d.Height} at ({d.X},{d.Y}){(d.Primary ? " primary" : "")}";

static async Task SendHostUpdateAsync(RelayClient relay, HostUpdatePayload update)
{
    try
    {
        await relay.SendEventAsync("host:update", update).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
        // Offline: the next host:register carries the current monitors anyway.
        Log($"host:update not sent: {ex.GetType().Name}");
    }
}

static void Log(string message) => Console.WriteLine($"{DateTime.Now:HH:mm:ss} {message}");

static string? ArgValue(string[] args, string name)
{
    int i = Array.IndexOf(args, name);
    return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
}
