using System.Buffers;
using System.Diagnostics.CodeAnalysis;
using System.Text.Json;

namespace DeskBridge.Agent.Core.Protocol;

/// <summary>
/// DeskBridge binary frame format, ported from src/lib/frameProtocol.ts (the two must stay byte compatible;
/// tests/fixtures/frames holds golden vectors both sides verify).
/// <code>
/// byte 0     0x44 ('D')
/// byte 1     version: 0x01 = full JPEG frame, 0x02 = tiled frame
/// bytes 2-3  big-endian uint16 header length N
/// bytes 4..  N bytes of UTF-8 JSON header
/// rest       payload
/// </code>
/// </summary>
public static class FrameCodec
{
    public const byte Magic = 0x44;
    public const byte V1 = 0x01;
    public const byte V2 = 0x02;

    private const int MaxHeaderLength = 0xFFFF;
    private const int MaxFrameDimension = 16384;

    [ThreadStatic]
    private static ArrayBufferWriter<byte>? s_headerScratch;

    // ---- Encoding -----------------------------------------------------------------------------

    /// <summary>
    /// Encodes a v2 frame into <paramref name="output"/>. The header's <c>r</c> is computed from the tiles
    /// and written last (like <c>{...header, r}</c> in TypeScript); a value set in <see cref="FrameHeader.R"/>
    /// is ignored.
    /// </summary>
    /// <exception cref="InvalidOperationException">The JSON header exceeds 65535 bytes.</exception>
    public static void EncodeV2(IBufferWriter<byte> output, FrameHeader header, ReadOnlySpan<TileInput> tiles)
    {
        ArrayBufferWriter<byte> head = WriteHeader(header, tiles, includeComputedR: true);
        long payload = 0;
        foreach (TileInput t in tiles) payload += t.Data.Length;
        Span<byte> dst = BeginFrame(output, V2, head, payload);
        int p = 4 + head.WrittenCount;
        foreach (TileInput t in tiles)
        {
            t.Data.Span.CopyTo(dst[p..]);
            p += t.Data.Length;
        }
        output.Advance(p);
    }

    /// <summary>Encodes a v2 frame into a new array.</summary>
    public static byte[] EncodeV2(FrameHeader header, ReadOnlySpan<TileInput> tiles)
    {
        ArrayBufferWriter<byte> head = WriteHeader(header, tiles, includeComputedR: true);
        long payload = 0;
        foreach (TileInput t in tiles) payload += t.Data.Length;
        byte[] result = new byte[4 + head.WrittenCount + payload];
        FillPrefix(result, V2, head);
        int p = 4 + head.WrittenCount;
        foreach (TileInput t in tiles)
        {
            t.Data.Span.CopyTo(result.AsSpan(p));
            p += t.Data.Length;
        }
        return result;
    }

    /// <summary>Encodes a v1 frame (one full-frame JPEG) into <paramref name="output"/>. A set <see cref="FrameHeader.R"/> is written as is.</summary>
    /// <exception cref="InvalidOperationException">The JSON header exceeds 65535 bytes.</exception>
    public static void EncodeV1(IBufferWriter<byte> output, FrameHeader header, ReadOnlySpan<byte> jpeg)
    {
        ArrayBufferWriter<byte> head = WriteHeader(header, default, includeComputedR: false);
        Span<byte> dst = BeginFrame(output, V1, head, jpeg.Length);
        jpeg.CopyTo(dst[(4 + head.WrittenCount)..]);
        output.Advance(4 + head.WrittenCount + jpeg.Length);
    }

    /// <summary>Encodes a v1 frame into a new array.</summary>
    public static byte[] EncodeV1(FrameHeader header, ReadOnlySpan<byte> jpeg)
    {
        ArrayBufferWriter<byte> head = WriteHeader(header, default, includeComputedR: false);
        byte[] result = new byte[4 + head.WrittenCount + jpeg.Length];
        FillPrefix(result, V1, head);
        jpeg.CopyTo(result.AsSpan(4 + head.WrittenCount));
        return result;
    }

    private static Span<byte> BeginFrame(IBufferWriter<byte> output, byte version, ArrayBufferWriter<byte> head, long payload)
    {
        long total = 4 + head.WrittenCount + payload;
        if (total > int.MaxValue) throw new InvalidOperationException("frame too large");
        Span<byte> dst = output.GetSpan((int)total);
        FillPrefix(dst, version, head);
        return dst;
    }

    private static void FillPrefix(Span<byte> dst, byte version, ArrayBufferWriter<byte> head)
    {
        int n = head.WrittenCount;
        dst[0] = Magic;
        dst[1] = version;
        dst[2] = (byte)(n >> 8);
        dst[3] = (byte)n;
        head.WrittenSpan.CopyTo(dst[4..]);
    }

    private static ArrayBufferWriter<byte> WriteHeader(FrameHeader header, ReadOnlySpan<TileInput> tiles, bool includeComputedR)
    {
        ArrayBufferWriter<byte> buf = s_headerScratch ??= new ArrayBufferWriter<byte>(512);
        buf.ResetWrittenCount();
        var j = new JsJson(buf);
        j.BeginObject();
        j.Str("hostId"u8, header.HostId);
        j.Num("seq"u8, header.Seq);
        j.Str("activeWindow"u8, header.ActiveWindow);
        j.Num("timestamp"u8, header.Timestamp);
        j.Num("w"u8, header.W);
        j.Num("h"u8, header.H);
        j.Bool("key"u8, header.Key);
        if (!includeComputedR && header.R is { } r)
        {
            j.BeginArray("r"u8);
            foreach (double d in r) j.ArrayNumber(d);
            j.EndArray();
        }
        if (header.Stats is { } s) WriteStats(ref j, s);
        if (includeComputedR)
        {
            j.BeginArray("r"u8);
            foreach (TileInput t in tiles)
            {
                j.ArrayInt(t.X);
                j.ArrayInt(t.Y);
                j.ArrayInt(t.W);
                j.ArrayInt(t.H);
                j.ArrayInt(t.Data.Length);
            }
            j.EndArray();
        }
        j.EndObject();
        if (buf.WrittenCount > MaxHeaderLength) throw new InvalidOperationException("frame header too large");
        return buf;
    }

