using DeskBridge.Agent.Core.Streaming;
using DeskBridge.Agent.Windows.Capture;
using Xunit;

namespace DeskBridge.Agent.Windows.Tests.Capture;

public class FrameSourceTests
{
    private static readonly TimeSpan Wait = TimeSpan.FromMilliseconds(500);

    private static void AssertFrame(CaptureResult r, int w, int h, IFrameSource? source = null)
    {
        Assert.True(r.Status == CaptureStatus.Frame, $"status {r.Status}; {(source as DxgiFrameSource)?.LastLostReason}");
        Assert.Equal(w, r.Image.Width);
        Assert.Equal(h, r.Image.Height);
        Assert.Equal(w * 4, r.Image.Stride);
        Assert.Equal(w * 4 * h, r.Image.Pixels.Length);
        Assert.True(r.CaptureMs >= 0);
    }

    [DesktopFact]
    public void Gdi_reports_the_system_cursor_with_a_converted_shape_when_it_is_showing()
    {
        using var source = new GdiFrameSource();
        AssertFrame(source.TryCapture(320, 180, TimeSpan.Zero, forceFrame: true), 320, 180);

        // CI runners and locked sessions may have no visible cursor; then there is nothing to read.
        if (!source.Cursor.Visible) return;
        Assert.NotNull(source.Cursor.Shape);
        var shape = source.Cursor.Shape!;
        Assert.InRange(shape.Width, 1, 128);
        Assert.Equal(shape.Width * shape.Height * 4, shape.Rgba.Length);
        Assert.Contains(Enumerable.Range(0, shape.Width * shape.Height), i => shape.Rgba[i * 4 + 3] != 0);
    }

    [DesktopFact]
    public void Gdi_keeps_the_cursor_out_of_frames_when_controllers_draw_it()
    {
        using var source = new GdiFrameSource { DrawCursor = false };
        Assert.False(source.DrawCursor);
        AssertFrame(source.TryCapture(320, 180, TimeSpan.Zero, forceFrame: true), 320, 180);
    }

    [DesktopFact(NeedsDxgi = true)]
    public void Dxgi_returns_a_frame_of_the_requested_size()
    {
        using var source = new DxgiFrameSource();

        Assert.Equal("dxgi", source.Method);
        Assert.True(source.SourceSize.Width > 0 && source.SourceSize.Height > 0);

        CaptureResult first = source.TryCapture(640, 360, Wait, forceFrame: true);
        AssertFrame(first, 640, 360, source);
        Assert.Null(first.DirtyRects); // no previous picture to diff against
    }

    [DesktopFact(NeedsDxgi = true)]
    public void Dxgi_forced_frame_works_repeatedly_and_after_a_resize()
    {
        using var source = new DxgiFrameSource();

        AssertFrame(source.TryCapture(640, 360, Wait, forceFrame: true), 640, 360, source);

        CaptureResult again = source.TryCapture(640, 360, TimeSpan.Zero, forceFrame: true);
        AssertFrame(again, 640, 360);

        CaptureResult resized = source.TryCapture(320, 180, TimeSpan.Zero, forceFrame: true);
        AssertFrame(resized, 320, 180);
        Assert.Null(resized.DirtyRects);
    }

    [DesktopFact(NeedsDxgi = true)]
    public void Dxgi_without_force_reports_no_change_or_a_frame_with_in_bounds_dirty_rects()
    {
        using var source = new DxgiFrameSource();
        AssertFrame(source.TryCapture(640, 360, Wait, forceFrame: true), 640, 360, source);

        CaptureResult r = source.TryCapture(640, 360, TimeSpan.FromMilliseconds(50), forceFrame: false);
        Assert.NotEqual(CaptureStatus.Lost, r.Status);
        if (r.Status == CaptureStatus.Frame)
        {
            AssertFrame(r, 640, 360);
            foreach (PixelRect d in r.DirtyRects ?? [])
            {
                Assert.True(d.Width > 0 && d.Height > 0);
                Assert.True(d.X >= 0 && d.Y >= 0 && d.X + d.Width <= 640 && d.Y + d.Height <= 360);
            }
        }
    }

    [DesktopFact]
    public void Gdi_returns_a_frame_of_the_requested_size_and_repeats()
    {
        using var source = new GdiFrameSource();

        Assert.Equal("gdi", source.Method);
        Assert.True(source.SourceSize.Width > 0 && source.SourceSize.Height > 0);

        CaptureResult first = source.TryCapture(640, 360, TimeSpan.Zero, forceFrame: true);
        AssertFrame(first, 640, 360, source);
        Assert.Null(first.DirtyRects);

        AssertFrame(source.TryCapture(640, 360, TimeSpan.Zero, forceFrame: true), 640, 360, source);
        AssertFrame(source.TryCapture(321, 181, TimeSpan.Zero, forceFrame: true), 321, 181, source);
    }

    [DesktopFact]
    public void Factory_returns_a_working_source()
    {
        var log = new List<string>();
        using IFrameSource source = FrameSourceFactory.Create(log: log.Add);

        AssertFrame(source.TryCapture(480, 270, Wait, forceFrame: true), 480, 270, source);
        Assert.Contains(source.Method, new[] { "dxgi", "gdi" });
    }

    [DesktopFact]
    public void Factory_can_force_gdi()
    {
        using IFrameSource source = FrameSourceFactory.Create(allowDxgi: false);
        Assert.Equal("gdi", source.Method);
    }
}
