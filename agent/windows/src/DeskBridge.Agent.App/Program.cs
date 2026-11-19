using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
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

string configPath = ArgValue(args, "--config")
    ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DeskBridge", "agent.json");
AgentConfig? config = AgentConfig.Load(configPath, out string? configError);
if (config is null)
{
    Log(configError!);
    return 2;
}
string stateDir = Path.GetDirectoryName(Path.GetFullPath(configPath))!;

string hostId = LoadOrCreateHostId(Path.Combine(stateDir, "host-id.txt"));
var secrets = new DpapiHostSecretStore(Path.Combine(stateDir, "host-secret.bin"));
var options = new RelayOptions(config.RelayUri, config.EnrollKey, hostId, config.Name, config.GroupLabel);

using IFrameSource source = FrameSourceFactory.Create(log: Log);
using var encoder = new TurboJpegTileEncoder();
var (srcW, srcH) = source.SourceSize;
Log($"Capture: {source.Method} {srcW}x{srcH}. Host id {hostId}. Relay {config.RelayUri}");

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

var settings = new StreamSettings(config.MaxWidth, config.JpegQuality);
using var engine = new StreamingEngine(relay, source, encoder, settings,
    payload =>
    {
        if (InputParser.Parse(payload) is { } command) input.TryEnqueue(command);
    },
    Log);
input.InputApplied += engine.NotifyInputApplied;

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    cts.Cancel();
};
Log("Running. Press Ctrl+C to stop.");
await engine.RunAsync(cts.Token);
Log("Stopped.");
return 0;

static void Log(string message) => Console.WriteLine($"{DateTime.Now:HH:mm:ss} {message}");

static string? ArgValue(string[] args, string name)
{
    int i = Array.IndexOf(args, name);
    return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
}

static string LoadOrCreateHostId(string path)
{
    if (File.Exists(path))
    {
        string existing = File.ReadAllText(path).Trim();
        if (existing.Length is > 0 and <= 64 && existing.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.')) return existing;
    }
    string id = "win-" + Guid.NewGuid().ToString("N")[..8];
    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
    File.WriteAllText(path, id);
    return id;
}

/// <summary>agent.json: relay connection and stream defaults. The enrollment key is never logged.</summary>
internal sealed class AgentConfig
{
    [JsonPropertyName("relayUrl")] public string RelayUrl { get; set; } = "";
    [JsonPropertyName("enrollKey")] public string EnrollKey { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = Environment.MachineName;
    [JsonPropertyName("groupLabel")] public string GroupLabel { get; set; } = "Workstation";
    [JsonPropertyName("maxWidth")] public int MaxWidth { get; set; } = 1152;
    [JsonPropertyName("jpegQuality")] public int JpegQuality { get; set; } = 62;

    [JsonIgnore] public Uri RelayUri { get; private set; } = null!;

    public static AgentConfig? Load(string path, out string? error)
    {
        error = null;
        if (!File.Exists(path))
        {
            error = $"Config not found: {path}. Create it with relayUrl (wss://host/ws) and enrollKey.";
            return null;
        }
        AgentConfig? c;
        try
        {
            c = JsonSerializer.Deserialize(File.ReadAllText(path), AgentConfigJson.Default.AgentConfig);
        }
        catch (JsonException ex)
        {
            error = $"Config is not valid JSON ({path}): line {ex.LineNumber}.";
            return null;
        }
        if (c is null || !Uri.TryCreate(c.RelayUrl, UriKind.Absolute, out Uri? uri) || uri.Scheme is not ("ws" or "wss"))
        {
            error = $"Config {path}: relayUrl must be a ws:// or wss:// URL (e.g. wss://relay.example.com/ws).";
            return null;
        }
        if (string.IsNullOrWhiteSpace(c.EnrollKey))
        {
            error = $"Config {path}: enrollKey is missing.";
            return null;
        }
        c.RelayUri = uri;
        return c;
    }

    public override string ToString() => $"AgentConfig {{ RelayUrl = {RelayUrl}, Name = {Name} }}";
}

[JsonSerializable(typeof(AgentConfig))]
internal sealed partial class AgentConfigJson : JsonSerializerContext;
