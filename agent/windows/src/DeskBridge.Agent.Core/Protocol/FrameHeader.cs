using System.Text.Json.Serialization;

namespace DeskBridge.Agent.Core.Protocol;

/// <summary>
/// JSON header of a binary frame. Mirrors <c>FrameHeader</c> in src/lib/frameProtocol.ts: every field is
/// optional and omitted from the wire when null. Numbers are doubles because the wire format is JSON
/// (the parser has to be able to see, and reject, a fractional <c>w</c>).
/// Property declaration order is the order the encoder writes them in.
/// </summary>
public sealed class FrameHeader
{
    [JsonPropertyName("hostId")] public string? HostId { get; init; }
    [JsonPropertyName("seq")] public double? Seq { get; init; }
    [JsonPropertyName("activeWindow")] public string? ActiveWindow { get; init; }
    [JsonPropertyName("timestamp")] public double? Timestamp { get; init; }

    /// <summary>v2: frame width in stream pixels.</summary>
    [JsonPropertyName("w")] public double? W { get; init; }

    /// <summary>v2: frame height in stream pixels.</summary>
    [JsonPropertyName("h")] public double? H { get; init; }

    /// <summary>v2: keyframe flag.</summary>
    [JsonPropertyName("key")] public bool? Key { get; init; }

    /// <summary>
    /// v2: flat [x, y, w, h, len] tuples. Filled in by the v2 encoder (any value set here is ignored when
    /// encoding v2) and populated by the parser.
    /// </summary>
    [JsonPropertyName("r")] public double[]? R { get; init; }

    [JsonPropertyName("stats")] public AgentFrameStats? Stats { get; init; }
}
