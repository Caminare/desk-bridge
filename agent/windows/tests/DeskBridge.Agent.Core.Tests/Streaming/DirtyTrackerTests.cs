using DeskBridge.Agent.Core.Streaming;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Streaming;

public class DirtyTrackerTests
{
    private static readonly PixelRect A = new(0, 0, 10, 10);
    private static readonly PixelRect B = new(20, 20, 5, 5);
    private static readonly PixelRect C = new(40, 0, 8, 8);

    [Fact]
    public void Unknown_before_any_frame_was_committed()
    {
        var t = new DirtyTracker();
        t.Record(1, [A]);
        Assert.Null(t.HintSinceReference());
    }

    [Fact]
    public void Hint_covers_only_captures_after_the_committed_one()
    {
        var t = new DirtyTracker();
        t.Record(1, [A]);
        t.Committed(1);
        t.Record(2, [B]);
        Assert.Equal([B], t.HintSinceReference());
    }

    [Fact]
    public void Dropped_frames_keep_their_rects_until_a_later_commit()
    {
        var t = new DirtyTracker();
        t.Record(1, [C]);
        t.Committed(1);
        t.Record(2, [A]); // posted, then replaced before the sender took it
        t.Record(3, [B]);
        Assert.Equal([A, B], t.HintSinceReference());

        t.Committed(3);
        t.Record(4, [C]);
        Assert.Equal([C], t.HintSinceReference());
    }

    [Fact]
    public void An_unknown_capture_since_the_reference_makes_the_hint_unknown()
    {
        var t = new DirtyTracker();
        t.Record(1, [A]);
        t.Committed(1);
        t.Record(2, null);
        t.Record(3, [B]);
        Assert.Null(t.HintSinceReference());

        t.Committed(2);
        Assert.Equal([B], t.HintSinceReference());
    }

    [Fact]
    public void Too_many_pending_captures_give_up_on_the_hint()
    {
        var t = new DirtyTracker();
        t.Record(1, [A]);
        t.Committed(1);
        for (int i = 2; i < 2 + DirtyTracker.MaxPendingCaptures + 1; i++) t.Record(i, [B]);
        Assert.Null(t.HintSinceReference());
    }

    [Fact]
    public void Reset_forgets_everything_until_the_next_commit()
    {
        var t = new DirtyTracker();
        t.Record(1, [A]);
        t.Committed(1);
        t.Record(2, [B]);
        t.Reset();
        Assert.Null(t.HintSinceReference());

        t.Record(3, null); // keyframe after the reset
        t.Committed(3);
        t.Record(4, [C]);
        Assert.Equal([C], t.HintSinceReference());
    }
}
