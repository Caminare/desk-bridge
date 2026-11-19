using System.Buffers;
using System.Diagnostics;
using System.Text.Json;
using DeskBridge.Agent.Core.Relay;

namespace DeskBridge.Agent.Core.Streaming;

/// <summary>Stream settings that the relay's adaptive <c>quality</c> input can change.</summary>
public sealed record StreamSettings(int MaxWidth = 1152, int JpegQuality = 62, int IdleIntervalMs = 100);

/// <summary>
/// Wires capture, diff, encode, mailbox and pacing to a <see cref="RelayClient"/>, following the PowerShell
/// agent's pipeline: a dedicated capture thread produces frames into a single-slot mailbox; a sender loop takes
/// the freshest frame when the delay-based window allows; relay events (acks, keyframe requests, controller
/// count, input) are handled on their own loop so input never waits for capture or send.
/// </summary>
public sealed class StreamingEngine : IDisposable
{
    private readonly RelayClient _relay;
    private readonly IFrameSource _source;
    private readonly ITileEncoder _encoder;
    private readonly Action<JsonElement> _onInput;
    private readonly Action<string> _log;

    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly TileDiffer _differ = new();
    private readonly RegionMerger _merger = new();
    private readonly KeyframePolicy _keys = new();
    private readonly FrameAssembler _assembler = new();
    private readonly FrameMailbox _mailbox;
    private readonly SendWindow _window = new();
    private readonly CaptureScheduler _scheduler;
    private readonly StatsCollector _stats = new();
    private readonly DirtyTracker _dirty = new();

    private readonly AutoResetEvent _captureWake = new(false);
    private readonly SemaphoreSlim _sendWake = new(0, int.MaxValue);
    private readonly object _windowGate = new();

    private volatile StreamSettings _settings;
    private volatile bool _streaming;
    private volatile bool _stopping;
    private Thread? _captureThread;

    public StreamingEngine(RelayClient relay, IFrameSource source, ITileEncoder encoder, StreamSettings settings,
        Action<JsonElement> onInput, Action<string> log)
    {
        _relay = relay;
        _source = source;
        _encoder = encoder;
        _settings = settings;
        _onInput = onInput;
        _log = log;
        _mailbox = new FrameMailbox(_differ);
        _scheduler = new CaptureScheduler(settings.IdleIntervalMs);
    }

    private long Now => _clock.ElapsedMilliseconds;

    /// <summary>Call after each applied input: captures at the fast rate and soon, so the result shows quickly.</summary>
    public void NotifyInputApplied()
    {
        _scheduler.NotifyInput(Now);
        _captureWake.Set();
    }

    /// <summary>Runs the relay connection, the event loop, the capture thread and the sender until cancelled.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        _captureThread = new Thread(CaptureLoop) { IsBackground = true, Name = "DeskBridge capture" };
        _captureThread.Start();
        try
        {
            await Task.WhenAll(_relay.RunAsync(ct), EventLoopAsync(ct), SendLoopAsync(ct)).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        finally
        {
            _stopping = true;
            _captureWake.Set();
            _captureThread.Join(TimeSpan.FromSeconds(2));
        }
    }

    // ---- Relay events ----

    private async Task EventLoopAsync(CancellationToken ct)
    {
        await foreach (RelayEvent ev in _relay.Events.ReadAllAsync(ct).ConfigureAwait(false))
        {
            switch (ev)
            {
                case RegisteredEvent r:
                    _log($"Online as {r.HostId}. Pairing code {r.PairingCode}  {r.PairingUrl}");
                    break;
                case ControllerCountEvent c:
                    SetStreaming(c.Count > 0);
                    _log(c.Count > 0 ? $"{c.Count} controller(s) connected, streaming." : "No controllers, capture paused.");
                    break;
                case FrameAckEvent a:
                    lock (_windowGate) _window.OnAck(a.Seq, a.IsRelayAck, Now);
                    _sendWake.Release();
                    break;
                case KeyframeRequestEvent:
                    _stats.RecordKeyRequest();
                    RequestKeyframe();
                    break;
                case InputEvent i:
                    HandleInput(i.Payload);
                    break;
                case AuthErrorEvent e:
                    _log($"Relay rejected this agent: {e.Message}");
                    break;
                case DisconnectedEvent d:
                    SetStreaming(false);
                    _log($"Disconnected ({d.Reason}{(d.CloseCode is { } code ? $", {code}" : "")}). Retrying in {d.RetryIn.TotalSeconds:0}s."
                         + (d.Replaced ? " Another agent registered with this host id." : ""));
                    break;
            }
        }
    }

