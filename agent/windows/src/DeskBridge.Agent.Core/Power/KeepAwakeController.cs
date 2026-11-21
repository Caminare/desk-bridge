namespace DeskBridge.Agent.Core.Power;

/// <summary>The OS side of keep-awake.</summary>
public interface IPowerHold
{
    /// <summary>Keeps the system and display on (true), or restores normal idle behaviour (false).</summary>
    void SetHeld(bool held);

    /// <summary>Resets the user idle timer, which drives the screen saver and idle lock that a power hold does not stop.</summary>
    void NudgeIdleTimer();
}

/// <summary>
/// Opt-in keep-awake for as long as the agent runs, whether or not a controller is connected, so the PC is still awake
/// and unlocked when someone reconnects later. Holds the system and display on from construction until disposed and
/// nudges the idle timer every <see cref="NudgeIntervalMs"/>. Safe to tick from a timer thread while disposing.
/// </summary>
public sealed class KeepAwakeController : IDisposable
{
    public const long NudgeIntervalMs = 50_000;

    private readonly object _gate = new();
    private readonly IPowerHold _power;
    private bool _held;
    private long _lastNudgeMs;

    public KeepAwakeController(IPowerHold power, long nowMs)
    {
        _power = power;
        _power.SetHeld(true);
        _held = true;
        _lastNudgeMs = nowMs;
    }

    /// <summary>Call periodically (every few seconds); nudges once an interval has passed.</summary>
    public void Tick(long nowMs)
    {
        lock (_gate)
        {
            if (!_held || nowMs - _lastNudgeMs < NudgeIntervalMs) return;
            _lastNudgeMs = nowMs;
            _power.NudgeIdleTimer();
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (!_held) return;
            _held = false;
            _power.SetHeld(false);
        }
    }
}
