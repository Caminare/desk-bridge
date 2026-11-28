using System.Buffers;
using DeskBridge.Agent.Core.Protocol;
using DeskBridge.Agent.Core.Streaming;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Streaming;

internal sealed class FakeEncoder : ITileEncoder
{
    public List<PixelRect> Rects { get; } = new();
    public int Quality;
    public void Dispose() { }
    public int Encode(in FrameImage image, PixelRect rect, int quality, ChromaSubsampling subsampling, IBufferWriter<byte> output)
    {
        Rects.Add(rect);
        Quality = quality;
        int len = 4 + Rects.Count;
        Span<byte> s = output.GetSpan(len);
        s[0] = 0xFF; s[1] = 0xD8;
        s[2] = 0xFF; s[3] = 0xD9;
        for (int i = 4; i < len; i++) s[i] = (byte)Rects.Count;
        output.Advance(len);
        return len;
    }
}

internal sealed class StepClock : TimeProvider
{
    private long _ticks;
    public override long TimestampFrequency => 1000;
    public override long GetTimestamp() => _ticks++ * 5; // every read advances 5 ms
}

public class FrameAssemblerTests
{
    [Fact]
    public void Delta_frame_round_trips_through_the_codec()
    {
        var asm = new FrameAssembler(new StepClock());
        var enc = new FakeEncoder();
        var (img, _) = TestImages.Solid(192, 128);
        EncodedFrame f = asm.Encode(img, [new PixelRect(0, 0, 64, 64), new PixelRect(64, 64, 128, 64)], key: false, enc, quality: 55);
        Assert.Equal(2, f.TileCount);
        Assert.Equal(5, f.EncodeMs);

        var stats = new AgentFrameStats { Q = 55, Cm = "dxgi" };
        var buf = new ArrayBufferWriter<byte>();
        asm.Write(f, seq: 7, timestampMs: 1234, stats, buf, hostId: "h1", activeWindow: "w");

        Assert.True(FrameCodec.TryParse(buf.WrittenSpan, out ParsedFrame? p));
        Assert.Equal(2, p!.Version);
        Assert.False(p.IsKey);
        Assert.Equal(192, p.Header.W);
        Assert.Equal(128, p.Header.H);
        Assert.Equal(7, p.Header.Seq);
        Assert.Equal(1234, p.Header.Timestamp);
        Assert.Equal("h1", p.Header.HostId);
        Assert.Equal("dxgi", p.Header.Stats!.Cm);
        Assert.Equal(2, p.Tiles.Length);
        Assert.Equal(new FrameTile(64, 64, 128, 64, p.Tiles[1].Offset, 6), p.Tiles[1]);
        Assert.Equal(55, enc.Quality);
    }

    [Fact]
    public void Keyframe_encodes_the_whole_image_as_one_tile_ignoring_regions()
    {
        var asm = new FrameAssembler();
        var enc = new FakeEncoder();
        var (img, _) = TestImages.Solid(100, 80);
        EncodedFrame f = asm.Encode(img, [new PixelRect(0, 0, 64, 64)], key: true, enc, 70);
        Assert.Single(enc.Rects);
        Assert.Equal(new PixelRect(0, 0, 100, 80), enc.Rects[0]);
        var buf = new ArrayBufferWriter<byte>();
        asm.Write(f, 1, 1, null, buf);
        Assert.True(FrameCodec.TryParse(buf.WrittenSpan, out ParsedFrame? p));
        Assert.True(p!.IsKey);
    }

    [Fact]
    public void Released_frames_are_reused_and_clean()
    {
        var asm = new FrameAssembler();
        var enc = new FakeEncoder();
        var (img, _) = TestImages.Solid(64, 64);
        EncodedFrame a = asm.Encode(img, [new PixelRect(0, 0, 64, 64)], false, enc, 50);
        a.ChangedTiles = 9;
        a.Release();
        a.Release(); // idempotent
        EncodedFrame b = asm.Encode(img, [new PixelRect(0, 0, 64, 64)], false, enc, 50);
        Assert.Same(a, b);
        Assert.Equal(1, b.TileCount);
        Assert.Equal(0, b.ChangedTiles);
    }
}

