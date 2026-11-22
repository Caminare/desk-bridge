namespace DeskBridge.Agent.Core.Cursor;

/// <summary>
/// Decides which cursor messages to send. The capture thread reports every pointer snapshot; the
/// sender takes what is due. Each shape is sent once per connection (the relay and controllers keep
/// the recent ones), so animated cursors cost nothing after their first cycle. Positions are
/// latest-wins and throttled, because a backlog of stale positions is worse than skipping them.
/// </summary>
/// <remarks>Thread-safe: <see cref="Update"/> and <see cref="TryTake"/> run on different threads.</remarks>
public sealed class CursorPublisher
{
    /// <summary>At most one position per this many ms (about 60 Hz).</summary>
    public const int MinPositionIntervalMs = 16;

    /// <summary>Shapes remembered as sent; matches the relay's and controller's shape caches.</summary>
    public const int SentShapeMemory = 32;

    private readonly object _gate = new();
    private readonly LinkedList<string> _sentShapes = new(); // most recent last
    private CursorPositionMessage? _lastPosition;
    private CursorShapeData? _pendingShape;
    private CursorPositionMessage? _pendingPosition;
    private long _lastPositionSentAt = long.MinValue / 2;

    /// <summary>Raised (on the updating thread) when a new message became pending.</summary>
    public event Action? Pending;

    /// <param name="monitorWidth">Physical width of the streamed monitor, for normalizing.</param>
    /// <returns>True when the cursor moved or changed, i.e. the user is active and capture should stay fast.</returns>
    public bool Update(CursorSnapshot snapshot, int monitorWidth, int monitorHeight)
    {
        if (monitorWidth <= 0 || monitorHeight <= 0) return false;
        bool signal = false;
        lock (_gate)
        {
            if (snapshot.Shape is { } shape && RememberShape(shape.Id))
            {
                _pendingShape = shape;
                signal = true;
            }
            var position = new CursorPositionMessage(
                Math.Round(snapshot.X / (double)monitorWidth, 5),
                Math.Round(snapshot.Y / (double)monitorHeight, 5),
                snapshot.Visible,
                snapshot.Shape?.Id);
            if (position != _lastPosition)
            {
                _pendingPosition = position;
                _lastPosition = position;
                signal = true;
            }
        }
        if (signal) Pending?.Invoke();
        return signal;
    }

    // True when the id was not sent recently; marks it as the most recent either way.
    private bool RememberShape(string id)
    {
        LinkedListNode<string>? node = _sentShapes.Find(id);
        if (node is not null)
        {
            _sentShapes.Remove(node);
            _sentShapes.AddLast(node);
            return false;
        }
        _sentShapes.AddLast(id);
        if (_sentShapes.Count > SentShapeMemory) _sentShapes.RemoveFirst();
        return true;
    }

    /// <summary>
    /// Takes the messages due at <paramref name="nowMs"/>. A pending shape is always due and brings the
    /// pending position with it, so the controller never draws a position with an unknown shape.
    /// </summary>
    public bool TryTake(long nowMs, out CursorShapeData? shape, out CursorPositionMessage? position)
    {
        lock (_gate)
        {
            shape = _pendingShape;
            bool positionDue = _pendingPosition is not null &&
                               (shape is not null || nowMs - _lastPositionSentAt >= MinPositionIntervalMs);
            position = positionDue ? _pendingPosition : null;
            _pendingShape = null;
            if (positionDue)
            {
                _pendingPosition = null;
                _lastPositionSentAt = nowMs;
            }
            return shape is not null || position is not null;
        }
    }

    /// <summary>Milliseconds until something is due: 0 now, <see cref="Timeout.Infinite"/> when nothing is pending.</summary>
    public int DelayUntilDue(long nowMs)
    {
        lock (_gate)
        {
            if (_pendingShape is not null) return 0;
            if (_pendingPosition is null) return Timeout.Infinite;
            return (int)Math.Max(0, _lastPositionSentAt + MinPositionIntervalMs - nowMs);
        }
    }

    /// <summary>Forgets what was sent (a new relay connection has no cached cursor), so the next update resends everything.</summary>
    public void Reset()
    {
        lock (_gate)
        {
            _sentShapes.Clear();
            _lastPosition = null;
            _pendingShape = null;
            _pendingPosition = null;
            _lastPositionSentAt = long.MinValue / 2;
        }
    }
}
