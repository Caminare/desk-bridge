using System.Buffers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Threading.Channels;

namespace DeskBridge.Agent.Core.Relay;

public sealed class RelayClient
{
    private const int ReceiveChunk = 16 * 1024;
    private const int CloseAuthFailed = 4401;
    private const int CloseReplaced = 4409;
    private const int CloseRevoked = 4403;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly RelayOptions _options;
    private readonly Func<RegistrationSnapshot> _snapshot;
    private readonly IHostSecretStore _secrets;
    private readonly IRelayTransportFactory _factory;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly Channel<RelayEvent> _events =
        Channel.CreateUnbounded<RelayEvent>(new UnboundedChannelOptions { SingleReader = true });
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private volatile IRelayTransport? _current;

    /// <param name="snapshot">Called on every (re)connect so registration reflects the current screen.</param>
    /// <param name="delay">Injectable for tests; defaults to Task.Delay.</param>
    public RelayClient(
        RelayOptions options,
        Func<RegistrationSnapshot> snapshot,
        IHostSecretStore secrets,
        IRelayTransportFactory factory,
        Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        _options = options;
        _snapshot = snapshot;
        _secrets = secrets;
        _factory = factory;
        _delay = delay ?? Task.Delay;
    }

    public ChannelReader<RelayEvent> Events => _events.Reader;

    public override string ToString() => nameof(RelayClient);

    public Task SendBinaryAsync(ReadOnlyMemory<byte> data, CancellationToken ct = default) =>
        SendAsync(data, binary: true, ct);

