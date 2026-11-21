using DeskBridge.Agent.Core.Relay;
using DeskBridge.Agent.Core.Status;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Status;

public sealed class AgentStatusTrackerTests
{
    private readonly AgentStatusTracker _tracker = new();
    private readonly List<AgentStatus> _changes = [];
    private readonly List<int> _joined = [];

    public AgentStatusTrackerTests()
    {
        _tracker.Changed += _changes.Add;
        _tracker.ControllerJoined += _joined.Add;
    }

    private static RegisteredEvent Registered(int controllers = 0) => new("host-1", "ABCD-1234", "https://relay/pair/ABCD-1234", controllers);

    private static DisconnectedEvent Disconnected(bool auth = false, bool replaced = false) =>
        new("closed", 1006, replaced, auth, TimeSpan.FromSeconds(4));

    [Fact]
    public void Starts_connecting()
    {
        Assert.Equal(AgentStatusKind.Connecting, _tracker.Current.Kind);
    }

    [Fact]
    public void Registration_goes_online_and_keeps_the_pairing_link_for_display()
    {
        _tracker.Apply(Registered());

        AgentStatus status = Assert.Single(_changes);
        Assert.Equal(AgentStatusKind.Online, status.Kind);
        Assert.Equal("ABCD-1234", status.PairingCode);
        Assert.Equal("https://relay/pair/ABCD-1234", status.PairingUrl);
    }

    [Fact]
    public void A_controller_connecting_is_controlled_and_notifies_once()
    {
        _tracker.Apply(Registered());
        _tracker.Apply(new ControllerCountEvent(1));
        _tracker.Apply(new ControllerCountEvent(2));

        Assert.Equal(AgentStatusKind.Controlled, _tracker.Current.Kind);
        Assert.Equal(2, _tracker.Current.Controllers);
        Assert.Equal([1], _joined);
    }

    [Fact]
    public void Notifies_again_after_all_controllers_left()
    {
        _tracker.Apply(Registered());
        _tracker.Apply(new ControllerCountEvent(1));
        _tracker.Apply(new ControllerCountEvent(0));
        _tracker.Apply(new ControllerCountEvent(1));

        Assert.Equal([1, 1], _joined);
    }

    [Fact]
    public void Registering_while_a_controller_is_already_waiting_notifies()
    {
        _tracker.Apply(Registered(controllers: 1));

        Assert.Equal(AgentStatusKind.Controlled, _tracker.Current.Kind);
        Assert.Equal([1], _joined);
    }

    [Fact]
    public void Disconnect_goes_offline_with_a_reason_and_resets_the_controllers()
    {
        _tracker.Apply(Registered());
        _tracker.Apply(new ControllerCountEvent(1));
        _tracker.Apply(Disconnected(auth: true));
        _tracker.Apply(Registered(controllers: 1));

        Assert.Equal(AgentStatusKind.Offline, _changes[^2].Kind);
        Assert.Equal(0, _changes[^2].Controllers);
        Assert.Contains("rejected", _changes[^2].Detail);
        Assert.Equal([1, 1], _joined);
    }

    [Fact]
    public void Paused_and_enrolling_are_set_by_the_supervisor_and_ignore_late_relay_events()
    {
        _tracker.Apply(Registered());
        _tracker.SetPaused();
        _tracker.Apply(new ControllerCountEvent(1));

        Assert.Equal(AgentStatusKind.Paused, _tracker.Current.Kind);
        Assert.Empty(_joined);

        _tracker.SetEnrolling();
        Assert.Equal(AgentStatusKind.Enrolling, _tracker.Current.Kind);

        _tracker.SetConnecting();
        _tracker.Apply(new ControllerCountEvent(1));
        Assert.Equal(AgentStatusKind.Controlled, _tracker.Current.Kind);
    }

    [Fact]
    public void Unchanged_status_raises_no_event()
    {
        _tracker.Apply(Registered());
        _tracker.Apply(new ControllerCountEvent(0));
        _tracker.Apply(new FrameAckEvent(1, false));

        Assert.Single(_changes);
    }

    [Fact]
    public void Summary_describes_each_state_in_plain_words()
    {
        Assert.Equal("Connecting to the relay...", new AgentStatus(AgentStatusKind.Connecting).Summary);
        Assert.Equal("Online, waiting for a controller", new AgentStatus(AgentStatusKind.Online).Summary);
        Assert.Equal("1 controller connected", new AgentStatus(AgentStatusKind.Controlled, 1).Summary);
        Assert.Equal("2 controllers connected", new AgentStatus(AgentStatusKind.Controlled, 2).Summary);
        Assert.Equal("Offline: no network", new AgentStatus(AgentStatusKind.Offline, Detail: "no network").Summary);
        Assert.Equal("Sharing paused", new AgentStatus(AgentStatusKind.Paused).Summary);
        Assert.Equal("Enrolling this PC...", new AgentStatus(AgentStatusKind.Enrolling).Summary);
    }
}
