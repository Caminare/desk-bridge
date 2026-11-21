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
/// and unlocked when someone reconnects later. While enabled it holds the system and display on and nudges the idle
/// timer every <see cref="NudgeIntervalMs"/>. Can be switched at runtime (tray toggle). Safe to tick from a timer
/// thread while switching or disposing.
/// </summary>
public sealed class KeepAwakeController : IDisposable
{
    public const long NudgeIntervalMs = 50_000;

    private readonly object _gate = new();
    private readonly IPowerHold _power;
    private bool _enabled;
    private bool _disposed;
    private long _lastNudgeMs;

    public KeepAwakeController(IPowerHold power, bool enabled, long nowMs)
    {
        _power = power;
        SetEnabled(enabled, nowMs);
    }

    public bool Enabled
    {
        get { lock (_gate) return _enabled; }
    }

    public void SetEnabled(bool enabled, long nowMs)
    {
        lock (_gate)
        {
            if (_disposed || enabled == _enabled) return;
            _enabled = enabled;
            _lastNudgeMs = nowMs;
            _power.SetHeld(enabled);
        }
    }

    /// <summary>Call periodically (every few seconds); nudges once an interval has passed.</summary>
    public void Tick(long nowMs)
    {
        lock (_gate)
        {
            if (!_enabled || nowMs - _lastNudgeMs < NudgeIntervalMs) return;
            _lastNudgeMs = nowMs;
            _power.NudgeIdleTimer();
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            if (_enabled) _power.SetHeld(false);
            _enabled = false;
            _disposed = true;
        }
    }
}
