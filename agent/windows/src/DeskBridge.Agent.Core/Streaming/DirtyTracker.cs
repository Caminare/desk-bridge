namespace DeskBridge.Agent.Core.Streaming;

/// <summary>
/// Accumulates per-capture dirty rects (e.g. from DXGI) since the frame that is the current diff reference.
/// <see cref="TileDiffer.Diff"/> only compares tiles inside its hint, so the hint must cover every change since
/// the reference, including captures whose frames were dropped before the sender took them.
/// Record and HintSinceReference run on the capture thread; Committed is called by the sender.
/// </summary>
public sealed class DirtyTracker
{
    /// <summary>More pending captures than this and the hint is not worth keeping (diff everything).</summary>
    public const int MaxPendingCaptures = 32;

    private readonly object _gate = new();
    private readonly List<(long Id, IReadOnlyList<PixelRect>? Rects)> _pending = new();
    private readonly List<PixelRect> _hint = new();
    private long _committed = -1;
    private long _resetAt = long.MinValue;

    /// <summary>Records the dirty rects of capture <paramref name="captureId"/> (ids increase); null = unknown.</summary>
    public void Record(long captureId, IReadOnlyList<PixelRect>? rects)
    {
        lock (_gate) _pending.Add((captureId, rects));
    }

    /// <summary>The frame from capture <paramref name="captureId"/> became the diff reference.</summary>
    public void Committed(long captureId)
    {
        lock (_gate)
        {
            if (captureId <= _committed) return;
            _committed = captureId;
            _pending.RemoveAll(p => p.Id <= captureId);
        }
    }

    /// <summary>Forgets everything (capture lost, size or monitor change) until a later capture is committed.</summary>
    public void Reset()
    {
        lock (_gate)
        {
            _resetAt = _pending.Count > 0 ? _pending[^1].Id : _committed;
            _pending.Clear();
        }
    }

    /// <summary>
    /// Union of the rects recorded after the reference's capture, or null when unknown (nothing committed yet,
    /// an unknown capture, a reset, or too many pending captures). The list is reused by the next call.
    /// </summary>
    public IReadOnlyList<PixelRect>? HintSinceReference()
    {
        lock (_gate)
        {
            if (_committed < 0 || _committed <= _resetAt || _pending.Count > MaxPendingCaptures) return null;
            _hint.Clear();
            foreach (var (_, rects) in _pending)
            {
                if (rects is null) return null;
                _hint.AddRange(rects);
            }
            return _hint;
        }
    }
}
