using DeskBridge.Agent.Core.Power;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Power;

public sealed class KeepAwakeControllerTests
{
    private sealed class FakePower : IPowerHold
    {
        public List<string> Calls { get; } = [];

        public void SetHeld(bool held) => Calls.Add(held ? "hold" : "release");

        public void NudgeIdleTimer() => Calls.Add("nudge");
    }

    private const long Nudge = KeepAwakeController.NudgeIntervalMs;

    [Fact]
    public void Holds_from_the_start_without_waiting_for_a_controller()
    {
        var power = new FakePower();
        using var keepAwake = new KeepAwakeController(power, nowMs: 0);

        Assert.Equal(["hold"], power.Calls);
    }

    [Fact]
    public void Nudges_the_idle_timer_every_interval()
    {
        var power = new FakePower();
        using var keepAwake = new KeepAwakeController(power, nowMs: 1_000);

        keepAwake.Tick(1_000 + Nudge - 1);
        keepAwake.Tick(1_000 + Nudge);
        keepAwake.Tick(1_000 + Nudge + 10_000);
        keepAwake.Tick(1_000 + 2 * Nudge);

        Assert.Equal(["hold", "nudge", "nudge"], power.Calls);
    }

    [Fact]
    public void Dispose_releases_once_and_stops_nudging()
    {
        var power = new FakePower();
        var keepAwake = new KeepAwakeController(power, nowMs: 0);

        keepAwake.Dispose();
        keepAwake.Dispose();
        keepAwake.Tick(5 * Nudge);

        Assert.Equal(["hold", "release"], power.Calls);
    }
}
