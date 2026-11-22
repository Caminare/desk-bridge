using DeskBridge.Agent.Core.Cursor;
using DeskBridge.Agent.Core.Displays;
using DeskBridge.Agent.Core.Streaming;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Displays;

public class SwitchableFrameSourceTests
{
    private static readonly DisplayInfo Laptop = new(1, @"\\.\DISPLAY1", 0, 0, 2880, 1800, true);
    private static readonly DisplayInfo External = new(2, @"\\.\DISPLAY2", 2880, 0, 1920, 1080, false);

    private sealed class FakeSource(DisplayInfo display) : IFrameSource
    {
        public DisplayInfo Display { get; } = display;
        public CaptureStatus NextStatus { get; set; } = CaptureStatus.NoChange;
        public bool Disposed { get; private set; }
        public string Method => "fake";
        public (int Width, int Height) SourceSize => (Display.Width, Display.Height);
        public CursorSnapshot Cursor { get; set; }
        public bool DrawCursor { get; set; } = true;
        public CaptureResult TryCapture(int targetWidth, int targetHeight, TimeSpan timeout, bool forceFrame) =>
            new(NextStatus, default, null, 0);
        public void Dispose() => Disposed = true;
    }

    private sealed class Rig
    {
        public List<DisplayInfo> Monitors { get; set; }
        public List<FakeSource> Created { get; } = [];
        public List<string> Logs { get; } = [];
        public Func<DisplayInfo, IFrameSource>? CreateOverride { get; set; }
        public int ChangeCount { get; private set; }
        public SwitchableFrameSource Source { get; }

        public Rig(List<DisplayInfo>? monitors = null)
        {
            Monitors = monitors ?? [Laptop, External];
            Source = new SwitchableFrameSource(() => Monitors, Create, Logs.Add);
            Source.DisplaysChanged += () => ChangeCount++;
        }

        public FakeSource Current => Created[^1];

        private IFrameSource Create(DisplayInfo d)
        {
            if (CreateOverride is { } o) return o(d);
            var s = new FakeSource(d);
            Created.Add(s);
            return s;
        }

        public CaptureStatus Capture() => Source.TryCapture(100, 100, TimeSpan.Zero, false).Status;
    }

    [Fact]
    public void Starts_capturing_the_primary_monitor()
    {
        var rig = new Rig([External, Laptop]);
        Assert.Equal(Laptop, rig.Current.Display);
        Assert.Equal((2880, 1800), rig.Source.SourceSize);
        Assert.Equal(Laptop, rig.Source.Active);
        Assert.Equal("fake", rig.Source.Method);
    }

    [Fact]
    public void A_monitor_request_is_applied_on_the_next_capture()
    {
        var rig = new Rig();
        rig.Source.RequestMonitor(1);
        // Nothing changes until the capture thread runs.
        Assert.Equal(Laptop, rig.Source.Active);
        Assert.Single(rig.Created);

        // Lost tells the engine to drop its reference, so the new monitor starts with a keyframe.
        Assert.Equal(CaptureStatus.Lost, rig.Capture());
        Assert.Equal(External, rig.Current.Display);
        Assert.True(rig.Created[0].Disposed);
        Assert.Equal(External, rig.Source.Active);
        Assert.Equal((1920, 1080), rig.Source.SourceSize);
        Assert.Equal(1, rig.ChangeCount);
        Assert.Equal(1, rig.Source.Update().ActiveMonitor);
    }

    [Fact]
    public void Requesting_the_active_monitor_changes_nothing()
    {
        var rig = new Rig();
        rig.Source.RequestMonitor(0);
        Assert.Equal(CaptureStatus.NoChange, rig.Capture());
        Assert.Single(rig.Created);
        Assert.Equal(0, rig.ChangeCount);
    }

    [Fact]
    public void The_monitor_list_is_read_again_before_switching()
    {
        // The external monitor was unplugged after the controller showed it: fall back to the primary.
        var rig = new Rig();
        rig.Monitors = [Laptop];
        rig.Source.RequestMonitor(1);
        rig.Capture();
        Assert.Equal(Laptop, rig.Source.Active);
        Assert.Equal(1, rig.ChangeCount); // the list shrank, the controller must learn it
    }

