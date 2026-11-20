using DeskBridge.Agent.Core.Streaming;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Streaming;

public class StreamSizerTests
{
    [Theory]
    [InlineData(1152, 1920, 1080, 1152, 648)]
    [InlineData(1152, 3440, 1440, 1335, 559)]   // ultrawide keeps the 16:9 pixel budget
    [InlineData(1152, 800, 600, 800, 600)]      // never upscales
    [InlineData(1152, 1024, 768, 998, 748)]     // 4:3 gets as many pixels as 16:9 would
    [InlineData(100, 1920, 1080, 320, 180)]     // width floor
    [InlineData(1152, 200, 100, 200, 100)]      // tiny source stays native despite the floor
    public void Computes_size_from_the_pixel_budget(int maxWidth, int sw, int sh, int w, int h)
    {
        Assert.Equal((w, h), StreamSizer.Compute(maxWidth, sw, sh));
    }
}

public class RegionMergerTests
{
    private static string Merge(string[] grid, int frameW, int frameH)
    {
        int ty = grid.Length, tx = grid[0].Length;
        bool[] c = new bool[tx * ty];
        for (int y = 0; y < ty; y++)
            for (int x = 0; x < tx; x++) c[y * tx + x] = grid[y][x] == 'X';
        var m = new RegionMerger();
        return string.Join(" ", m.Merge(c, tx, ty, frameW, frameH).Select(r => $"{r.X},{r.Y},{r.Width},{r.Height}"));
    }

    [Fact]
    public void Single_tile() => Assert.Equal("64,0,64,64", Merge(["-X-"], 192, 64));

    [Fact]
    public void Horizontal_run_becomes_one_rect() => Assert.Equal("0,0,192,64", Merge(["XXX"], 192, 64));

    [Fact]
    public void Identical_runs_on_consecutive_rows_merge() =>
        Assert.Equal("64,0,128,192", Merge(["-XX", "-XX", "-XX"], 192, 192));

    [Fact]
    public void Runs_with_different_spans_do_not_merge_and_output_order_is_completion_order() =>
        Assert.Equal("0,0,192,64 0,64,64,64", Merge(["XXX", "X--"], 192, 128));

    [Fact]
    public void Gap_row_breaks_a_run() => Assert.Equal("0,0,64,64 0,128,64,64", Merge(["X", "-", "X"], 64, 192));

    [Fact]
    public void Rects_are_clipped_to_the_frame_edge() =>
        Assert.Equal("64,64,6,6", Merge(["--", "-X"], 70, 70));

    [Fact]
    public void Nothing_changed_gives_no_rects() => Assert.Equal("", Merge(["--", "--"], 128, 128));
}

public class KeyframePolicyTests
{
    [Fact]
    public void No_reference_is_init()
    {
        var p = new KeyframePolicy();
        Assert.Equal(KeyframeReason.Init, p.Evaluate(hasReference: false));
        Assert.Equal(KeyframeReason.None, p.Evaluate(hasReference: true));
    }

    [Fact]
    public void Request_is_req_until_a_keyframe_taken_after_it_satisfies_it()
    {
        var p = new KeyframePolicy();
        p.RequestKeyframe();
        int tokenAtCapture = p.RequestToken;
        Assert.Equal(KeyframeReason.Req, p.Evaluate(true));
        p.RequestKeyframe(); // arrives while that frame is in the pipeline
        p.MarkSatisfied(tokenAtCapture);
        Assert.Equal(KeyframeReason.Req, p.Evaluate(true));
        p.MarkSatisfied(p.RequestToken);
        Assert.Equal(KeyframeReason.None, p.Evaluate(true));
    }

    [Theory]
    [InlineData(5, 10, KeyframeReason.None)]
    [InlineData(6, 10, KeyframeReason.Big)]
    [InlineData(0, 10, KeyframeReason.None)]
    public void More_than_half_changed_is_big(int changed, int total, KeyframeReason expected)
        => Assert.Equal(expected, KeyframePolicy.EvaluateAfterDiff(changed, total));

    [Fact]
    public void Last_reason_is_reported_as_wire_string()
    {
        var p = new KeyframePolicy();
        Assert.Equal("", p.LastReason);
        p.NoteKeyframe(KeyframeReason.Big);
        Assert.Equal("big", p.LastReason);
    }
}
