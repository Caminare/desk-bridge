namespace DeskBridge.Agent.Core.Streaming;

/// <summary>
/// Decides when the next capture is due, ported from the PowerShell agent: a regular interval (fast while
/// the screen is active, slow when idle), and early wake-ups for input and keyframe requests.
/// Pure: times are milliseconds from any monotonic clock. Thread safe (input arrives on another thread).
/// </summary>
public sealed class CaptureScheduler
{
    /// <summary>Capture interval while active, ms.</summary>
    public const int ActiveIntervalMs = 33;
    /// <summary>Delay between an input event and the capture that should show its effect, ms (lets the app repaint).</summary>
    public const int InputSettleMs = 15;
    /// <summary>Minimum gap between two captures when woken early, ms.</summary>
    public const int MinCaptureGapMs = 16;
    /// <summary>The fast rate stays on this long after input, ms.</summary>
    public const int InputActiveMs = 600;
    /// <summary>The fast rate stays on this long after a screen change, ms.</summary>
    public const int ChangeActiveMs = 500;

    private readonly object _gate = new();
    private long _startedAt;
    private long _activeUntil;
    private long _wakeAt;

    public CaptureScheduler(int idleIntervalMs = 100) => IdleIntervalMs = idleIntervalMs;

    public int IdleIntervalMs { get; set; }

    /// <summary>Call when a capture cycle begins. Clears any early wake-up, which that cycle satisfies.</summary>
    public void OnCaptureStarted(long nowMs)
    {
        lock (_gate)
        {
            _startedAt = nowMs;
            _wakeAt = 0;
        }
    }

    /// <summary>An input event: fast rate for a while, and a capture soon so the result shows up quickly.</summary>
    public void NotifyInput(long nowMs)
    {
        lock (_gate)
        {
            _activeUntil = nowMs + InputActiveMs;
            WakeAt(nowMs + InputSettleMs);
        }
    }

    /// <summary>The screen is changing (video, scrolling): keep capturing fast, not only after input.</summary>
    public void NotifyScreenChange(long nowMs)
    {
        lock (_gate) _activeUntil = Math.Max(_activeUntil, nowMs + ChangeActiveMs);
    }

    /// <summary>Keyframe request or monitor switch: capture as soon as the minimum gap allows.</summary>
    public void RequestImmediate(long nowMs)
    {
        lock (_gate) WakeAt(nowMs);
    }

    /// <summary>When the next capture is due (a time on the same clock). Due or overdue means capture now.</summary>
    public long NextDue(long nowMs)
    {
        lock (_gate)
        {
            long due = _startedAt + (nowMs < _activeUntil ? ActiveIntervalMs : IdleIntervalMs);
            if (_wakeAt > 0 && _wakeAt < due) due = Math.Max(_wakeAt, _startedAt + MinCaptureGapMs);
            return Math.Max(due, _startedAt + 2);
        }
    }

    // Never postpones an earlier pending wake-up.
    private void WakeAt(long at)
    {
        if (_wakeAt == 0 || at < _wakeAt) _wakeAt = Math.Max(1, at);
    }
}
