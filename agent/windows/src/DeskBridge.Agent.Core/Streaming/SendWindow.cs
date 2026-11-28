namespace DeskBridge.Agent.Core.Streaming;

/// <summary>
/// One send-to-ack round trip, the size of the frame it measured, and the bytes in flight when it was sent
/// (itself included): a small frame queued behind a large one waits for that one too.
/// </summary>
public readonly record struct RttSample(long Seq, int Bytes, double SampleMs, long InFlightBytesAtSend);

/// <summary>
/// Delay-based send pacing, ported from the PowerShell agent's send loop and tuned against a simulated path
/// (<c>SendWindowPathTests</c>). The window (in bytes) grows while frames are not queuing anywhere on the
/// path (controller included: acks come after draw) and the window was actually in use; when queuing passes
/// <see cref="CutAboveQueueMs"/> it is resized from what the path just delivered, so the standing queue stays
/// near <see cref="TargetQueueMs"/> instead of seconds. Path acks are cumulative, relay acks are not. Pure logic:
/// the caller passes the current time in milliseconds from any monotonic clock. Not thread safe.
/// </summary>
public sealed class SendWindow
{
    // About one frame: a slow path is never flooded before its first ack; growth doubles it per round trip.
    public const int InitialBytes = MinBytes;
    public const int MaxBytes = 8388608;
    // Small enough not to queue seconds on a slow phone path (128 KB was ~2.5 s at 50 KB/s); a frame may
    // always go out when nothing is in flight, so a large keyframe still goes.
    public const int MinBytes = 16384;
    public const double GrowBelowQueueMs = 100;
    public const double CutAboveQueueMs = 250;
    public const double TargetQueueMs = 100;
    public const long BaselineWindowMs = 15000;
    public const long MinStallMs = 5000;

    private readonly record struct Sent(long Seq, long At, int Bytes, long InFlightBytesAtSend);

    private readonly LinkedList<Sent> _inFlight = new();
    private long _inFlightBytes;
    private double _budget = InitialBytes;
    private bool _probing = true;
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
    /// Whether a frame of <paramref name="nextBytes"/> may be sent now: always when nothing is in flight,
    /// otherwise while below the frame cap and the frame fits in the byte window (on a slow path a second
    /// frame behind the first doubles its delay). Also frees the window when acks stopped arriving (the oldest
    /// frame has waited longer than max(5 s, 3 x RTT), e.g. a controller vanished mid-frame). A path that only
    /// slowed down still holds those frames, so the escape also halves the window instead of refilling it.
    /// </summary>
    public bool CanSend(long nowMs, int nextBytes = 0)
    {
        if (_inFlight.Count > 0 && nowMs - _inFlight.First!.Value.At > Math.Max(MinStallMs, 3 * _rttMs))
        {
            Reset();
            _budget = Math.Max(MinBytes, _budget * 0.5);
        }
        return _inFlight.Count == 0 || (_inFlight.Count < MaxInFlight && _inFlightBytes + nextBytes <= _budget);
    }

    public void OnSent(long seq, int bytes, long nowMs)
    {
        _inFlightBytes += bytes;
        _inFlight.AddLast(new Sent(seq, nowMs, bytes, _inFlightBytes));
    }

    /// <summary>
    /// A path ack (from a controller) is cumulative: it frees every frame up to <paramref name="seq"/>, and for
    /// a frame still in flight it is an RTT sample that drives the window. A relay ack (<paramref name="isRelay"/>:
    /// the relay could not deliver that one frame) frees only that frame, since earlier ones may still be on
    /// their way to the controller, and says nothing about the path.
    /// Returns the sample with the acked frame's size, or null when the ack was not one.
    /// </summary>
    public RttSample? OnAck(long seq, bool isRelay, long nowMs)
    {
        if (isRelay)
        {
            for (LinkedListNode<Sent>? n = _inFlight.First; n is not null; n = n.Next)
            {
                if (n.Value.Seq != seq) continue;
                _inFlightBytes -= n.Value.Bytes;
                _inFlight.Remove(n);
                break;
            }
            return null;
        }
        Sent? acked = null;
        while (_inFlight.First is { } first && first.Value.Seq <= seq)
        {
            _inFlightBytes -= first.Value.Bytes;
            if (first.Value.Seq == seq) acked = first.Value;
            _inFlight.RemoveFirst();
        }
        if (_inFlightBytes < 0) _inFlightBytes = 0;
        if (acked is not { } a) return null;
        double sample = nowMs - a.At;
        Sample(sample, a, nowMs);
        return new RttSample(a.Seq, a.Bytes, sample, a.InFlightBytesAtSend);
    }

    /// <summary>Forgets everything in flight (controller count changed, or acks stopped). Window size and RTT are kept.</summary>
    public void Reset()
    {
        _inFlight.Clear();
        _inFlightBytes = 0;
    }

    private void Sample(double sample, Sent acked, long now)
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
        if (queueMs > CutAboveQueueMs)
        {
            // What the path delivered while this frame was in flight, scaled to baseline + target queue. Every
            // frame sent before the cut implies about the same size, so repeated cuts do not compound. Never
            // used to grow: for a frame sent alone it includes the propagation delay and underestimates.
            double delivered = acked.InFlightBytesAtSend / Math.Max(1, sample) * (_baseRttMs + TargetQueueMs);
            _budget = Math.Max(MinBytes, Math.Min(_budget, delivered));
            _probing = false;
        }
        else if (queueMs < GrowBelowQueueMs && acked.InFlightBytesAtSend >= _budget / 2)
        {
            // Only a window that was in use proves the path can carry more: small frames acked quickly on a
            // quiet screen grew the old window to 8 MB within seconds, and the next burst queued seconds.
            // Until the first cut, grow by what was acked (doubling per round trip); then gently.
            _budget = Math.Min(MaxBytes, _budget + (_probing ? acked.Bytes : Math.Max(4096, acked.Bytes * 0.25)));
        }
    }
}
