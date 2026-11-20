using System.Text.Json;
using System.Text.Json.Serialization;

namespace DeskBridge.Agent.Core.Enrollment;

/// <summary>
/// Contents of agent.json: where this PC is enrolled and its stream preferences.
/// Holds no secrets; the host secret lives in the DPAPI store next to it.
/// </summary>
public sealed class AgentState
{
    [JsonPropertyName("relayUrl")] public string RelayUrl { get; set; } = "";
    [JsonPropertyName("hostId")] public string HostId { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = Environment.MachineName;
    [JsonPropertyName("groupLabel")] public string GroupLabel { get; set; } = "Workstation";
    [JsonPropertyName("maxWidth")] public int MaxWidth { get; set; } = 1152;
    [JsonPropertyName("jpegQuality")] public int JpegQuality { get; set; } = 62;

    [JsonIgnore]
    public Uri? RelayUri =>
        Uri.TryCreate(RelayUrl, UriKind.Absolute, out var uri) && uri.Scheme is "ws" or "wss" ? uri : null;

    [JsonIgnore]
    public bool IsEnrolled =>
        RelayUri is not null &&
        HostId.Length is > 0 and <= 64 &&
        HostId.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.');
}

public sealed class AgentStateFile(string path)
{
    public string Path { get; } = path;

    /// <summary>Never throws for a missing or corrupt file: returns defaults (not enrolled) and an error for the log.</summary>
    public AgentState Load(out string? error)
    {
        error = null;
        if (!File.Exists(Path)) return new AgentState();
        try
        {
            return JsonSerializer.Deserialize(File.ReadAllText(Path), AgentStateJson.Default.AgentState) ?? new AgentState();
        }
        catch (JsonException ex)
        {
            error = $"{Path} is not valid ({ex.Message.Split('.')[0]}); enrolling again.";
            return new AgentState();
        }
    }

    public void Save(AgentState state)
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(Path))!);
        string tmp = Path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(state, AgentStateJson.Default.AgentState));
        File.Move(tmp, Path, overwrite: true);
    }

    /// <summary>After the relay revoked this PC: drop the host id, keep name and stream preferences.</summary>
    public void ForgetEnrollment()
    {
        var state = Load(out _);
        state.HostId = "";
        Save(state);
    }
}

[JsonSourceGenerationOptions(WriteIndented = true)]
[JsonSerializable(typeof(AgentState))]
internal sealed partial class AgentStateJson : JsonSerializerContext;