    public Task SendEventAsync(string eventName, object? payload, CancellationToken ct = default)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new { @event = eventName, payload }, Json);
        return SendAsync(bytes, binary: false, ct);
    }

    private async Task SendAsync(ReadOnlyMemory<byte> data, bool binary, CancellationToken ct)
    {
        await _sendLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // Read the transport under the lock: a send queued across a reconnect must not
            // reach the disposed socket of the previous connection.
            var transport = _current ?? throw new InvalidOperationException("Not connected to the relay.");
            await transport.SendAsync(data, binary, ct).ConfigureAwait(false);
        }
        finally
        {
            _sendLock.Release();
        }
    }

    /// <summary>
    /// Connects, registers and receives, reconnecting after each drop, until cancelled or until the
    /// relay revokes this host (4403), in which case the stored secret is cleared first.
    /// </summary>
    public async Task<RelayStopReason> RunAsync(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var retry = await RunConnectionAsync(ct).ConfigureAwait(false);
                if (retry is null) return RelayStopReason.Revoked;
                await _delay(retry.Value, ct).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        finally
        {
            _events.Writer.TryComplete();
        }
        return RelayStopReason.Cancelled;
    }

    /// <returns>Delay before the next attempt, or null when the host was revoked.</returns>
    private async Task<TimeSpan?> RunConnectionAsync(CancellationToken ct)
    {
        int? closeCode = null;
        var reason = "closed";
        var authRejected = false;
        IRelayTransport? transport = null;
        try
        {
            transport = _factory.Create();
            await transport.ConnectAsync(_options.RelayUri, ct).ConfigureAwait(false);
            _current = transport;
            await SendAsync(BuildRegister(), binary: false, ct).ConfigureAwait(false);

            var buffer = ArrayPool<byte>.Shared.Rent(ReceiveChunk);
            try
            {
                using var message = new MemoryStream();
                while (true)
                {
                    var r = await transport.ReceiveAsync(buffer.AsMemory(0, ReceiveChunk), ct).ConfigureAwait(false);
                    if (r.Kind == RelayMessageKind.Close)
                    {
                        closeCode = r.CloseCode;
                        reason = string.IsNullOrEmpty(r.CloseDescription) ? "closed by relay" : r.CloseDescription!;
                        break;
                    }
                    message.Write(buffer, 0, r.Count);
                    if (!r.EndOfMessage) continue;
                    if (r.Kind == RelayMessageKind.Text &&
                        HandleText(message.GetBuffer().AsSpan(0, (int)message.Length)))
                    {
                        authRejected = true;
                    }
                    message.SetLength(0);
                }
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(buffer);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            reason = ex.GetType().Name;
        }
        finally
        {
            _current = null;
            if (transport is not null)
            {
                try { await transport.DisposeAsync().ConfigureAwait(false); } catch { /* best effort */ }
            }
        }

        if (closeCode == CloseRevoked)
        {
            _secrets.Clear();
            _events.Writer.TryWrite(new DisconnectedEvent(reason, closeCode, false, true, TimeSpan.Zero, Revoked: true));
            return null;
        }

        var replaced = closeCode == CloseReplaced;
        authRejected |= closeCode == CloseAuthFailed;
        var retryIn = replaced || authRejected ? _options.AuthRejectedDelay : _options.RetryDelay;
        _events.Writer.TryWrite(new DisconnectedEvent(reason, closeCode, replaced, authRejected, retryIn));
        return retryIn;
    }

    private byte[] BuildRegister()
    {
        var s = _snapshot();
        var payload = new JsonObject
        {
            ["hostId"] = _options.HostId,
            ["name"] = _options.Name,
            ["groupLabel"] = _options.GroupLabel,
            ["os"] = s.Os,
            ["screenWidth"] = s.ScreenWidth,
            ["screenHeight"] = s.ScreenHeight,
            ["monitors"] = JsonSerializer.SerializeToNode(s.Monitors, Json),
            ["activeMonitor"] = s.ActiveMonitor,
            ["agentType"] = RelayOptions.AgentType,
        };
        var secret = _secrets.Load();
        if (!string.IsNullOrEmpty(secret)) payload["hostSecret"] = secret;
        var msg = new JsonObject { ["event"] = "host:register", ["payload"] = payload };
        return Encoding.UTF8.GetBytes(msg.ToJsonString());
    }

    /// <returns>True when the message was an auth rejection.</returns>
    private bool HandleText(ReadOnlySpan<byte> utf8)
    {
        try
        {
            using var doc = JsonDocument.Parse(utf8.ToArray());
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("event", out var ev) || ev.ValueKind != JsonValueKind.String)
                return false;
            var payload = root.TryGetProperty("payload", out var p) && p.ValueKind == JsonValueKind.Object
                ? p
                : default;
            var has = payload.ValueKind == JsonValueKind.Object;

            switch (ev.GetString())
            {
                case "host:registered":
                    if (Str(payload, "hostSecret") is { Length: > 0 } secret) _secrets.Save(secret);
                    _events.Writer.TryWrite(new RegisteredEvent(
                        Str(payload, "hostId") ?? _options.HostId,
                        Str(payload, "pairingCode") ?? "",
                        Str(payload, "pairingUrl") ?? "",
                        (int)(Num(payload, "controllerCount") ?? 0)));
                    break;
                case "host:controller_count":
                    _events.Writer.TryWrite(new ControllerCountEvent((int)(Num(payload, "count") ?? 0)));
                    break;
                case "host:frame_ack":
                    if (Num(payload, "seq") is { } seq)
                    {
                        var relay = has && payload.TryGetProperty("relay", out var rl) && rl.ValueKind == JsonValueKind.True;
                        _events.Writer.TryWrite(new FrameAckEvent(seq, relay));
                    }
                    break;
                case "host:keyframe_request":
                    _events.Writer.TryWrite(new KeyframeRequestEvent());
                    break;
                case "client:input":
                    if (has) _events.Writer.TryWrite(new InputEvent(payload.Clone()));
                    break;
                case "host:auth_error":
                    _events.Writer.TryWrite(new AuthErrorEvent(Str(payload, "error") ?? "Authentication failed"));
                    return true;
            }
        }
        catch (JsonException)
        {
        }
        return false;
    }

    private static string? Str(JsonElement payload, string name) =>
        payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(name, out var v) &&
        v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static long? Num(JsonElement payload, string name) =>
        payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(name, out var v) &&
        v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : null;
}
