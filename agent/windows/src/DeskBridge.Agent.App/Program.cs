using System.Reflection;
using DeskBridge.Agent.App;
using DeskBridge.Agent.Core.Enrollment;
using DeskBridge.Agent.Core.Input;
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

// One agent per Windows user: a second one would fight over the host id, and --reenroll from a
// second process would rotate the secret out from under the running one.
using var instance = new Mutex(initiallyOwned: true, @"Local\DeskBridge.Agent", out bool firstInstance);
if (!firstInstance)
{
    const string message = "DeskBridge agent is already running for this user. Close it first (Ctrl+C in its window).";
    Log(message);
    if (args.Contains("--reenroll")) MessageBox.Show(message, "DeskBridge", MessageBoxButtons.OK, MessageBoxIcon.Information);
    return 3;
}

string configPath = ArgValue(args, "--config")
    ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DeskBridge", "agent.json");
string stateDir = Path.GetDirectoryName(Path.GetFullPath(configPath))!;
var stateFile = new AgentStateFile(configPath);
var secrets = new DpapiHostSecretStore(Path.Combine(stateDir, "host-secret.bin"));
using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
var enrollment = new EnrollmentClient(http);
bool reenroll = args.Contains("--reenroll");

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

    RelayStopReason reason = await RunAgentAsync(state, secrets, cts.Token);
    if (reason != RelayStopReason.Revoked) break;
    stateFile.ForgetEnrollment();
}
Log("Stopped.");
return 0;

static async Task<RelayStopReason> RunAgentAsync(AgentState state, IHostSecretStore secrets, CancellationToken ct)
{
    var options = new RelayOptions(state.RelayUri!, state.HostId, state.Name, state.GroupLabel);

    using IFrameSource source = FrameSourceFactory.Create(log: Log);
    using var encoder = new TurboJpegTileEncoder();
    var (srcW, srcH) = source.SourceSize;
    Log($"Capture: {source.Method} {srcW}x{srcH}. Host id {state.HostId}. Relay {state.RelayUri}");

    // Phase 0 streams and controls the primary monitor, whose top-left is the virtual-desktop origin.
    var injector = new InputInjector(() => (0, 0, source.SourceSize.Width, source.SourceSize.Height));
    using var input = new InputWorker(injector, ex => Log($"Input error: {ex.GetType().Name}"));

    var relay = new RelayClient(
        options,
        () =>
        {
            var (w, h) = source.SourceSize;
            return new RegistrationSnapshot(w, h, [new MonitorModel(0, 0, 0, w, h, true, "Primary")], 0, Environment.OSVersion.VersionString);
        },
        secrets,
        new ClientWebSocketTransportFactory());

    var settings = new StreamSettings(state.MaxWidth, state.JpegQuality);
    using var engine = new StreamingEngine(relay, source, encoder, settings,
        payload =>
        {
            if (InputParser.Parse(payload) is { } command) input.TryEnqueue(command);
        },
        Log);
    input.InputApplied += engine.NotifyInputApplied;

    Log("Running. Press Ctrl+C to stop.");
    return await engine.RunAsync(ct);
}

static void Log(string message) => Console.WriteLine($"{DateTime.Now:HH:mm:ss} {message}");

static string? ArgValue(string[] args, string name)
{
    int i = Array.IndexOf(args, name);
    return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
}
