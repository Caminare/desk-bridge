using System.Buffers;
using System.Text;
using System.Text.Json;
using DeskBridge.Agent.Core.Protocol;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Protocol;

public class FrameCodecTests
{
    private static readonly byte[] Jpeg = [0xFF, 0xD8, 0xFF, 0xD9];

    /// <summary>The JSON header text of an encoded frame.</summary>
    private static string HeaderJson(byte[] frame)
    {
        int n = (frame[2] << 8) | frame[3];
        return Encoding.UTF8.GetString(frame, 4, n);
    }

    private static byte[] Frame(string json, byte[]? payload = null, byte version = 2)
    {
        byte[] h = Encoding.UTF8.GetBytes(json);
        payload ??= [];
        byte[] f = new byte[4 + h.Length + payload.Length];
        f[0] = 0x44;
        f[1] = version;
        f[2] = (byte)(h.Length >> 8);
        f[3] = (byte)h.Length;
        h.CopyTo(f, 4);
        payload.CopyTo(f, 4 + h.Length);
        return f;
    }

    [Fact]
    public void Constants_match_the_wire_format()
    {
        Assert.Equal(0x44, FrameCodec.Magic);
        Assert.Equal(0x01, FrameCodec.V1);
        Assert.Equal(0x02, FrameCodec.V2);
    }

    [Fact]
    public void V2_header_lists_fields_in_declaration_order_with_r_last()
    {
        var header = new FrameHeader
        {
            HostId = "h",
            Seq = 1,
            W = 64,
            H = 64,
            Key = true,
            Stats = new AgentFrameStats { Cap = 1, Cm = "fast" },
        };

        byte[] frame = FrameCodec.EncodeV2(header, [new TileInput(0, 0, 64, 64, Jpeg)]);

        Assert.Equal(
            """{"hostId":"h","seq":1,"w":64,"h":64,"key":true,"stats":{"cap":1,"cm":"fast"},"r":[0,0,64,64,4]}""",
            HeaderJson(frame));
        Assert.Equal(Jpeg, frame[^4..]);
    }

    [Fact]
    public void V2_ignores_a_preset_r_and_computes_it_from_the_tiles()
    {
        var header = new FrameHeader { W = 64, H = 64, R = [9, 9, 9, 9, 9] };

        byte[] frame = FrameCodec.EncodeV2(header, [new TileInput(1, 2, 3, 4, Jpeg)]);

        Assert.Equal("""{"w":64,"h":64,"r":[1,2,3,4,4]}""", HeaderJson(frame));
    }

    [Fact]
    public void V1_writes_only_the_header_fields_it_was_given()
    {
        byte[] frame = FrameCodec.EncodeV1(new FrameHeader { HostId = "a" }, Jpeg);

        Assert.Equal(new byte[] { 0x44, 0x01, 0x00, 0x0E }, frame[..4]);
        Assert.Equal("""{"hostId":"a"}""", HeaderJson(frame));
        Assert.Equal(Jpeg, frame[^4..]);
    }

    [Fact]
    public void Header_larger_than_65535_bytes_is_rejected()
    {
        var header = new FrameHeader { ActiveWindow = new string('x', 0x10000) };

        Assert.Throws<InvalidOperationException>(() => FrameCodec.EncodeV1(header, Jpeg));
        Assert.Throws<InvalidOperationException>(() => FrameCodec.EncodeV2(header, []));
    }

    [Fact]
    public void Writing_into_a_buffer_writer_appends_after_existing_content()
    {
        var writer = new ArrayBufferWriter<byte>();
        new byte[] { 1, 2, 3 }.CopyTo(writer.GetSpan(3));
        writer.Advance(3);

        FrameCodec.EncodeV1(writer, new FrameHeader(), Jpeg);

        Assert.Equal(new byte[] { 1, 2, 3 }, writer.WrittenSpan[..3].ToArray());
        Assert.Equal(FrameCodec.EncodeV1(new FrameHeader(), Jpeg), writer.WrittenSpan[3..].ToArray());
    }

