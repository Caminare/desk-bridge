using DeskBridge.Agent.Core.Relay;

namespace DeskBridge.Agent.Core.Status;

public enum AgentStatusKind
{
    Connecting,
    Online,
    /// <summary>At least one controller is connected: the user should be able to tell at a glance.</summary>
    Controlled,
    Offline,
    Paused,
    Enrolling,
}

/// <param name="PairingCode">Shown in the tray, never written to the log file.</param>
public sealed record AgentStatus(
    AgentStatusKind Kind,
    int Controllers = 0,
    string? Detail = null,
    string? PairingCode = null,
    string? PairingUrl = null)
{
    public string Summary => Kind switch
    {
        AgentStatusKind.Connecting => "Connecting to the relay...",
        AgentStatusKind.Online => "Online, waiting for a controller",
        AgentStatusKind.Controlled => Controllers == 1 ? "1 controller connected" : $"{Controllers} controllers connected",
        AgentStatusKind.Offline => Detail is null ? "Offline" : $"Offline: {Detail}",
        AgentStatusKind.Paused => "Sharing paused",
        AgentStatusKind.Enrolling => "Enrolling this PC...",
        _ => Kind.ToString(),
    };
}

/// <summary>
/// Turns relay events and the supervisor's own states (paused, enrolling) into the status the tray shows, and
/// signals when a controller joins an unwatched PC so the user can be told. Thread-safe; events are raised on the
/// calling thread, outside the lock.
/// </summary>
public sealed class AgentStatusTracker
{
    private readonly object _gate = new();
    private AgentStatus _current = new(AgentStatusKind.Connecting);

    public event Action<AgentStatus>? Changed;

    /// <summary>Raised with the controller count when it goes from zero to at least one.</summary>
    public event Action<int>? ControllerJoined;

    public AgentStatus Current
    {
        get { lock (_gate) return _current; }
    }

    public void Apply(RelayEvent ev)
    {
        Transition(current =>
        {
            // The relay connection is being torn down; its last events must not undo the supervisor's state.
            if (current.Kind is AgentStatusKind.Paused or AgentStatusKind.Enrolling) return current;
            return ev switch
            {
                RegisteredEvent r => WithControllers(current with { PairingCode = r.PairingCode, PairingUrl = r.PairingUrl, Detail = null }, r.ControllerCount),
                ControllerCountEvent c => WithControllers(current, c.Count),
                DisconnectedEvent d => current with { Kind = AgentStatusKind.Offline, Controllers = 0, Detail = Describe(d) },
                _ => current,
            };
        });
    }

    public void SetConnecting() => Transition(c => c with { Kind = AgentStatusKind.Connecting, Controllers = 0, Detail = null });

    public void SetPaused() => Transition(c => c with { Kind = AgentStatusKind.Paused, Controllers = 0, Detail = null });

    public void SetEnrolling() => Transition(_ => new AgentStatus(AgentStatusKind.Enrolling));

    private static AgentStatus WithControllers(AgentStatus status, int count) =>
        status with { Kind = count > 0 ? AgentStatusKind.Controlled : AgentStatusKind.Online, Controllers = count };

    private static string Describe(DisconnectedEvent d) =>
        d.Revoked ? "removed from the fleet"
        : d.AuthRejected ? $"the relay rejected this PC, retrying in {d.RetryIn.TotalSeconds:0}s"
        : d.Replaced ? "another agent is using this host id"
        : $"retrying in {d.RetryIn.TotalSeconds:0}s";

    private void Transition(Func<AgentStatus, AgentStatus> next)
    {
        AgentStatus before, after;
        lock (_gate)
        {
            before = _current;
            after = next(before);
            _current = after;
        }
        if (after == before) return;
        Changed?.Invoke(after);
        if (before.Controllers == 0 && after.Controllers > 0) ControllerJoined?.Invoke(after.Controllers);
    }
}
