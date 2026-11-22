using DeskBridge.Agent.Core.Cursor;
using DeskBridge.Agent.Core.Relay;
using DeskBridge.Agent.Core.Streaming;

namespace DeskBridge.Agent.Core.Displays;

/// <summary>
/// Frame source for "the monitor the controller picked". Owns the monitor list and the per-monitor
/// source, and swaps that source on the capture thread when the controller switches monitors or the
/// display configuration changes (monitor unplugged, docking, resolution change).
/// </summary>
/// <remarks>
/// Switches and refreshes are requested from any thread and applied at the start of the next
/// <see cref="TryCapture"/>. A capture that swapped the source returns <see cref="CaptureStatus.Lost"/>,
/// so the engine drops its reference and the new monitor starts with a keyframe.
/// </remarks>
public sealed class SwitchableFrameSource : IFrameSource
{
    private const int NoRequest = -1;

    private readonly Func<IReadOnlyList<DisplayInfo>> _enumerate;
    private readonly Func<DisplayInfo, IFrameSource> _create;
    private readonly Action<string> _log;
    private readonly object _gate = new();
    private readonly MonitorSelector _selector; // guarded by _gate

    private volatile IFrameSource _inner;
    private volatile DisplayInfo _active;
    private int _requestedIndex = NoRequest;
    private volatile bool _refreshRequested;
    private bool _notifyPending; // capture thread only
    private volatile bool _drawCursor = true;

    /// <param name="enumerate">Lists the monitors; must not return an empty list at startup.</param>
    /// <param name="create">Creates the source for one monitor; may throw when the monitor is gone.</param>
    public SwitchableFrameSource(Func<IReadOnlyList<DisplayInfo>> enumerate, Func<DisplayInfo, IFrameSource> create, Action<string>? log = null)
    {
        _enumerate = enumerate;
        _create = create;
        _log = log ?? (_ => { });
        _selector = new MonitorSelector(enumerate());
        _active = _selector.Active;
        _inner = create(_active);
    }

    public CursorSnapshot Cursor => _inner.Cursor;

    public bool DrawCursor
    {
        get => _drawCursor;
        set
        {
            _drawCursor = value;
            _inner.DrawCursor = value;
        }
    }

    /// <summary>Raised on the capture thread after the monitor list or the streamed monitor changed; send <see cref="Update"/>.</summary>
    public event Action? DisplaysChanged;

    public string Method => _inner.Method;

    public (int Width, int Height) SourceSize => _inner.SourceSize;

    /// <summary>The monitor being captured. Input maps onto its bounds. Safe from any thread.</summary>
    public DisplayInfo Active => _active;

    /// <summary>Asks for monitor <paramref name="index"/> (wire index); an unknown index means the primary. Safe from any thread.</summary>
    public void RequestMonitor(int index)
    {
        Volatile.Write(ref _requestedIndex, Math.Max(index, 0));
        _refreshRequested = true;
    }

    /// <summary>Re-reads the monitor list on the next capture, e.g. after reconnecting to the relay. Safe from any thread.</summary>
    public void RequestRefresh() => _refreshRequested = true;

    /// <summary>Registration data for the current selection. Safe from any thread.</summary>
    public RegistrationSnapshot Snapshot(string os)
    {
        lock (_gate) return _selector.Snapshot(os);
    }

    /// <summary><c>host:update</c> payload for the current selection. Safe from any thread.</summary>
    public HostUpdatePayload Update()
    {
        lock (_gate) return _selector.Update();
    }

    public CaptureResult TryCapture(int targetWidth, int targetHeight, TimeSpan timeout, bool forceFrame)
    {
        if (_refreshRequested && Reconcile()) return Lost();

        CaptureResult result = _inner.TryCapture(targetWidth, targetHeight, timeout, forceFrame);
        if (result.Status == CaptureStatus.Lost)
        {
            // Display changes surface as lost duplication; so do lock screens, which change nothing here.
            Reconcile();
        }
        return result;
    }

    /// <returns>True when the caller must report Lost: the source was replaced, or replacing it failed.</returns>
    private bool Reconcile()
    {
        _refreshRequested = false;
        int requested = Interlocked.Exchange(ref _requestedIndex, NoRequest);
        IReadOnlyList<DisplayInfo> displays = _enumerate();

        DisplayInfo target;
        lock (_gate)
        {
            if (_selector.Refresh(displays)) _notifyPending = true;
            if (requested != NoRequest && _selector.Select(requested)) _notifyPending = true;
            target = _selector.Active;
        }

        bool replaced = false;
        if (target != _active)
        {
            IFrameSource next;
            try
            {
                next = _create(target);
            }
            catch (Exception ex)
            {
                _log($"Could not capture {target.DeviceName}: {ex.Message}");
                lock (_gate) RevertTo(_active);
                // Try again on the next capture.
                if (requested != NoRequest) Interlocked.CompareExchange(ref _requestedIndex, requested, NoRequest);
                _refreshRequested = true;
                return true;
            }
            next.DrawCursor = _drawCursor;
            IFrameSource old = _inner;
            _inner = next;
            // A setter that ran during the swap may have reached only the old source.
            next.DrawCursor = _drawCursor;
            _active = target;
            old.Dispose();
            replaced = true;
        }

        if (_notifyPending)
        {
            _notifyPending = false;
            DisplaysChanged?.Invoke();
        }
        return replaced;
    }

    // Keeps the reported selection on the monitor still being captured, when it is still listed.
    private void RevertTo(DisplayInfo current)
    {
        for (int i = 0; i < _selector.Displays.Count; i++)
        {
            if (_selector.Displays[i].DeviceName == current.DeviceName)
            {
                _selector.Select(i);
                return;
            }
        }
    }

    private static CaptureResult Lost() => new(CaptureStatus.Lost, default, null, 0);

    public void Dispose() => _inner.Dispose();
}