public class FrameMailboxTests
{
    private static (TileDiffer Differ, FrameMailbox Box, FrameAssembler Asm, FakeEncoder Enc) Setup()
    {
        var d = new TileDiffer();
        return (d, new FrameMailbox(d), new FrameAssembler(), new FakeEncoder());
    }

    private static EncodedFrame MakeFrame(TileDiffer d, FrameAssembler asm, FakeEncoder enc, byte px, bool key = false)
    {
        var (img, buf) = TestImages.Solid(64, 64, px);
        DiffResult r = d.Diff(img);
        EncodedFrame f = asm.Encode(img, [new PixelRect(0, 0, 64, 64)], key, enc, 50);
        f.Generation = r.Generation;
        f.Snapshot = r.Snapshot;
        return f;
    }

    [Fact]
    public void Take_returns_the_frame_with_its_age_and_commits_the_reference()
    {
        var (d, box, asm, enc) = Setup();
        EncodedFrame f = MakeFrame(d, asm, enc, 10, key: true);
        Assert.True(box.Post(f, nowMs: 100, out EncodedFrame? replaced));
        Assert.Null(replaced);
        int gen = d.Generation;

        Assert.True(box.TryTake(nowMs: 135, out EncodedFrame? taken, out double age));
        Assert.Same(f, taken);
        Assert.Equal(35, age);
        Assert.Equal(gen + 1, d.Generation);
        Assert.True(d.HasReference);
        Assert.False(box.TryTake(200, out _, out _));
    }

    [Fact]
    public void Newer_frame_replaces_an_unsent_one_and_counts_the_drop()
    {
        var (d, box, asm, enc) = Setup();
        EncodedFrame a = MakeFrame(d, asm, enc, 10, key: true);
        EncodedFrame b = MakeFrame(d, asm, enc, 11, key: true);
        Assert.True(box.Post(a, 0, out _));
        Assert.True(box.Post(b, 5, out EncodedFrame? replaced));
        Assert.Same(a, replaced);
        Assert.Equal(1, box.Dropped);
        replaced!.Release();
        Assert.True(box.TryTake(10, out EncodedFrame? taken, out double age));
        Assert.Same(b, taken);
        Assert.Equal(5, age);
    }

    [Fact]
    public void Reports_the_payload_size_of_the_pending_frame_for_the_send_window()
    {
        var (d, box, asm, enc) = Setup();
        Assert.Equal(0, box.PendingBytes);
        EncodedFrame f = MakeFrame(d, asm, enc, 10, key: true);
        Assert.True(box.Post(f, 0, out _));
        Assert.True(f.PayloadBytes > 0);
        Assert.Equal(f.PayloadBytes, box.PendingBytes);
        Assert.True(box.TryTake(1, out _, out _));
        Assert.Equal(0, box.PendingBytes);
    }

    [Fact]
    public void Post_is_rejected_when_the_reference_moved_on()
    {
        var (d, box, asm, enc) = Setup();
        EncodedFrame stale = MakeFrame(d, asm, enc, 10, key: true);
        EncodedFrame other = MakeFrame(d, asm, enc, 11, key: true);
        Assert.True(box.Post(other, 0, out _));
        Assert.True(box.TryTake(1, out _, out _)); // generation moves on
        Assert.False(box.Post(stale, 2, out EncodedFrame? replaced));
        Assert.Null(replaced);
        Assert.False(box.HasPending);
        stale.Release();
    }

    [Fact]
    public void Frame_made_stale_while_waiting_is_dropped_on_take()
    {
        var (d, box, asm, enc) = Setup();
        EncodedFrame f = MakeFrame(d, asm, enc, 10, key: true);
        Assert.True(box.Post(f, 0, out _));
        d.Invalidate();
        Assert.False(box.TryTake(5, out EncodedFrame? taken, out _));
        Assert.Null(taken);
    }

