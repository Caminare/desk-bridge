using System.Diagnostics;
using DeskBridge.Agent.Core.Streaming;
using Xunit;
using Xunit.Abstractions;

namespace DeskBridge.Agent.Core.Tests.Streaming;

internal static class TestImages
{
    /// <summary>Solid BGRA image, optionally with row padding.</summary>
    public static (FrameImage Image, byte[] Buffer) Solid(int w, int h, byte value = 10, int padding = 0)
    {
        int stride = w * 4 + padding;
        byte[] buf = new byte[stride * h];
        Array.Fill(buf, value);
        return (new FrameImage(buf, w, h, stride), buf);
    }

    public static void SetPixel(byte[] buf, int stride, int x, int y, byte b, byte g = 0, byte r = 0)
    {
        int o = y * stride + x * 4;
        buf[o] = b; buf[o + 1] = g; buf[o + 2] = r;
    }
}

public class TileDifferTests
{
    private readonly ITestOutputHelper _out;
    public TileDifferTests(ITestOutputHelper output) => _out = output;

    private static TileDiffer Primed(out byte[] buf, int w, int h, int padding = 0)
    {
        var differ = new TileDiffer();
        var (img, b) = TestImages.Solid(w, h, 10, padding);
        buf = b;
        DiffResult first = differ.Diff(img);
        Assert.True(differ.Commit(first.Snapshot!));
        return differ;
    }

    [Fact]
    public void First_frame_has_no_reference_and_every_tile_changed()
    {
        var differ = new TileDiffer();
        var (img, _) = TestImages.Solid(130, 70);
        DiffResult r = differ.Diff(img);
        Assert.False(r.HasReference);
        Assert.Equal(3, r.TilesX);
        Assert.Equal(2, r.TilesY);
        Assert.Equal(6, r.ChangedCount);
        Assert.NotNull(r.Snapshot);
    }

    [Fact]
    public void Identical_frame_reports_nothing_changed_and_keeps_no_snapshot()
    {
        var differ = Primed(out _, 200, 130);
        var (img, _) = TestImages.Solid(200, 130);
        DiffResult r = differ.Diff(img);
        Assert.True(r.HasReference);
        Assert.Equal(0, r.ChangedCount);
        Assert.Null(r.Snapshot);
    }

    [Fact]
    public void One_changed_pixel_marks_only_its_tile_including_partial_edge_tiles()
    {
        var differ = Primed(out _, 130, 70);
        var (img, buf) = TestImages.Solid(130, 70);
        TestImages.SetPixel(buf, img.Stride, 129, 69, 99); // last tile (2,1)
        DiffResult r = differ.Diff(img);
        Assert.Equal(1, r.ChangedCount);
        Assert.True(r.Changed[1 * 3 + 2]);
    }

    [Fact]
    public void Diff_respects_row_stride_padding()
    {
        var differ = Primed(out _, 100, 64, padding: 0);
        var (img, buf) = TestImages.Solid(100, 64, 10, padding: 24);
        buf.AsSpan(100 * 4, 24).Fill(0xEE); // padding garbage must not count
        Assert.Equal(0, differ.Diff(img).ChangedCount);
        TestImages.SetPixel(buf, img.Stride, 64, 0, 77);
        DiffResult r = differ.Diff(img);
        Assert.Equal(1, r.ChangedCount);
        Assert.True(r.Changed[1]);
    }

    [Fact]
    public void Alpha_is_ignored()
    {
        var differ = Primed(out _, 64, 64);
        var (img, buf) = TestImages.Solid(64, 64);
        for (int i = 3; i < buf.Length; i += 4) buf[i] = 0xFF;
        Assert.Equal(0, differ.Diff(img).ChangedCount);
        buf[0] = 11;
        Assert.Equal(1, differ.Diff(img).ChangedCount);
    }

    [Fact]
    public void Dirty_hint_limits_which_tiles_are_compared()
    {
        var differ = Primed(out _, 192, 64);
        var (img, buf) = TestImages.Solid(192, 64);
        TestImages.SetPixel(buf, img.Stride, 0, 0, 50);   // tile 0
        TestImages.SetPixel(buf, img.Stride, 130, 5, 50); // tile 2

        DiffResult onlyTile2 = differ.Diff(img, [new PixelRect(128, 0, 10, 10)]);
        Assert.Equal(1, onlyTile2.ChangedCount);
        Assert.True(onlyTile2.Changed[2]);

        Assert.Equal(0, differ.Diff(img, [new PixelRect(64, 0, 30, 30)]).ChangedCount);
        Assert.Equal(0, differ.Diff(img, []).ChangedCount);
        Assert.Equal(2, differ.Diff(img, [new PixelRect(-50, -50, 5000, 5000)]).ChangedCount);
    }

    [Fact]
    public void Size_change_invalidates_the_reference()
    {
        var differ = Primed(out _, 128, 64);
        var (img, _) = TestImages.Solid(128, 128);
        DiffResult r = differ.Diff(img);
        Assert.False(r.HasReference);
        Assert.Equal(r.TotalTiles, r.ChangedCount);
    }

    [Fact]
    public void Commit_bumps_generation_and_rejects_snapshots_diffed_against_an_outdated_reference()
    {
        var differ = Primed(out _, 64, 64);
        int gen = differ.Generation;
        var (a, abuf) = TestImages.Solid(64, 64);
        TestImages.SetPixel(abuf, a.Stride, 0, 0, 1);
        var (b, bbuf) = TestImages.Solid(64, 64);
        TestImages.SetPixel(bbuf, b.Stride, 0, 0, 2);

        PixelSnapshot sa = differ.Diff(a).Snapshot!;
        PixelSnapshot sb = differ.Diff(b).Snapshot!;
        Assert.Equal(gen, sa.Generation);
        Assert.True(differ.Commit(sa));
        Assert.Equal(gen + 1, differ.Generation);
        Assert.False(differ.Commit(sb));
        Assert.Equal(gen + 1, differ.Generation);
        sb.Release();

        // The committed frame is now the reference.
        Assert.Equal(0, differ.Diff(a).ChangedCount);
        Assert.Equal(1, differ.Diff(b).ChangedCount);
    }

    [Fact]
    public void Compare_false_snapshots_without_comparing()
    {
        var differ = Primed(out _, 64, 64);
        var (img, _) = TestImages.Solid(64, 64);
        DiffResult r = differ.Diff(img, compare: false);
        Assert.Equal(1, r.ChangedCount);
        Assert.NotNull(r.Snapshot);
    }

    [Fact]
    public void Invalidate_drops_the_reference_and_makes_in_flight_diffs_stale()
    {
        var differ = Primed(out _, 64, 64);
        var (img, buf) = TestImages.Solid(64, 64);
        buf[0] = 99;
        PixelSnapshot s = differ.Diff(img).Snapshot!;
        differ.Invalidate();
        Assert.False(differ.HasReference);
        Assert.False(differ.Commit(s));
        Assert.False(differ.Diff(img).HasReference);
    }

    [Fact]
    public void Full_hd_unchanged_diff_timing()
    {
        var differ = Primed(out _, 1920, 1080);
        var (img, _) = TestImages.Solid(1920, 1080);
        for (int i = 0; i < 20; i++) differ.Diff(img); // warm up
        const int n = 200;
        var sw = Stopwatch.StartNew();
        for (int i = 0; i < n; i++) differ.Diff(img);
        double ms = sw.Elapsed.TotalMilliseconds / n;
        _out.WriteLine($"1920x1080 unchanged diff: {ms:F3} ms/frame");
        Assert.True(ms < 50, $"diff too slow: {ms} ms");
    }
}
