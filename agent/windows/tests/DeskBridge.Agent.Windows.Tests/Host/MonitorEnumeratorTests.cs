using DeskBridge.Agent.Core.Displays;
using DeskBridge.Agent.Windows.Capture;
using DeskBridge.Agent.Windows.Host;
using DeskBridge.Agent.Windows.Tests.Capture;
using Xunit;

namespace DeskBridge.Agent.Windows.Tests.Host;

public class MonitorEnumeratorTests
{
    [DesktopFact]
    public void Lists_one_primary_monitor_at_the_virtual_desktop_origin()
    {
        IReadOnlyList<DisplayInfo> displays = MonitorEnumerator.List();

        Assert.NotEmpty(displays);
        DisplayInfo primary = Assert.Single(displays, d => d.Primary);
        Assert.Equal((0, 0), (primary.X, primary.Y));
        Assert.All(displays, d =>
        {
            Assert.NotEqual(0, d.Handle);
            Assert.StartsWith(@"\\.\DISPLAY", d.DeviceName);
            Assert.True(d.Width > 0 && d.Height > 0);
        });
    }

    [DesktopFact]
    public void Each_monitor_captures_at_its_listed_physical_size()
    {
        // Input maps onto the listed bounds and frames come from the capture source, so they must agree
        // on every monitor; with mixed scaling a DPI-unaware process would see scaled bounds here.
        foreach (DisplayInfo d in MonitorEnumerator.List())
        {
            using var dxgiOrGdi = FrameSourceFactory.Create(d.Handle);
            Assert.Equal((d.Width, d.Height), dxgiOrGdi.SourceSize);
            using var gdi = FrameSourceFactory.Create(d.Handle, allowDxgi: false);
            Assert.Equal((d.Width, d.Height), gdi.SourceSize);
        }
    }
}
