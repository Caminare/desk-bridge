using System.Text.Json;

namespace DeskBridge.Agent.Core.Input;

/// <summary>
/// Logs input the parser rejected, once per type, so a controller feature this agent lacks is visible
/// without flooding the console. Type names come from the controller, so they are trimmed to printable
/// characters and the number of remembered names is capped.
/// </summary>
public sealed class IgnoredInputLog
{
    private const int MaxNameLength = 32;
    private const int MaxRemembered = 64;
    private const string MalformedKey = "\0malformed";
    private readonly Action<string> _log;
    private readonly HashSet<string> _seen = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    public IgnoredInputLog(Action<string> log) => _log = log;

    public void Report(JsonElement payload)
    {
        string? type = payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty("type", out JsonElement t) && t.ValueKind == JsonValueKind.String
                ? Sanitise(t.GetString()!)
                : null;
        string key = type ?? MalformedKey;
        lock (_gate)
        {
            if (_seen.Count >= MaxRemembered || !_seen.Add(key)) return;
        }
        _log(type is null ? "Ignoring malformed input." : $"Ignoring input type '{type}' (not supported by this agent yet).");
    }

    private static string Sanitise(string name)
    {
        var chars = name.Where(c => c is >= ' ' and <= '~').Take(MaxNameLength).ToArray();
        return new string(chars);
    }
}
