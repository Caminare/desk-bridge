using System.Text.Json.Serialization;

namespace DeskBridge.Agent.Core.Protocol;

/// <summary>Per-frame pipeline stats (all optional). Mirrors <c>AgentFrameStats</c> in src/lib/frameProtocol.ts.</summary>
public sealed class AgentFrameStats
{
    /// <summary>Capture + scale time for this frame, ms.</summary>
    [JsonPropertyName("cap")] public double? Cap { get; init; }
    /// <summary>JPEG encode time for this frame, ms.</summary>
    [JsonPropertyName("enc")] public double? Enc { get; init; }
    /// <summary>Smoothed round trip from send to ack, ms.</summary>
    [JsonPropertyName("rtt")] public double? Rtt { get; init; }
    /// <summary>Smoothed upload rate, kbit/s.</summary>
    [JsonPropertyName("kbps")] public double? Kbps { get; init; }
    /// <summary>Current JPEG quality.</summary>
    [JsonPropertyName("q")] public double? Q { get; init; }
    /// <summary>Current stream width.</summary>
    [JsonPropertyName("mw")] public double? Mw { get; init; }
    /// <summary>Changed tiles in this frame.</summary>
    [JsonPropertyName("ch")] public double? Ch { get; init; }
    /// <summary>Total tiles in this frame.</summary>
    [JsonPropertyName("tt")] public double? Tt { get; init; }
    /// <summary>Frames currently awaiting an ack.</summary>
    [JsonPropertyName("inf")] public double? Inf { get; init; }
    /// <summary>Path baseline RTT (minimum over the recent window), ms.</summary>
    [JsonPropertyName("brtt")] public double? Brtt { get; init; }
    /// <summary>Agent send window, KB.</summary>
    [JsonPropertyName("win")] public double? Win { get; init; }
    /// <summary>Capture method.</summary>
    [JsonPropertyName("cm")] public string? Cm { get; init; }
    /// <summary>Frames per second actually sent (last second).</summary>
    [JsonPropertyName("sfps")] public double? Sfps { get; init; }
    /// <summary>Downscaling used for this frame: ht, coc, bil, nn, none.</summary>
    [JsonPropertyName("sm")] public string? Sm { get; init; }
    /// <summary>Smoothed capture time with smooth scaling, ms.</summary>
    [JsonPropertyName("caps")] public double? Caps { get; init; }
    /// <summary>Smoothed capture time with coarse scaling, ms.</summary>
    [JsonPropertyName("capc")] public double? Capc { get; init; }
    /// <summary>Tile diff time for this frame, ms.</summary>
    [JsonPropertyName("dif")] public double? Dif { get; init; }
    /// <summary>Smoothed capture-thread cycle, ms.</summary>
    [JsonPropertyName("tick")] public double? Tick { get; init; }
    /// <summary>Captures per second.</summary>
    [JsonPropertyName("cfps")] public double? Cfps { get; init; }
    /// <summary>Frames produced per second.</summary>
    [JsonPropertyName("pfps")] public double? Pfps { get; init; }
    /// <summary>Captures with no change per second.</summary>
    [JsonPropertyName("same")] public double? Same { get; init; }
    /// <summary>Frames dropped (replaced before sending) per second.</summary>
    [JsonPropertyName("drop")] public double? Drop { get; init; }
    /// <summary>Re-diffs per second.</summary>
    [JsonPropertyName("rd")] public double? Rd { get; init; }
    /// <summary>Keyframes per second.</summary>
    [JsonPropertyName("kf")] public double? Kf { get; init; }
    /// <summary>Why the latest keyframe was sent: req, init, big.</summary>
    [JsonPropertyName("kr")] public string? Kr { get; init; }
    /// <summary>Time this frame waited in the mailbox, ms.</summary>
    [JsonPropertyName("age")] public double? Age { get; init; }
    /// <summary>How long the previous frame's send took, ms.</summary>
    [JsonPropertyName("snd")] public double? Snd { get; init; }
    /// <summary>Main-loop iterations per second.</summary>
    [JsonPropertyName("lps")] public double? Lps { get; init; }
    /// <summary>Keyframe requests received per second.</summary>
    [JsonPropertyName("kreq")] public double? Kreq { get; init; }
}