    // Values and expectations come from Node's JSON.stringify.
    [Theory]
    [InlineData(0.0, "0")]
    [InlineData(100.0, "100")]
    [InlineData(-0.5, "-0.5")]
    [InlineData(12.5, "12.5")]
    [InlineData(0.333, "0.333")]
    [InlineData(0.1, "0.1")]
    [InlineData(0.30000000000000004, "0.30000000000000004")]
    [InlineData(1234.5678, "1234.5678")]
    [InlineData(1e-6, "0.000001")]
    [InlineData(1e-7, "1e-7")]
    [InlineData(1.5e-10, "1.5e-10")]
    [InlineData(1e15, "1000000000000000")]
    [InlineData(999999999999999.9, "999999999999999.9")]
    [InlineData(1e20, "100000000000000000000")]
    [InlineData(123456789012345680000.0, "123456789012345680000")]
    [InlineData(1e21, "1e+21")]
    [InlineData(1.5e300, "1.5e+300")]
    [InlineData(5e-324, "5e-324")]
    [InlineData(double.MaxValue, "1.7976931348623157e+308")]
    [InlineData(double.NaN, "null")]
    [InlineData(double.PositiveInfinity, "null")]
    public void Numbers_are_formatted_like_JavaScript(double value, string expected)
    {
        byte[] frame = FrameCodec.EncodeV1(new FrameHeader { Seq = value }, Jpeg);

        Assert.Equal("{\"seq\":" + expected + "}", HeaderJson(frame));
    }

    [Fact]
    public void Negative_zero_is_written_as_zero()
    {
        byte[] frame = FrameCodec.EncodeV1(new FrameHeader { Seq = -0.0 }, Jpeg);

        Assert.Equal("{\"seq\":0}", HeaderJson(frame));
    }

    [Theory]
    [InlineData("plain", "\"plain\"")]
    [InlineData("quote\" backslash\\", "\"quote\\\" backslash\\\\\"")]
    [InlineData("\b\f\n\r\t", "\"\\b\\f\\n\\r\\t\"")]
    [InlineData("\u0001\u001f", "\"\\u0001\\u001f\"")]
    [InlineData("\u007f<>&'+\U00002028x", "\"\u007f<>&'+\U00002028x\"")]
    public void Strings_are_escaped_like_JavaScript(string value, string expectedJson)
    {
        byte[] frame = FrameCodec.EncodeV1(new FrameHeader { ActiveWindow = value }, Jpeg);

        Assert.Equal("{\"activeWindow\":" + expectedJson + "}", HeaderJson(frame));
    }

    [Fact]
    public void Lone_surrogates_are_written_as_lowercase_escapes()
    {
        // Not an InlineData case: xUnit cannot round-trip lone surrogates through its data serializer.
        byte[] frame = FrameCodec.EncodeV1(new FrameHeader { ActiveWindow = "a\ud83d|\ude00b" }, Jpeg);

        Assert.Equal("{\"activeWindow\":\"a\\ud83d|\\ude00b\"}", HeaderJson(frame));
    }

    [Fact]
    public void Non_ascii_text_is_written_as_raw_utf8_and_round_trips()
    {
        const string title = "Relatório – Configurações 😀";

        byte[] frame = FrameCodec.EncodeV1(new FrameHeader { ActiveWindow = title }, Jpeg);

        Assert.True(frame.AsSpan().IndexOf(Encoding.UTF8.GetBytes(title)) >= 0, "title bytes appear unescaped");
        using var doc = JsonDocument.Parse(HeaderJson(frame));
        Assert.Equal(title, doc.RootElement.GetProperty("activeWindow").GetString());
    }

    [Fact]
    public void Stats_property_names_match_the_source_generated_serializer()
    {
        var stats = new AgentFrameStats
        {
            Cap = 1, Enc = 2, Rtt = 3, Kbps = 4, Q = 5, Mw = 6, Ch = 7, Tt = 8, Inf = 9, Brtt = 10, Win = 11,
            Cm = "a", Sfps = 12, Sm = "b", Caps = 13, Capc = 14, Dif = 15, Tick = 16, Cfps = 17, Pfps = 18,
            Same = 19, Drop = 20, Rd = 21, Kf = 22, Kr = "c", Age = 23, Snd = 24, Lps = 25, Kreq = 26,
        };
        var header = new FrameHeader { HostId = "h", Seq = 1, ActiveWindow = "w", Timestamp = 2, W = 3, H = 4, Key = false, Stats = stats };

        byte[] frame = FrameCodec.EncodeV1(header, Jpeg);

        string viaSerializer = JsonSerializer.Serialize(header, FrameJsonContext.Default.FrameHeader);
        Assert.True(JsonElement.DeepEquals(JsonDocument.Parse(viaSerializer).RootElement, JsonDocument.Parse(HeaderJson(frame)).RootElement));
    }