    private void SetStreaming(bool on)
    {
        lock (_windowGate) _window.Reset();
        _mailbox.Clear()?.Release();
        _streaming = on;
        if (on)
        {
            _stats.ResetWindow(Now);
            RequestKeyframe();
        }
        _captureWake.Set();
        _sendWake.Release();
    }

    private void RequestKeyframe()
    {
        _keys.RequestKeyframe();
        _scheduler.RequestImmediate(Now);
        _captureWake.Set();
    }

    private void HandleInput(JsonElement payload)
    {
        if (payload.TryGetProperty("type", out JsonElement type) && type.ValueKind == JsonValueKind.String &&
            type.GetString() == "quality")
        {
            StreamSettings s = _settings;
            int mw = payload.TryGetProperty("maxWidth", out JsonElement m) && m.TryGetInt32(out int mwv) ? mwv : s.MaxWidth;
            int q = payload.TryGetProperty("jpegQuality", out JsonElement j) && j.TryGetInt32(out int qv) ? qv : s.JpegQuality;
            _settings = s with { MaxWidth = Math.Clamp(mw, StreamSizer.MinWidth, 3840), JpegQuality = Math.Clamp(q, 30, 95) };
            return;
        }
        _onInput(payload);
    }

    // ---- Sender ----

    private async Task SendLoopAsync(CancellationToken ct)
    {
        var buffer = new ArrayBufferWriter<byte>(256 * 1024);
        long seq = 0;
        while (!ct.IsCancellationRequested)
        {
            // Woken by new frames and acks; the timeout covers the stall escape and the stats window.
            await _sendWake.WaitAsync(50, ct).ConfigureAwait(false);
            long now = Now;
            _stats.RecordLoop();
            _stats.Update(now);
            if (!_streaming) continue;

            EncodedFrame? frame;
            double age;
            lock (_windowGate)
            {
                if (!_window.CanSend(now)) continue;
            }
            if (!_mailbox.TryTake(now, out frame, out age) || frame is null) continue;

            try
            {
                _dirty.Committed(frame.CaptureId);
                if (frame.Key) _keys.MarkSatisfied(frame.KeyToken);
                seq++;
                buffer.ResetWrittenCount();
                lock (_windowGate)
                {
                    var stats = _stats.BuildFrameStats(frame, _window, _source.Method, age, _keys.LastReason);
                    _assembler.Write(frame, seq, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), stats, buffer);
                    _window.OnSent(seq, buffer.WrittenCount, now);
                }
                _stats.RecordSent(buffer.WrittenCount);
                long t0 = Now;
                await _relay.SendBinaryAsync(buffer.WrittenMemory, ct).ConfigureAwait(false);
                _stats.RecordSendDuration(Now - t0);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                // Connection dropped mid-send; the relay client reconnects and resets streaming.
                _log($"Send failed: {ex.GetType().Name}");
            }
            finally
            {
                frame.Release();
            }
            // More may be ready (window still open, frame posted meanwhile).
            if (_mailbox.HasPending) _sendWake.Release();
        }
    }

    // ---- Capture thread ----

    private void CaptureLoop()
    {
        long captureId = 0;
        (int W, int H) lastSize = (0, 0);
        while (!_stopping)
        {
            if (!_streaming)
            {
                _captureWake.WaitOne(500);
                continue;
            }
            long now = Now;
            long due = _scheduler.NextDue(now);
            if (now < due)
            {
                _captureWake.WaitOne((int)Math.Min(due - now, 500));
                continue;
            }
            _scheduler.OnCaptureStarted(now);
            try
            {
                CaptureOnce(++captureId, ref lastSize);
            }
            catch (Exception ex)
            {
                _log($"Capture error: {ex.GetType().Name}: {ex.Message}");
                _differ.Invalidate();
                _dirty.Reset();
                _captureWake.WaitOne(200);
            }
            _stats.RecordTick(Now - now);
        }
    }

    private void CaptureOnce(long captureId, ref (int W, int H) lastSize)
    {
        StreamSettings settings = _settings;
        _stats.RecordCapture();
        var (sw, sh) = _source.SourceSize;
        var (tw, th) = StreamSizer.Compute(settings.MaxWidth, sw, sh);
        if ((tw, th) != lastSize)
        {
            lastSize = (tw, th);
            _differ.Invalidate();
            _dirty.Reset();
        }

        KeyframeReason reason = _keys.Evaluate(_differ.HasReference);
        int token = _keys.RequestToken;
        CaptureResult res = _source.TryCapture(tw, th, TimeSpan.Zero, forceFrame: reason != KeyframeReason.None);
        if (res.Status == CaptureStatus.Lost)
        {
            _differ.Invalidate();
            _dirty.Reset();
            return;
        }
        if (res.Status == CaptureStatus.NoChange)
        {
            _stats.RecordUnchanged();
            return;
        }

        _dirty.Record(captureId, res.DirtyRects);
        long t0 = Now;
        DiffResult diff = _differ.Diff(res.Image, _dirty.HintSinceReference(), compare: reason == KeyframeReason.None);
        double diffMs = Now - t0;

        if (reason == KeyframeReason.None)
        {
            if (diff.ChangedCount == 0)
            {
                // Back to what the reference shows: a pending delta against it is obsolete.
                _stats.RecordUnchanged();
                _mailbox.DiscardPendingDelta(diff.Generation)?.Release();
                return;
            }
            _scheduler.NotifyScreenChange(Now);
            reason = KeyframePolicy.EvaluateAfterDiff(diff.ChangedCount, diff.TotalTiles);
        }

        bool key = reason != KeyframeReason.None;
        IReadOnlyList<PixelRect> regions = key ? [] : _merger.Merge(diff.Changed, diff.TilesX, diff.TilesY, res.Image.Width, res.Image.Height);
        EncodedFrame frame;
        try
        {
            frame = _assembler.Encode(res.Image, regions, key, _encoder, settings.JpegQuality);
        }
        catch
        {
            diff.Snapshot?.Release();
            throw;
        }
        frame.KeyReason = reason;
        frame.KeyToken = token;
        frame.ChangedTiles = key ? diff.TotalTiles : diff.ChangedCount;
        frame.TotalTiles = diff.TotalTiles;
        frame.CaptureMs = res.CaptureMs;
        frame.DiffMs = diffMs;
        frame.Generation = diff.Generation;
        frame.Snapshot = diff.Snapshot;
        frame.CaptureId = captureId;

        if (!_mailbox.Post(frame, Now, out EncodedFrame? replaced))
        {
            // Diffed against a reference the sender has replaced meanwhile: capture again right away.
            _stats.RecordRediff();
            frame.Release();
            _scheduler.RequestImmediate(Now);
            return;
        }
        if (replaced is not null)
        {
            _stats.RecordDropped();
            replaced.Release();
        }
        _stats.RecordProduced();
        if (key)
        {
            _keys.NoteKeyframe(reason);
            _stats.RecordKeyframe();
        }
        _sendWake.Release();
    }

    public void Dispose()
    {
        _captureWake.Dispose();
        _sendWake.Dispose();
    }
}
