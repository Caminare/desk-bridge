using DeskBridge.Agent.Core.Cursor;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Cursor;

public class CursorPublisherTests
{
    private static readonly CursorShapeData Arrow = new("a1", 1, 1, 0, 0, [0, 0, 0, 255]);
    private static readonly CursorShapeData Beam = new("b2", 1, 1, 0, 0, [255, 255, 255, 255]);

    private static CursorSnapshot At(int x, int y, CursorShapeData? shape = null, bool visible = true) =>
        new(visible, x, y, shape ?? Arrow);

    [Fact]
    public void Nothing_is_due_before_the_first_update()
    {
        var p = new CursorPublisher();
        Assert.False(p.TryTake(0, out _, out _));
    }

    [Fact]
    public void First_update_sends_the_shape_and_a_normalized_position()
    {
        var p = new CursorPublisher();
        p.Update(At(500, 250), 1000, 1000);
        Assert.True(p.TryTake(0, out var shape, out var pos));
        Assert.Same(Arrow, shape);
        Assert.Equal(new CursorPositionMessage(0.5, 0.25, true, "a1"), pos);
    }

    [Fact]
    public void An_unchanged_cursor_is_not_sent_again()
    {
        var p = new CursorPublisher();
        p.Update(At(1, 1), 100, 100);
        p.TryTake(0, out _, out _);
        p.Update(At(1, 1), 100, 100);
        Assert.False(p.TryTake(100, out _, out _));
    }

    [Fact]
    public void Positions_are_throttled_and_only_the_latest_is_sent()
    {
        var p = new CursorPublisher();
        p.Update(At(0, 0), 100, 100);
        p.TryTake(0, out _, out _);

        p.Update(At(10, 0), 100, 100);
        p.Update(At(20, 0), 100, 100);
        Assert.False(p.TryTake(5, out _, out _));
        Assert.Equal(CursorPublisher.MinPositionIntervalMs - 5, p.DelayUntilDue(5));

        Assert.True(p.TryTake(CursorPublisher.MinPositionIntervalMs, out var shape, out var pos));
        Assert.Null(shape);
        Assert.Equal(0.2, pos!.X);
        Assert.False(p.TryTake(1000, out _, out _));
    }

    [Fact]
    public void A_shape_change_is_sent_at_once_with_its_position_even_inside_the_throttle()
    {
        var p = new CursorPublisher();
        p.Update(At(0, 0), 100, 100);
        p.TryTake(0, out _, out _);

        p.Update(At(0, 0, Beam), 100, 100);
        Assert.True(p.TryTake(1, out var shape, out var pos));
        Assert.Same(Beam, shape);
        Assert.Equal("b2", pos!.Shape);
    }

    [Fact]
    public void Hidden_and_off_monitor_positions_are_reported()
    {
        var p = new CursorPublisher();
        p.Update(At(150, -20, visible: false), 100, 100);
        p.TryTake(0, out _, out var pos);
        Assert.Equal(new CursorPositionMessage(1.5, -0.2, false, "a1"), pos);
    }

    [Fact]
    public void Without_any_shape_the_position_has_none()
    {
        var p = new CursorPublisher();
        p.Update(new CursorSnapshot(false, 0, 0, null), 100, 100);
        p.TryTake(0, out var shape, out var pos);
        Assert.Null(shape);
        Assert.Null(pos!.Shape);
    }

    [Fact]
    public void Reset_resends_the_current_shape_and_position_on_the_next_update()
    {
        var p = new CursorPublisher();
        p.Update(At(5, 5), 100, 100);
        p.TryTake(0, out _, out _);

        p.Reset();
        p.Update(At(5, 5), 100, 100);
        Assert.True(p.TryTake(1, out var shape, out var pos));
        Assert.Same(Arrow, shape);
        Assert.NotNull(pos);
    }

    [Fact]
    public void Positions_are_rounded_to_keep_messages_small()
    {
        var p = new CursorPublisher();
        p.Update(At(1, 2), 3, 7);
        p.TryTake(0, out _, out var pos);
        Assert.Equal(0.33333, pos!.X);
        Assert.Equal(0.28571, pos.Y);
    }

    [Fact]
    public void Update_reports_whether_the_cursor_moved_or_changed_so_capture_can_stay_fast()
    {
        var p = new CursorPublisher();
        Assert.True(p.Update(At(1, 1), 100, 100));
        Assert.False(p.Update(At(1, 1), 100, 100));
        Assert.True(p.Update(At(2, 1), 100, 100));
        Assert.True(p.Update(At(2, 1, Beam), 100, 100));
    }

    [Fact]
    public void A_shape_already_sent_on_this_connection_is_not_sent_again()
    {
        // Animated cursors (the busy spinner) cycle through the same frames many times a second.
        var p = new CursorPublisher();
        p.Update(At(0, 0, Arrow), 100, 100);
        p.TryTake(0, out _, out _);
        p.Update(At(0, 0, Beam), 100, 100);
        p.TryTake(1, out _, out _);

        p.Update(At(0, 0, Arrow), 100, 100);
        Assert.True(p.TryTake(100, out var shape, out var pos));
        Assert.Null(shape);
        Assert.Equal("a1", pos!.Shape);
    }

    [Fact]
    public void Only_the_most_recent_shapes_are_remembered()
    {
        var p = new CursorPublisher();
        p.Update(At(0, 0, Arrow), 100, 100);
        p.TryTake(0, out _, out _);
        for (int i = 0; i < CursorPublisher.SentShapeMemory; i++)
        {
            p.Update(At(0, 0, new CursorShapeData($"s{i}", 1, 1, 0, 0, [0, 0, 0, 255])), 100, 100);
            p.TryTake(i + 1, out _, out _);
        }
        p.Update(At(0, 0, Arrow), 100, 100);
        Assert.True(p.TryTake(1000, out var shape, out _));
        Assert.Same(Arrow, shape);
    }

    [Fact]
    public void Signals_when_something_becomes_due()
    {
        var p = new CursorPublisher();
        int signals = 0;
        p.Pending += () => signals++;
        p.Update(At(1, 1), 100, 100);
        p.Update(At(1, 1), 100, 100); // unchanged: no new signal
        Assert.Equal(1, signals);
    }
}
