namespace DeskBridge.Agent.Core.Protocol;

/// <summary>One v2 tile (or the whole v1 JPEG). <see cref="Offset"/> is relative to the start of the message.</summary>
public readonly record struct FrameTile(int X, int Y, int W, int H, int Offset, int Length);

/// <summary>Input for the encoder: a tile rectangle in stream pixels plus its JPEG bytes.</summary>
public readonly record struct TileInput(int X, int Y, int W, int H, ReadOnlyMemory<byte> Data);

/// <summary>Result of <see cref="FrameCodec.TryParse(ReadOnlySpan{byte}, out ParsedFrame?)"/>.</summary>
public sealed class ParsedFrame
{
    public required int Version { get; init; }
    public required FrameHeader Header { get; init; }

    /// <summary>Offset of the payload within the message.</summary>
    public required int PayloadOffset { get; init; }

    /// <summary>True for v1 frames and v2 keyframes.</summary>
    public required bool IsKey { get; init; }

    /// <summary>v2 tiles; for v1 a single tile spanning the payload (w/h unknown = 0).</summary>
    public required FrameTile[] Tiles { get; init; }
}
