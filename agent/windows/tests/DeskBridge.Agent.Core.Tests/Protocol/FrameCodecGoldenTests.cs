using System.Text.Json;
using DeskBridge.Agent.Core.Protocol;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Protocol;

/// <summary>
/// Verifies the C# codec against the same golden vectors as tests/frameProtocol.test.ts.
/// Regenerate the vectors with <c>npx tsx tests/fixtures/frames/generate.ts</c>.
/// </summary>
public class FrameCodecGoldenTests
{
    private static readonly string Dir = Path.Combine(AppContext.BaseDirectory, "fixtures", "frames");

    private static readonly JsonElement[] Cases =
        JsonDocument.Parse(File.ReadAllText(Path.Combine(Dir, "cases.json"))).RootElement.GetProperty("cases").EnumerateArray().ToArray();

    public static TheoryData<string> AcceptNames() => Names("accept");

    public static TheoryData<string> RejectNames() => Names("reject");

    private static TheoryData<string> Names(string expect)
    {
        var data = new TheoryData<string>();
        foreach (JsonElement c in Cases)
        {
            if (c.GetProperty("expect").GetString() == expect) data.Add(c.GetProperty("name").GetString()!);
        }
        return data;
    }

    private static JsonElement Case(string name) => Cases.Single(c => c.GetProperty("name").GetString() == name);

    [Fact]
    public void Vectors_cover_valid_and_malformed_frames()
    {
        Assert.NotEmpty(AcceptNames());
        Assert.NotEmpty(RejectNames());
    }

    [Theory]
    [MemberData(nameof(AcceptNames))]
    public void Encoder_output_matches_the_typescript_bytes(string name)
    {
        JsonElement c = Case(name);
        byte[] expected = File.ReadAllBytes(Path.Combine(Dir, c.GetProperty("file").GetString()!));
        FrameHeader header = JsonSerializer.Deserialize(c.GetProperty("header"), FrameJsonContext.Default.FrameHeader)!;

        byte[] actual = c.GetProperty("version").GetInt32() == 1
            ? FrameCodec.EncodeV1(header, Convert.FromHexString(c.GetProperty("payload").GetString()!))
            : FrameCodec.EncodeV2(header, ReadTiles(c));

        Assert.Equal(expected, actual);

        // The IBufferWriter overload must produce the same bytes.
        var writer = new System.Buffers.ArrayBufferWriter<byte>();
        if (c.GetProperty("version").GetInt32() == 1)
            FrameCodec.EncodeV1(writer, header, Convert.FromHexString(c.GetProperty("payload").GetString()!));
        else
            FrameCodec.EncodeV2(writer, header, ReadTiles(c));
        Assert.Equal(expected, writer.WrittenSpan.ToArray());
    }

    [Theory]
    [MemberData(nameof(AcceptNames))]
    public void Parser_accepts_valid_frames_with_matching_tiles_and_header(string name)
    {
        JsonElement c = Case(name);
        byte[] bytes = File.ReadAllBytes(Path.Combine(Dir, c.GetProperty("file").GetString()!));

        Assert.True(FrameCodec.TryParse(bytes.AsSpan(), out ParsedFrame? frame));
        Assert.Equal(c.GetProperty("version").GetInt32(), frame.Version);

        FrameHeader expected = JsonSerializer.Deserialize(c.GetProperty("header"), FrameJsonContext.Default.FrameHeader)!;
        Assert.Equal(expected.HostId, frame.Header.HostId);
        Assert.Equal(expected.Seq, frame.Header.Seq);
        Assert.Equal(expected.ActiveWindow, frame.Header.ActiveWindow);
        Assert.Equal(expected.Timestamp, frame.Header.Timestamp);
        Assert.Equal(expected.W, frame.Header.W);
        Assert.Equal(expected.H, frame.Header.H);
        Assert.Equal(expected.Key, frame.Header.Key);
        Assert.Equivalent(expected.Stats, frame.Header.Stats);

        if (frame.Version == 1)
        {
            FrameTile only = Assert.Single(frame.Tiles);
            Assert.True(frame.IsKey);
            Assert.Equal(Convert.FromHexString(c.GetProperty("payload").GetString()!), bytes[only.Offset..(only.Offset + only.Length)]);
            return;
        }

        JsonElement[] tiles = c.GetProperty("tiles").EnumerateArray().ToArray();
        Assert.Equal(tiles.Length, frame.Tiles.Length);
        Assert.Equal(expected.Key == true, frame.IsKey);
        for (int i = 0; i < tiles.Length; i++)
        {
            FrameTile t = frame.Tiles[i];
            Assert.Equal(
                new[] { tiles[i].GetProperty("x").GetInt32(), tiles[i].GetProperty("y").GetInt32(), tiles[i].GetProperty("w").GetInt32(), tiles[i].GetProperty("h").GetInt32() },
                new[] { t.X, t.Y, t.W, t.H });
            Assert.Equal(Convert.FromHexString(tiles[i].GetProperty("data").GetString()!), bytes[t.Offset..(t.Offset + t.Length)]);
        }
    }

    [Theory]
    [MemberData(nameof(RejectNames))]
    public void Parser_rejects_malformed_frames(string name)
    {
        JsonElement c = Case(name);
        byte[] bytes = Convert.FromHexString(c.GetProperty("bytes").GetString()!);

        Assert.False(FrameCodec.TryParse(bytes.AsSpan(), out ParsedFrame? frame), c.GetProperty("reason").GetString());
        Assert.Null(frame);
        Assert.False(FrameCodec.TryParse(bytes.AsMemory(), out _));
    }

    private static TileInput[] ReadTiles(JsonElement c) =>
        c.GetProperty("tiles").EnumerateArray()
            .Select(t => new TileInput(
                t.GetProperty("x").GetInt32(),
                t.GetProperty("y").GetInt32(),
                t.GetProperty("w").GetInt32(),
                t.GetProperty("h").GetInt32(),
                Convert.FromHexString(t.GetProperty("data").GetString()!)))
            .ToArray();
}