    [Fact]
    public void Lost_capture_with_the_active_monitor_unplugged_moves_to_the_primary()
    {
        var rig = new Rig();
        rig.Source.RequestMonitor(1);
        rig.Capture();
        rig.Monitors = [Laptop];
        rig.Current.NextStatus = CaptureStatus.Lost;

        Assert.Equal(CaptureStatus.Lost, rig.Capture());
        Assert.Equal(Laptop, rig.Current.Display);
        Assert.Equal(2, rig.ChangeCount);
    }

    [Fact]
    public void Lost_capture_without_a_display_change_keeps_the_source()
    {
        // Secure desktop (UAC, lock screen): the source recovers on its own.
        var rig = new Rig();
        rig.Current.NextStatus = CaptureStatus.Lost;
        Assert.Equal(CaptureStatus.Lost, rig.Capture());
        Assert.Single(rig.Created);
        Assert.Equal(0, rig.ChangeCount);
    }

    [Fact]
    public void Plugging_in_another_monitor_is_reported_without_switching()
    {
        var rig = new Rig([Laptop]);
        int created = rig.Created.Count;

        rig.Monitors = [Laptop, External];
        rig.Current.NextStatus = CaptureStatus.Lost;
        rig.Capture();
        Assert.Equal(1, rig.ChangeCount);
        Assert.Equal(Laptop, rig.Source.Active);
        Assert.Equal(created, rig.Created.Count); // still streaming the same monitor
        Assert.Equal(2, rig.Source.Update().Monitors.Count);
    }

    [Fact]
    public void A_refresh_request_rereads_the_monitors_on_the_next_capture()
    {
        var rig = new Rig();
        rig.Monitors = [Laptop with { Width = 1920, Height = 1200 }, External];
        rig.Source.RequestRefresh();

        Assert.Equal(CaptureStatus.Lost, rig.Capture());
        Assert.Equal(1920, rig.Current.Display.Width); // resolution changed: rebuilt
        Assert.Equal(1, rig.ChangeCount);
    }

    [Fact]
    public void A_failed_rebuild_keeps_the_old_source_and_retries_on_the_next_capture()
    {
        var rig = new Rig();
        FakeSource original = rig.Current;
        rig.CreateOverride = _ => throw new InvalidOperationException("monitor vanished");
        rig.Source.RequestMonitor(1);

        Assert.Equal(CaptureStatus.Lost, rig.Capture());
        Assert.False(original.Disposed);
        Assert.Equal(Laptop, rig.Source.Active);
        Assert.Contains(rig.Logs, l => l.Contains("monitor vanished"));

        rig.CreateOverride = null;
        Assert.Equal(CaptureStatus.Lost, rig.Capture());
        Assert.Equal(External, rig.Source.Active);
        Assert.True(original.Disposed);
    }

    [Fact]
    public void Snapshot_reflects_the_applied_selection()
    {
        var rig = new Rig();
        rig.Source.RequestMonitor(1);
        rig.Capture();
        var s = rig.Source.Snapshot("Windows");
        Assert.Equal(1, s.ActiveMonitor);
        Assert.Equal(1920, s.ScreenWidth);
    }

    [Fact]
    public void Cursor_drawing_follows_the_setting_across_monitor_switches_and_cursor_reads_the_current_source()
    {
        var rig = new Rig();
        rig.Source.DrawCursor = false;
        Assert.False(rig.Current.DrawCursor);

        rig.Source.RequestMonitor(1);
        rig.Capture();
        Assert.Equal(External, rig.Current.Display);
        Assert.False(rig.Current.DrawCursor);

        rig.Current.Cursor = new CursorSnapshot(true, 7, 9, null);
        Assert.Equal(7, rig.Source.Cursor.X);
    }

    [Fact]
    public void Dispose_disposes_the_current_source()
    {
        var rig = new Rig();
        rig.Source.Dispose();
        Assert.True(rig.Current.Disposed);
    }
}