    private static void WriteStats(ref JsJson j, AgentFrameStats s)
    {
        j.BeginNested("stats"u8);
        j.Num("cap"u8, s.Cap);
        j.Num("enc"u8, s.Enc);
        j.Num("rtt"u8, s.Rtt);
        j.Num("kbps"u8, s.Kbps);
        j.Num("q"u8, s.Q);
        j.Num("mw"u8, s.Mw);
        j.Num("ch"u8, s.Ch);
        j.Num("tt"u8, s.Tt);
        j.Num("inf"u8, s.Inf);
        j.Num("brtt"u8, s.Brtt);
        j.Num("win"u8, s.Win);
        j.Str("cm"u8, s.Cm);
        j.Num("sfps"u8, s.Sfps);
        j.Str("sm"u8, s.Sm);
        j.Num("caps"u8, s.Caps);
        j.Num("capc"u8, s.Capc);
        j.Num("dif"u8, s.Dif);
        j.Num("tick"u8, s.Tick);
        j.Num("cfps"u8, s.Cfps);
        j.Num("pfps"u8, s.Pfps);
        j.Num("same"u8, s.Same);
        j.Num("drop"u8, s.Drop);
        j.Num("rd"u8, s.Rd);
        j.Num("kf"u8, s.Kf);
        j.Str("kr"u8, s.Kr);
        j.Num("age"u8, s.Age);
        j.Num("snd"u8, s.Snd);
        j.Num("lps"u8, s.Lps);
        j.Num("kreq"u8, s.Kreq);
        j.EndNested();
    }

    // ---- Parsing ------------------------------------------------------------------------------

    /// <summary>Parses a frame from memory; see <see cref="TryParse(ReadOnlySpan{byte}, out ParsedFrame?)"/>.</summary>
    public static bool TryParse(ReadOnlyMemory<byte> message, [NotNullWhen(true)] out ParsedFrame? frame)
        => TryParse(message.Span, out frame);

    /// <summary>
    /// Parses a frame with the same rules as <c>parseFrame</c> in TypeScript. Returns false for anything
    /// malformed (bad magic or version, header past the buffer, bad JSON, invalid v2 size or tiles,
    /// trailing bytes, keyframe without tiles, v1 without payload).
    /// Deliberate differences: the header is deserialized into typed fields, so a field of the wrong JSON
    /// type (for example <c>"w":"64"</c>, which JS coerces with Number()) is rejected, as is a header that is
    /// not a JSON object.
    /// </summary>
    public static bool TryParse(ReadOnlySpan<byte> buf, [NotNullWhen(true)] out ParsedFrame? frame)
    {
        frame = null;
        if (buf.Length < 5 || buf[0] != Magic) return false;
        byte version = buf[1];
        if (version != V1 && version != V2) return false;
        int headerLen = (buf[2] << 8) | buf[3];
        int payloadOffset = 4 + headerLen;
        if (buf.Length < payloadOffset) return false;

        FrameHeader? header;
        try
        {
            header = JsonSerializer.Deserialize(buf[4..payloadOffset], FrameJsonContext.Default.FrameHeader);
        }
        catch (JsonException)
        {
            return false;
        }
        if (header is null) return false;

        if (version == V1)
        {
            if (buf.Length <= payloadOffset) return false;
            frame = new ParsedFrame
            {
                Version = 1,
                Header = header,
                PayloadOffset = payloadOffset,
                IsKey = true,
                Tiles = [new FrameTile(0, 0, 0, 0, payloadOffset, buf.Length - payloadOffset)],
            };
            return true;
        }

        if (header.W is not { } w || header.H is not { } h) return false;
        if (!IsInteger(w) || !IsInteger(h) || w <= 0 || h <= 0 || w > MaxFrameDimension || h > MaxFrameDimension) return false;
        if (header.R is not { } r || r.Length % 5 != 0) return false;

        var tiles = new FrameTile[r.Length / 5];
        int offset = payloadOffset;
        for (int i = 0, t = 0; i < r.Length; i += 5, t++)
        {
            double tx = r[i], ty = r[i + 1], tw = r[i + 2], th = r[i + 3], len = r[i + 4];
            if (!IsInteger(tx) || !IsInteger(ty) || !IsInteger(tw) || !IsInteger(th) || !IsInteger(len)) return false;
            if (tx < 0 || ty < 0 || tw <= 0 || th <= 0 || tx + tw > w || ty + th > h || len <= 0) return false;
            if (len > buf.Length - offset) return false;
            tiles[t] = new FrameTile((int)tx, (int)ty, (int)tw, (int)th, offset, (int)len);
            offset += (int)len;
        }
        if (offset != buf.Length) return false;
        bool isKey = header.Key == true;
        if (isKey && tiles.Length == 0) return false;

        frame = new ParsedFrame { Version = 2, Header = header, PayloadOffset = payloadOffset, IsKey = isKey, Tiles = tiles };
        return true;
    }

    private static bool IsInteger(double d) => double.IsFinite(d) && Math.Floor(d) == d;
}
