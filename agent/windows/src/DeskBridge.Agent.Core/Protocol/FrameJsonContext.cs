using System.Text.Json.Serialization;

namespace DeskBridge.Agent.Core.Protocol;

/// <summary>Source-generated (trim and AOT friendly) JSON metadata for the frame header.</summary>
[JsonSourceGenerationOptions(DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(FrameHeader))]
public sealed partial class FrameJsonContext : JsonSerializerContext
{
}
