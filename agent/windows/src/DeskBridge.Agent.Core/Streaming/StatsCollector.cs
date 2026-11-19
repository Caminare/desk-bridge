using DeskBridge.Agent.Core.Protocol;

namespace DeskBridge.Agent.Core.Streaming;

/// <summary>
/// Per-second pipeline rates and smoothed costs that go into each frame's <see cref="AgentFrameStats"/>.
/// The PowerShell agent kept capture-side and sender-side counters in two windows; here one one-second
/// window covers both. Thread safe (capture and sender threads both record). Time is injected.
/// </summary>
public sealed class StatsCollector
{
    private readonly object _gate = new();
    private long _windowStart;
    private int _captures, _produced, _unchanged, _dropped, _rediffs, _keyframes, _keyRequests, _loops, _sentFrames;
    private long _sentBytes;

    private double _cfps, _pfps, _same, _drop, _rd, _kf, _kreq, _lps, _sfps, _kbps, _tickMs;
    private double _lastSendMs = -1;

    public double Kbps { get { lock (_gate) return _kbps; } }

    public void RecordCapture() { lock (_gate) _captures++; }
    public void RecordProduced() { lock (_gate) _produced++; }
    public void RecordUnchanged() { lock (_gate) _unchanged++; }
    public void RecordDropped() { lock (_gate) _dropped++; }
    public void RecordRediff() { lock (_gate) _rediffs++; }
    public void RecordKeyframe() { lock (_gate) _keyframes++; }
    public void RecordKeyRequest() { lock (_gate) _keyRequests++; }
    /// <summary>One main-loop iteration (stats <c>lps</c>).</summary>
    public void RecordLoop() { lock (_gate) _loops++; }

    public void RecordSent(int bytes)
    {
        lock (_gate)
        {
            _sentFrames++;
            _sentBytes += bytes;
        }
    }

    /// <summary>How long the last frame's send took to complete, ms (stats <c>snd</c>).</summary>
    public void RecordSendDuration(double ms) { lock (_gate) _lastSendMs = ms; }

    /// <summary>One capture-thread cycle took <paramref name="ms"/>; smoothed 0.8/0.2 (stats <c>tick</c>).</summary>
    public void RecordTick(double ms) { lock (_gate) _tickMs = _tickMs <= 0 ? ms : 0.8 * _tickMs + 0.2 * ms; }

    /// <summary>Closes the one-second window when it is over: refreshes the per-second rates and the smoothed upload rate.</summary>
    public void Update(long nowMs)
    {
        lock (_gate)
        {
            long span = nowMs - _windowStart;
            if (span < 1000) return;
            double s = span / 1000.0;
            _cfps = _captures / s;
            _pfps = _produced / s;
            _same = _unchanged / s;
            _drop = _dropped / s;
            _rd = _rediffs / s;
            _kf = _keyframes / s;
            _kreq = _keyRequests / s;
            _lps = _loops / s;
            _sfps = _sentFrames / s;
            double instant = _sentBytes * 8.0 / span; // bits per ms = kbit/s
            _kbps = _kbps <= 0 ? instant : 0.6 * _kbps + 0.4 * instant;
            _captures = _produced = _unchanged = _dropped = _rediffs = _keyframes = _keyRequests = _loops = _sentFrames = 0;
            _sentBytes = 0;
            _windowStart = nowMs;
        }
    }

    /// <summary>Restarts the window and zeroes the counters (capture was paused, so the idle time must not dilute the rates).</summary>
    public void ResetWindow(long nowMs)
    {
        lock (_gate)
        {
            _windowStart = nowMs;
            _captures = _produced = _unchanged = _dropped = _rediffs = _keyframes = _keyRequests = _loops = _sentFrames = 0;
            _sentBytes = 0;
        }
    }

    /// <summary>
    /// Builds the stats for a frame about to be sent. Call before <see cref="SendWindow.OnSent"/> so <c>inf</c>
    /// counts the frames already in flight. <paramref name="lastKeyReason"/> is <see cref="KeyframePolicy.LastReason"/>.
    /// GDI-only scale-mode fields (sm, caps, capc) are left null.
    /// </summary>
    public AgentFrameStats BuildFrameStats(EncodedFrame frame, SendWindow window, string captureMethod, double mailboxAgeMs, string lastKeyReason)
    {
        lock (_gate)
        {
            bool haveRtt = window.RttMs > 0;
            return new AgentFrameStats
            {
                Cap = Round(frame.CaptureMs, 1),
                Enc = Round(frame.EncodeMs, 1),
                Kbps = Math.Round(_kbps),
                Q = frame.Quality,
                Mw = frame.Width,
                Ch = frame.ChangedTiles,
                Tt = frame.TotalTiles,
                Inf = window.InFlightCount,
                Cm = captureMethod,
                // Only reported once measured; the relay's adaptive quality treats it as a real sample.
                Rtt = haveRtt ? Math.Round(window.RttMs) : null,
                Brtt = haveRtt ? Math.Round(window.BaselineRttMs) : null,
                Win = Math.Round(window.WindowBytes / 1024),
                Sfps = Round(_sfps, 1),
                Dif = Round(frame.DiffMs, 1),
                Tick = Round(_tickMs, 1),
                Cfps = Round(_cfps, 1),
                Pfps = Round(_pfps, 1),
                Same = Round(_same, 1),
                Drop = Round(_drop, 1),
                Rd = Round(_rd, 1),
                Kf = Round(_kf, 1),
                Kr = lastKeyReason.Length > 0 ? lastKeyReason : null,
                Age = Math.Round(mailboxAgeMs),
                Snd = _lastSendMs >= 0 ? Math.Round(_lastSendMs) : null,
                Lps = Math.Round(_lps),
                Kreq = Round(_kreq, 1),
            };
        }
    }

    private static double Round(double v, int digits) => Math.Round(v, digits);
}
