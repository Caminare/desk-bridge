namespace DeskBridge.Agent.Core.Streaming;

/// <summary>
/// Delay-based send pacing, ported from the PowerShell agent's send loop. The window (in bytes) grows while
/// frames are not queuing anywhere on the path and shrinks when they are; acks are cumulative. Pure logic:
/// the caller passes the current time in milliseconds from any monotonic clock. Not thread safe.
/// </summary>
public sealed class SendWindow
{
    public const int InitialBytes = 262144;
    public const int MaxBytes = 8388608;
    public const int MinBytes = 131072;
    public const double GrowBelowQueueMs = 100;
    public const double CutAboveQueueMs = 250;
    public const long BaselineWindowMs = 15000;
    public const long MinStallMs = 1500;

    private readonly record struct Sent(long Seq, long At, int Bytes);

    private readonly Queue<Sent> _inFlight = new();
    private long _inFlightBytes;
    private double _budget = InitialBytes;
    private long _lastCutAt;
    private double _rttMs;
    private double _baseRttMs;
    private double _winMinRtt;
    private long _winStart;

    public SendWindow(int maxInFlight = 32)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(maxInFlight, 1);
        MaxInFlight = maxInFlight;
    }

    public int MaxInFlight { get; }
    /// <summary>Smoothed send-to-ack round trip, ms; 0 until measured.</summary>
    public double RttMs => _rttMs;
    /// <summary>Path baseline (minimum RTT over the recent windows), ms; 0 until measured.</summary>
    public double BaselineRttMs => _baseRttMs;
    /// <summary>Current window in bytes.</summary>
    public double WindowBytes => _budget;
    public int InFlightCount => _inFlight.Count;
    public long InFlightBytes => _inFlightBytes;

    /// <summary>
    /// Whether a frame may be sent now: always when nothing is in flight, otherwise while below both the
    /// frame cap and the byte window. Also frees the window when acks stopped arriving (the oldest frame has
    /// waited longer than max(1.5 s, 3 x RTT), e.g. a controller vanished mid-frame).
    /// The size of the next frame is not considered: like the PowerShell agent, the window is checked
    /// before the frame is taken, so one frame may overshoot it.
    /// </summary>
    public bool CanSend(long nowMs)
    {
        if (_inFlight.Count > 0 && nowMs - _inFlight.Peek().At > Math.Max(MinStallMs, 3 * _rttMs)) Reset();
        return _inFlight.Count == 0 || (_inFlight.Count < MaxInFlight && _inFlightBytes < _budget);
    }

    public void OnSent(long seq, int bytes, long nowMs)
    {
        _inFlight.Enqueue(new Sent(seq, nowMs, bytes));
        _inFlightBytes += bytes;
    }

    /// <summary>
    /// Cumulative ack: frees every frame up to <paramref name="seq"/>. An ack from the path (not
    /// <paramref name="isRelay"/>) for a frame still in flight is an RTT sample and drives the window.
    /// Relay acks (the frame reached no controller) free the window but say nothing about the path.
    /// </summary>
    public void OnAck(long seq, bool isRelay, long nowMs)
    {
        bool found = false;
        long sentAt = 0;
        while (_inFlight.Count > 0 && _inFlight.Peek().Seq <= seq)
        {
            Sent s = _inFlight.Dequeue();
            _inFlightBytes -= s.Bytes;
            if (s.Seq == seq) { found = true; sentAt = s.At; }
        }
        if (_inFlightBytes < 0) _inFlightBytes = 0;
        if (found && !isRelay) Sample(nowMs - sentAt, nowMs);
    }

    /// <summary>Forgets everything in flight (controller count changed, or acks stopped). Window size and RTT are kept.</summary>
    public void Reset()
    {
        _inFlight.Clear();
        _inFlightBytes = 0;
    }

    private void Sample(double sample, long now)
    {
        _rttMs = _rttMs <= 0 ? sample : 0.7 * _rttMs + 0.3 * sample;
        // Baseline = lowest RTT of the current/previous 15 s window: the path latency without queuing.
        // Rolling windows let it follow a path that got slower for good.
        if (now - _winStart >= BaselineWindowMs)
        {
            if (_winMinRtt > 0) _baseRttMs = _winMinRtt;
            _winMinRtt = 0;
            _winStart = now;
        }
        if (_winMinRtt <= 0 || sample < _winMinRtt) _winMinRtt = sample;
        if (_baseRttMs <= 0 || sample < _baseRttMs) _baseRttMs = sample;

        double queueMs = _rttMs - _baseRttMs;
        if (queueMs < GrowBelowQueueMs)
        {
            _budget = Math.Min(MaxBytes, _budget + Math.Max(16384, _budget * 0.1));
        }
        else if (queueMs > CutAboveQueueMs && now - _lastCutAt > _rttMs)
        {
            _budget = Math.Max(MinBytes, _budget * 0.7);
            _lastCutAt = now;
        }
    }
}