    [Fact]
    public void Parser_returns_tile_offsets_into_the_message()
    {
        byte[] payload = [1, 2, 3, 4, 5];
        byte[] frame = Frame("""{"w":128,"h":64,"key":false,"r":[0,0,64,64,2,64,0,64,64,3]}""", payload);

        Assert.True(FrameCodec.TryParse(frame.AsMemory(), out ParsedFrame? parsed));

        Assert.Equal(frame.Length - 5, parsed.PayloadOffset);
        Assert.False(parsed.IsKey);
        Assert.Equal(new FrameTile(0, 0, 64, 64, parsed.PayloadOffset, 2), parsed.Tiles[0]);
        Assert.Equal(new FrameTile(64, 0, 64, 64, parsed.PayloadOffset + 2, 3), parsed.Tiles[1]);
    }

    [Fact]
    public void Parser_treats_v1_as_a_keyframe_with_one_unsized_tile()
    {
        byte[] frame = Frame("{}", Jpeg, version: 1);

        Assert.True(FrameCodec.TryParse(frame.AsSpan(), out ParsedFrame? parsed));

        Assert.True(parsed.IsKey);
        Assert.Equal(new FrameTile(0, 0, 0, 0, 6, 4), Assert.Single(parsed.Tiles));
    }

    [Fact]
    public void Parser_accepts_integral_numbers_written_with_a_decimal_point()
    {
        byte[] frame = Frame("""{"w":64.0,"h":64,"key":true,"r":[0,0,64.0,64,2]}""", [1, 2]);

        Assert.True(FrameCodec.TryParse(frame.AsSpan(), out ParsedFrame? parsed));
        Assert.True(parsed.IsKey);
    }

    [Theory]
    [InlineData("""{"w":64,"h":64,"r":[0,0,64,64,2]}""", false)]
    [InlineData("""{"w":16384,"h":16384,"r":[0,0,16384,16384,2]}""", false)]
    [InlineData("""{"w":16385,"h":64,"r":[0,0,64,64,2]}""", true)]
    [InlineData("""{"w":64,"h":64,"r":[0,0,64,65,2]}""", true)]
    [InlineData("""{"w":64,"h":64,"r":[0,0,64,64,1e400]}""", true)]
    [InlineData("""{"w":"64","h":64,"r":[0,0,64,64,2]}""", true)]
    [InlineData("""[1]""", true)]
    public void Parser_applies_the_v2_size_and_tile_rules(string headerJson, bool rejected)
    {
        byte[] frame = Frame(headerJson, [1, 2]);

        Assert.Equal(!rejected, FrameCodec.TryParse(frame.AsSpan(), out _));
    }

    [Fact]
    public void Parsed_frames_can_be_re_encoded_to_identical_bytes()
    {
        byte[] original = FrameCodec.EncodeV2(
            new FrameHeader { HostId = "h", Seq = 7, W = 128, H = 64, Key = false, Stats = new AgentFrameStats { Cap = 1.25 } },
            [new TileInput(0, 0, 64, 64, new byte[] { 1, 2 }), new TileInput(64, 0, 64, 64, new byte[] { 3 })]);

        Assert.True(FrameCodec.TryParse(original.AsSpan(), out ParsedFrame? parsed));
        TileInput[] tiles = parsed.Tiles
            .Select(t => new TileInput(t.X, t.Y, t.W, t.H, original.AsMemory(t.Offset, t.Length)))
            .ToArray();

        Assert.Equal(original, FrameCodec.EncodeV2(parsed.Header, tiles));
    }
}