    [Fact]
    public void Pending_delta_can_be_discarded_but_a_keyframe_is_kept()
    {
        var (d, box, asm, enc) = Setup();
        EncodedFrame k = MakeFrame(d, asm, enc, 10, key: true);
        Assert.True(box.Post(k, 0, out _));
        Assert.Null(box.DiscardPendingDelta(k.Generation));
        Assert.True(box.HasPending);
        Assert.True(box.TryTake(1, out _, out _));

        EncodedFrame delta = MakeFrame(d, asm, enc, 12);
        Assert.True(box.Post(delta, 2, out _));
        Assert.Null(box.DiscardPendingDelta(delta.Generation + 5));
        Assert.Same(delta, box.DiscardPendingDelta(delta.Generation));
        Assert.False(box.HasPending);
    }
}

public class StatsCollectorTests
{
    [Fact]
    public void Rates_are_per_second_and_reset_each_window()
    {
        var s = new StatsCollector();
        for (int i = 0; i < 20; i++) s.RecordCapture();
        for (int i = 0; i < 10; i++) s.RecordProduced();
        s.RecordUnchanged(); s.RecordDropped(); s.RecordKeyframe(); s.RecordKeyRequest();
        s.Update(500); // window not over
        s.Update(2000);

        var w = new SendWindow();
        var asm = new FrameAssembler();
        var (img, _) = TestImages.Solid(64, 64);
        EncodedFrame f = asm.Encode(img, [new PixelRect(0, 0, 64, 64)], true, new FakeEncoder(), 60);
        AgentFrameStats st = s.BuildFrameStats(f, w, "dxgi", 12.4, "big");
        Assert.Equal(10, st.Cfps);
        Assert.Equal(5, st.Pfps);
        Assert.Equal(0.5, st.Same);
        Assert.Equal(0.5, st.Drop);
        Assert.Equal(0.5, st.Kf);
        Assert.Equal(0.5, st.Kreq);
        Assert.Equal("dxgi", st.Cm);
        Assert.Equal("big", st.Kr);
        Assert.Equal(12, st.Age);
        Assert.Equal(60, st.Q);
        Assert.Equal(64, st.Mw);
        Assert.Null(st.Sm);
        Assert.Null(st.Caps);
        Assert.Null(st.Capc);
        Assert.Null(st.Rtt); // unmeasured
        Assert.Null(st.Snd);
        Assert.Equal(16, st.Win); // KB: a fresh window holds about one frame

        s.Update(3000);
        Assert.Equal(0, s.BuildFrameStats(f, w, "dxgi", 0, "").Cfps);
        Assert.Null(s.BuildFrameStats(f, w, "dxgi", 0, "").Kr);
    }

    [Fact]
    public void Kbps_is_smoothed_0_6_0_4()
    {
        var s = new StatsCollector();
        s.RecordSent(125_000); // 1000 kbit in 1 s
        s.Update(1000);
        Assert.Equal(1000, s.Kbps, 6);
        s.RecordSent(250_000);
        s.Update(2000);
        Assert.Equal(0.6 * 1000 + 0.4 * 2000, s.Kbps, 6);
    }

    [Fact]
    public void Tick_is_smoothed_and_rtt_reported_once_measured()
    {
        var s = new StatsCollector();
        s.RecordTick(10);
        s.RecordTick(20);
        var w = new SendWindow();
        w.OnSent(1, 100, 0);
        w.OnAck(1, false, 40);
        var asm = new FrameAssembler();
        var (img, _) = TestImages.Solid(64, 64);
        EncodedFrame f = asm.Encode(img, [new PixelRect(0, 0, 64, 64)], true, new FakeEncoder(), 60);
        s.RecordSendDuration(7.4);
        AgentFrameStats st = s.BuildFrameStats(f, w, "gdi", 0, "");
        Assert.Equal(12, st.Tick);
        Assert.Equal(40, st.Rtt);
        Assert.Equal(40, st.Brtt);
        Assert.Equal(7, st.Snd);
        Assert.Equal(0, st.Inf);
    }
}
