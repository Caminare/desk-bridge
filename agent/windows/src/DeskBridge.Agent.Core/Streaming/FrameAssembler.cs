using System.Buffers;
using DeskBridge.Agent.Core.Protocol;

namespace DeskBridge.Agent.Core.Streaming;

/// <summary>
/// A frame whose tiles are already JPEG-encoded, waiting for the sender. Header fields that are only known
/// at send time (seq, timestamp, stats) are added by <see cref="FrameAssembler.Write"/>. Instances are pooled:
/// call <see cref="Release"/> when the frame is sent or discarded.
/// </summary>
public sealed class EncodedFrame
{
    internal readonly record struct TileSlot(int X, int Y, int W, int H, int Offset, int Length);

    private readonly FrameAssembler _owner;
    internal readonly ArrayBufferWriter<byte> Data = new(64 * 1024);
    internal readonly List<TileSlot> Tiles = new();
    internal TileInput[] Inputs = new TileInput[8];
    private bool _released;

    internal EncodedFrame(FrameAssembler owner) => _owner = owner;

    public int Width { get; internal set; }
    public int Height { get; internal set; }
    public bool Key { get; internal set; }
    public int Quality { get; internal set; }
    /// <summary>JPEG encode time for this frame, ms.</summary>
    public double EncodeMs { get; internal set; }
    public int TileCount => Tiles.Count;
    public int PayloadBytes => Data.WrittenCount;

    // Set by whoever produced the frame (the capture loop).
    public KeyframeReason KeyReason { get; set; }
    /// <summary>Request counter observed when this frame was captured, for <see cref="KeyframePolicy.MarkSatisfied"/>.</summary>
    public int KeyToken { get; set; }
    public int ChangedTiles { get; set; }
    public int TotalTiles { get; set; }
    public double CaptureMs { get; set; }
    public double DiffMs { get; set; }
    /// <summary>Diff reference generation the frame was computed against (<see cref="DiffResult.Generation"/>).</summary>
    public int Generation { get; set; }
    /// <summary>Pixels that become the diff reference when the frame is taken by the sender.</summary>
    public PixelSnapshot? Snapshot { get; set; }
    /// <summary>Monotonic id of the capture that produced the frame (dirty-rect bookkeeping).</summary>
    public long CaptureId { get; set; }

    /// <summary>Returns the frame (and its snapshot, unless it became the reference) for reuse. Idempotent.</summary>
    public void Release()
    {
        if (_released) return;
        _released = true;
        Snapshot?.Release();
        Snapshot = null;
        _owner.Return(this);
    }

    internal void Reset()
    {
        _released = false;
        Data.ResetWrittenCount();
        Tiles.Clear();
        Width = Height = Quality = 0;
        Key = false;
        EncodeMs = 0;
        KeyReason = KeyframeReason.None;
        KeyToken = ChangedTiles = TotalTiles = Generation = 0;
        CaptureMs = DiffMs = 0;
        CaptureId = 0;
        Snapshot = null;
    }
}

/// <summary>JPEG-encodes regions into an <see cref="EncodedFrame"/> and serialises it as a v2 frame, reusing buffers.</summary>
public sealed class FrameAssembler
{
    private readonly TimeProvider _time;
    private readonly Stack<EncodedFrame> _pool = new();

    public FrameAssembler(TimeProvider? time = null) => _time = time ?? TimeProvider.System;

    /// <summary>
    /// Encodes <paramref name="regions"/> of <paramref name="image"/>; a keyframe ignores them and encodes the
    /// whole image as one tile. Records the encode time.
    /// </summary>
    public EncodedFrame Encode(in FrameImage image, IReadOnlyList<PixelRect> regions, bool key, ITileEncoder encoder, int quality,
        ChromaSubsampling subsampling = ChromaSubsampling.S420)
    {
        EncodedFrame f = Rent();
        f.Width = image.Width;
        f.Height = image.Height;
        f.Key = key;
        f.Quality = quality;
        long t0 = _time.GetTimestamp();
        try
        {
            if (key)
            {
                EncodeOne(f, image, new PixelRect(0, 0, image.Width, image.Height), encoder, quality, subsampling);
            }
            else
            {
                foreach (PixelRect r in regions) EncodeOne(f, image, r, encoder, quality, subsampling);
            }
        }
        catch
        {
            f.Release();
            throw;
        }
        f.EncodeMs = _time.GetElapsedTime(t0).TotalMilliseconds;
        return f;
    }

    private static void EncodeOne(EncodedFrame f, in FrameImage image, PixelRect r, ITileEncoder encoder, int quality, ChromaSubsampling sub)
    {
        int offset = f.Data.WrittenCount;
        int len = encoder.Encode(image, r, quality, sub, f.Data);
        f.Tiles.Add(new EncodedFrame.TileSlot(r.X, r.Y, r.Width, r.Height, offset, len));
    }

    /// <summary>Writes the frame as a v2 wire frame. Timestamp is Unix ms. The frame stays valid; release it afterwards.</summary>
    public void Write(EncodedFrame frame, long seq, long timestampMs, AgentFrameStats? stats, IBufferWriter<byte> output,
        string? hostId = null, string? activeWindow = null)
    {
        int n = frame.Tiles.Count;
        if (frame.Inputs.Length < n) frame.Inputs = new TileInput[Math.Max(n, frame.Inputs.Length * 2)];
        ReadOnlyMemory<byte> data = frame.Data.WrittenMemory;
        for (int i = 0; i < n; i++)
        {
            EncodedFrame.TileSlot t = frame.Tiles[i];
            frame.Inputs[i] = new TileInput(t.X, t.Y, t.W, t.H, data.Slice(t.Offset, t.Length));
        }
        var header = new FrameHeader
        {
            HostId = hostId,
            Seq = seq,
            ActiveWindow = activeWindow,
            Timestamp = timestampMs,
            W = frame.Width,
            H = frame.Height,
            Key = frame.Key,
            Stats = stats,
        };
        FrameCodec.EncodeV2(output, header, frame.Inputs.AsSpan(0, n));
    }

    private EncodedFrame Rent()
    {
        lock (_pool)
        {
            if (_pool.Count > 0)
            {
                EncodedFrame f = _pool.Pop();
                f.Reset();
                return f;
            }
        }
        return new EncodedFrame(this);
    }

    internal void Return(EncodedFrame f)
    {
        lock (_pool)
        {
            if (_pool.Count < 4) _pool.Push(f);
        }
    }
}
