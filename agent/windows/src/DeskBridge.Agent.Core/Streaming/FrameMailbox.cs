namespace DeskBridge.Agent.Core.Streaming;

/// <summary>
/// Single slot holding the freshest unsent frame. A newer frame replaces an unsent one. Taking a frame
/// commits its snapshot as the diff reference under the same lock, like TryTakeFrame in the PowerShell agent,
/// so the capture thread can tell (by generation) that a diff went stale. Thread safe.
/// </summary>
public sealed class FrameMailbox
{
    private readonly TileDiffer _differ;
    private readonly object _gate = new();
    private EncodedFrame? _pending;
    private long _postedAt;
    private long _dropped;

    public FrameMailbox(TileDiffer differ) => _differ = differ;

    /// <summary>Frames replaced before the sender took them, since creation.</summary>
    public long Dropped => Interlocked.Read(ref _dropped);

    public bool HasPending { get { lock (_gate) return _pending is not null; } }

    /// <summary>
    /// Posts <paramref name="frame"/>. Returns false (frame not stored, caller keeps ownership) when it was
    /// diffed against a reference that has since moved on: diff and encode again. Otherwise stores it;
    /// <paramref name="replaced"/> is the unsent frame it displaced (release it), or null.
    /// </summary>
    public bool Post(EncodedFrame frame, long nowMs, out EncodedFrame? replaced)
    {
        lock (_gate)
        {
            replaced = null;
            if (frame.Generation != _differ.Generation) return false;
            replaced = _pending;
            if (replaced is not null) Interlocked.Increment(ref _dropped);
            _pending = frame;
            _postedAt = nowMs;
            return true;
        }
    }

    /// <summary>
    /// Hands the pending frame to the sender and commits its pixels as the reference. <paramref name="ageMs"/> is
    /// the time it waited here (stats <c>age</c>). A frame made stale since posting (reference invalidated) is
    /// released and not returned.
    /// </summary>
    public bool TryTake(long nowMs, out EncodedFrame? frame, out double ageMs)
    {
        lock (_gate)
        {
            frame = _pending;
            ageMs = 0;
            if (frame is null) return false;
            _pending = null;
            if (frame.Snapshot is null || !_differ.Commit(frame.Snapshot))
            {
                frame.Release();
                frame = null;
                return false;
            }
            frame.Snapshot = null; // now owned by the differ
            ageMs = nowMs - _postedAt;
            return true;
        }
    }

    /// <summary>
    /// The screen matched the reference again: a pending delta computed against <paramref name="generation"/> is
    /// obsolete. Removes and returns it (release it); keyframes are kept. Null when nothing was removed.
    /// </summary>
    public EncodedFrame? DiscardPendingDelta(int generation)
    {
        lock (_gate)
        {
            if (_pending is { Key: false } p && p.Generation == generation)
            {
                _pending = null;
                return p;
            }
            return null;
        }
    }

    /// <summary>Removes and returns the pending frame without committing it (shutdown, monitor switch); release it.</summary>
    public EncodedFrame? Clear()
    {
        lock (_gate)
        {
            EncodedFrame? p = _pending;
            _pending = null;
            return p;
        }
    }
}
