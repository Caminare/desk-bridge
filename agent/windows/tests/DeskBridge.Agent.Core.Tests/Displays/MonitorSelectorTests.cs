using DeskBridge.Agent.Core.Displays;
using DeskBridge.Agent.Core.Relay;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Displays;

public class MonitorSelectorTests
{
    // Laptop panel at 150% (physical 2880x1800) is primary; an external 1920x1080 at 100% sits to
    // its left, so its origin is negative. Per-monitor DPI awareness means both report physical pixels.
    private static readonly DisplayInfo External = new(11, @"\\.\DISPLAY2", -1920, 360, 1920, 1080, false);
    private static readonly DisplayInfo Laptop = new(22, @"\\.\DISPLAY1", 0, 0, 2880, 1800, true);

    [Fact]
    public void Starts_on_the_primary_monitor()
    {
        var selector = new MonitorSelector([External, Laptop]);
        Assert.Equal(1, selector.ActiveIndex);
        Assert.Equal(Laptop, selector.Active);
    }

    [Fact]
    public void Starts_on_the_first_monitor_when_none_is_primary()
    {
        var selector = new MonitorSelector([External, Laptop with { Primary = false }]);
        Assert.Equal(0, selector.ActiveIndex);
    }

    [Fact]
    public void Empty_list_is_rejected()
    {
        Assert.Throws<ArgumentException>(() => new MonitorSelector([]));
    }

    [Fact]
    public void Select_switches_and_reports_the_change()
    {
        var selector = new MonitorSelector([External, Laptop]);
        Assert.True(selector.Select(0));
        Assert.Equal(External, selector.Active);
        Assert.False(selector.Select(0));
    }

    [Theory]
    [InlineData(2)]
    [InlineData(99)]
    [InlineData(-1)]
    public void Select_out_of_range_falls_back_to_the_primary(int index)
    {
        var selector = new MonitorSelector([External, Laptop]);
        selector.Select(0);
        Assert.True(selector.Select(index));
        Assert.Equal(Laptop, selector.Active);
    }

    [Fact]
    public void Refresh_follows_the_active_monitor_when_indexes_shift()
    {
        var selector = new MonitorSelector([External, Laptop]);
        selector.Select(0);
        var third = new DisplayInfo(33, @"\\.\DISPLAY3", 2880, 0, 2560, 1440, false);

        Assert.True(selector.Refresh([Laptop, third, External]));
        Assert.Equal(2, selector.ActiveIndex);
        Assert.Equal(External, selector.Active);
    }

    [Fact]
    public void Refresh_falls_back_to_the_primary_when_the_active_monitor_is_gone()
    {
        var selector = new MonitorSelector([External, Laptop]);
        selector.Select(0);

        Assert.True(selector.Refresh([Laptop]));
        Assert.Equal(0, selector.ActiveIndex);
        Assert.Equal(Laptop, selector.Active);
    }

    [Fact]
    public void Refresh_with_the_same_monitors_reports_no_change()
    {
        var selector = new MonitorSelector([External, Laptop]);
        Assert.False(selector.Refresh([External with { }, Laptop with { }]));
    }

    [Fact]
    public void Refresh_reports_a_resolution_change_of_the_active_monitor()
    {
        var selector = new MonitorSelector([External, Laptop]);
        Assert.True(selector.Refresh([External, Laptop with { Width = 1920, Height = 1200 }]));
        Assert.Equal(1920, selector.Active.Width);
    }

    [Fact]
    public void Refresh_with_no_monitors_keeps_the_last_known_set()
    {
        // Briefly empty during some display reconfigurations; keep streaming what we had.
        var selector = new MonitorSelector([External, Laptop]);
        Assert.False(selector.Refresh([]));
        Assert.Equal(Laptop, selector.Active);
        Assert.Equal(2, selector.Displays.Count);
    }

    [Fact]
    public void Snapshot_reports_physical_sizes_of_every_monitor_and_the_active_one()
    {
        var selector = new MonitorSelector([External, Laptop]);
        RegistrationSnapshot s = selector.Snapshot("Windows 11");

        Assert.Equal(2880, s.ScreenWidth);
        Assert.Equal(1800, s.ScreenHeight);
        Assert.Equal(1, s.ActiveMonitor);
        Assert.Equal("Windows 11", s.Os);
        Assert.Equal(
            [
                new MonitorModel(0, -1920, 360, 1920, 1080, false, "DISPLAY2"),
                new MonitorModel(1, 0, 0, 2880, 1800, true, "DISPLAY1"),
            ],
            s.Monitors);
    }

    [Fact]
    public void Update_carries_the_same_monitor_fields_as_the_snapshot()
    {
        var selector = new MonitorSelector([External, Laptop]);
        selector.Select(0);
        HostUpdatePayload u = selector.Update();
        RegistrationSnapshot s = selector.Snapshot("x");

        Assert.Equal(1920, u.ScreenWidth);
        Assert.Equal(1080, u.ScreenHeight);
        Assert.Equal(0, u.ActiveMonitor);
        Assert.Equal(s.Monitors, u.Monitors);
    }
}
