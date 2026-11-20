using DeskBridge.Agent.Core.Streaming;
using DeskBridge.Agent.Windows.Capture;
using Xunit;

namespace DeskBridge.Agent.Windows.Tests.Capture;

public class RectScalerTests
{
    [Fact]
    public void Rounds_outward_when_downscaling()
    {
        Assert.True(RectScaler.TryScale(101, 51, 103, 53, 1920, 1080, 960, 540, margin: 0, out PixelRect r));
        // 101*0.5 = 50.5 -> 50, 103*0.5 = 51.5 -> 52
        Assert.Equal(new PixelRect(50, 25, 2, 2), r);
    }

    [Fact]
    public void Margin_grows_the_rect_and_clips_to_the_image()
    {
        Assert.True(RectScaler.TryScale(0, 0, 10, 10, 100, 100, 50, 50, margin: 2, out PixelRect r));
        Assert.Equal(new PixelRect(0, 0, 7, 7), r);

        Assert.True(RectScaler.TryScale(90, 90, 100, 100, 100, 100, 50, 50, margin: 2, out r));
        Assert.Equal(new PixelRect(43, 43, 7, 7), r);
    }

    [Fact]
    public void Upscaling_scales_the_rect_up()
    {
        Assert.True(RectScaler.TryScale(10, 10, 20, 20, 100, 100, 200, 200, margin: 0, out PixelRect r));
        Assert.Equal(new PixelRect(20, 20, 20, 20), r);
    }

    [Fact]
    public void Rect_outside_the_image_is_dropped()
    {
        Assert.False(RectScaler.TryScale(200, 200, 300, 300, 100, 100, 50, 50, margin: 1, out _));
        Assert.False(RectScaler.TryScale(5, 5, 5, 9, 100, 100, 50, 50, margin: 0, out _));
    }

    [Fact]
    public void Union_ignores_empty_rects()
    {
        var a = new PixelRect(10, 10, 5, 5);
        Assert.Equal(a, RectScaler.Union(a, default));
        Assert.Equal(a, RectScaler.Union(default, a));
        Assert.Equal(new PixelRect(10, 10, 20, 15), RectScaler.Union(a, new PixelRect(25, 20, 5, 5)));
    }

    [Fact]
    public void Long_lists_collapse_into_their_bounding_box()
    {
        var rects = Enumerable.Range(0, RectScaler.MaxRects + 1).Select(i => new PixelRect(i, i, 1, 1)).ToList();
        RectScaler.CapCount(rects);
        Assert.Equal([new PixelRect(0, 0, RectScaler.MaxRects + 1, RectScaler.MaxRects + 1)], rects);

        var few = new List<PixelRect> { new(0, 0, 1, 1), new(5, 5, 1, 1) };
        RectScaler.CapCount(few);
        Assert.Equal(2, few.Count);
    }
}
