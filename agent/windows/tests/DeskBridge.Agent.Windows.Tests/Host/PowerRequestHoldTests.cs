using DeskBridge.Agent.Windows.Host;
using Xunit;

namespace DeskBridge.Agent.Windows.Tests.Host;

public sealed class PowerRequestHoldTests
{
    [Fact]
    public void Sets_and_clears_the_power_request_without_errors()
    {
        var log = new List<string>();
        using (var hold = new PowerRequestHold(log.Add))
        {
            hold.SetHeld(true);
            hold.SetHeld(true);
            hold.SetHeld(false);
            hold.SetHeld(true);
        }

        Assert.Empty(log);
    }
}
