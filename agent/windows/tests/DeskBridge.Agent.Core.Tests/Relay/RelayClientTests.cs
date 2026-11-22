using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using DeskBridge.Agent.Core.Relay;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Relay;

public class RelayClientTests
{
    private const string Secret = "host-secret-abc";

    private sealed class FakeTransport : IRelayTransport
    {
        private readonly Channel<(TransportReceiveResult Result, byte[] Data)> _incoming =
            Channel.CreateUnbounded<(TransportReceiveResult, byte[])>();
        private int _inSend;

        public ConcurrentQueue<(bool Binary, byte[] Data)> Sent { get; } = new();
        public int MaxConcurrentSends { get; private set; }
        public bool SendDelay { get; set; }
        public bool Connected { get; private set; }

        public Task ConnectAsync(Uri uri, CancellationToken ct)
        {
            Connected = true;
            return Task.CompletedTask;
        }

        public async ValueTask SendAsync(ReadOnlyMemory<byte> data, bool binary, CancellationToken ct)
        {
            var now = Interlocked.Increment(ref _inSend);
            MaxConcurrentSends = Math.Max(MaxConcurrentSends, now);
            if (SendDelay) await Task.Delay(15, ct);
            Sent.Enqueue((binary, data.ToArray()));
            Interlocked.Decrement(ref _inSend);
        }

        public async ValueTask<TransportReceiveResult> ReceiveAsync(Memory<byte> buffer, CancellationToken ct)
        {
            var (result, data) = await _incoming.Reader.ReadAsync(ct);
            data.CopyTo(buffer);
            return result with { Count = data.Length };
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;

        public void PushText(string json, int fragments = 1)
        {
            var bytes = Encoding.UTF8.GetBytes(json);
            var size = (int)Math.Ceiling(bytes.Length / (double)fragments);
            for (var i = 0; i < bytes.Length; i += size)
            {
                var chunk = bytes[i..Math.Min(bytes.Length, i + size)];
                _incoming.Writer.TryWrite((new TransportReceiveResult(0, i + size >= bytes.Length, RelayMessageKind.Text), chunk));
            }
        }

        public void PushClose(int? code, string desc = "") =>
            _incoming.Writer.TryWrite((new TransportReceiveResult(0, true, RelayMessageKind.Close, code, desc), []));

        public JsonElement RegisterPayload() =>
            JsonDocument.Parse(Sent.First(s => !s.Binary).Data).RootElement.GetProperty("payload");
    }

    private sealed class FakeFactory : IRelayTransportFactory
    {
        public List<FakeTransport> Created { get; } = [];
        public bool SendDelay { get; set; }

        public IRelayTransport Create()
        {
            var t = new FakeTransport { SendDelay = SendDelay };
            lock (Created) Created.Add(t);
            return t;
        }

        public FakeTransport this[int i] => Created[i];
    }

    private sealed class Harness : IAsyncDisposable
    {
        private readonly CancellationTokenSource _cts = new(TimeSpan.FromSeconds(20));
        private readonly Task<RelayStopReason> _run;
        public FakeFactory Factory { get; } = new();
        public InMemoryHostSecretStore Secrets { get; }
        public List<TimeSpan> Delays { get; } = [];
        public RelayClient Client { get; }

        public Harness(string? storedSecret = null)
        {
            Secrets = new InMemoryHostSecretStore(storedSecret);
            var options = new RelayOptions(new Uri("wss://relay.example/ws"), "win-1234", "Desk", "Lab");
            Client = new RelayClient(
                options,
                () => new RegistrationSnapshot(
                    2560, 1440,
                    [new MonitorModel(0, 0, 0, 2560, 1440, true, "Main"), new MonitorModel(1, 2560, 0, 1920, 1080, false)],
                    1, "Windows 11"),
                Secrets,
                Factory,
                (d, _) =>
                {
                    lock (Delays) Delays.Add(d);
                    return Task.CompletedTask;
                });
            _run = Client.RunAsync(_cts.Token);
        }

        public async Task<FakeTransport> Transport(int i)
        {
            await WaitUntil(() => { lock (Factory.Created) return Factory.Created.Count > i && Factory[i].Sent.Count > 0; });
            return Factory[i];
        }

        public async Task<T> Next<T>() where T : RelayEvent
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            while (true)
            {
                var ev = await Client.Events.ReadAsync(timeout.Token);
                if (ev is T t) return t;
            }
        }

        public Task<RelayStopReason> Run => _run;

        public async ValueTask DisposeAsync()
        {
            await _cts.CancelAsync();
            await _run;
        }
    }

    private static async Task WaitUntil(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException("condition not met");
            await Task.Delay(5);
        }
    }

    [Fact]
    public async Task Register_payload_has_all_fields_and_omits_secret_when_none_stored()
    {
        await using var h = new Harness();
        var p = (await h.Transport(0)).RegisterPayload();

        Assert.Equal("win-1234", p.GetProperty("hostId").GetString());
        Assert.Equal("Desk", p.GetProperty("name").GetString());
        Assert.Equal("Lab", p.GetProperty("groupLabel").GetString());
        Assert.Equal("Windows 11", p.GetProperty("os").GetString());
        Assert.Equal(2560, p.GetProperty("screenWidth").GetInt32());
        Assert.Equal(1440, p.GetProperty("screenHeight").GetInt32());
        Assert.Equal(1, p.GetProperty("activeMonitor").GetInt32());
        Assert.Equal("windows-native", p.GetProperty("agentType").GetString());
        Assert.False(p.TryGetProperty("enrollKey", out _));
        Assert.False(p.TryGetProperty("hostSecret", out _));
        Assert.True(p.GetProperty("cursor").GetBoolean());

        var monitors = p.GetProperty("monitors");
        Assert.Equal(2, monitors.GetArrayLength());
        Assert.Equal(2560, monitors[1].GetProperty("x").GetInt32());
        Assert.True(monitors[0].GetProperty("primary").GetBoolean());
        Assert.Equal("Main", monitors[0].GetProperty("name").GetString());
        Assert.False(monitors[1].TryGetProperty("name", out _));
    }

    [Fact]
    public async Task Register_payload_includes_stored_secret()
    {
        await using var h = new Harness(Secret);
        var p = (await h.Transport(0)).RegisterPayload();
        Assert.Equal(Secret, p.GetProperty("hostSecret").GetString());
    }

    [Fact]
    public async Task Registered_with_secret_saves_it_and_without_does_not_overwrite()
    {
        await using var h = new Harness();
        var t = await h.Transport(0);
        t.PushText("""{"event":"host:registered","payload":{"hostId":"win-1234","pairingCode":"123456","pairingUrl":"https://x/?pair=123456","controllerCount":2,"hostSecret":"new-secret"}}""");
        var reg = await h.Next<RegisteredEvent>();
        Assert.Equal(new RegisteredEvent("win-1234", "123456", "https://x/?pair=123456", 2), reg);
        Assert.Equal("new-secret", h.Secrets.Load());

        t.PushText("""{"event":"host:registered","payload":{"hostId":"win-1234","pairingCode":"123456","pairingUrl":"u","controllerCount":0}}""");
        await h.Next<RegisteredEvent>();
        Assert.Equal("new-secret", h.Secrets.Load());
    }

    [Fact]
    public async Task Registered_reports_whether_the_relay_draws_the_cursor_on_controllers()
    {
        await using var h = new Harness(Secret);
        var t = await h.Transport(0);
        t.PushText("""{"event":"host:registered","payload":{"hostId":"win-1234","pairingCode":"1","pairingUrl":"u","controllerCount":0}}""");
        Assert.False((await h.Next<RegisteredEvent>()).ClientCursor);
        t.PushText("""{"event":"host:registered","payload":{"hostId":"win-1234","pairingCode":"1","pairingUrl":"u","controllerCount":0,"clientCursor":true}}""");
        Assert.True((await h.Next<RegisteredEvent>()).ClientCursor);
    }

    [Fact]
    public async Task Incoming_events_map_to_records()
    {
        await using var h = new Harness();
        var t = await h.Transport(0);
        t.PushText("""{"event":"host:controller_count","payload":{"count":3}}""");
        t.PushText("""{"event":"host:frame_ack","payload":{"seq":7}}""");
        t.PushText("""{"event":"host:frame_ack","payload":{"seq":8,"relay":true}}""");
        t.PushText("""{"event":"host:keyframe_request","payload":{}}""");
        t.PushText("""{"event":"client:input","payload":{"type":"click","x":0.5}}""");
        t.PushText("""{"event":"host:something_new","payload":{}}""");
        t.PushText("""{"event":"host:auth_error","payload":{"error":"nope"}}""");

        Assert.Equal(new ControllerCountEvent(3), await h.Next<ControllerCountEvent>());
        Assert.Equal(new FrameAckEvent(7, false), await h.Next<FrameAckEvent>());
        Assert.Equal(new FrameAckEvent(8, true), await h.Next<FrameAckEvent>());
        Assert.IsType<KeyframeRequestEvent>(await h.Next<KeyframeRequestEvent>());
        var input = await h.Next<InputEvent>();
        Assert.Equal("click", input.Payload.GetProperty("type").GetString());
        Assert.Equal(new AuthErrorEvent("nope"), await h.Next<AuthErrorEvent>());
    }

    [Fact]
    public async Task Fragmented_message_is_reassembled_and_malformed_json_is_ignored()
    {
        await using var h = new Harness();
        var t = await h.Transport(0);
        t.PushText("{not json");
        t.PushText("""{"event":"host:controller_count","payload":{"count":5}}""", fragments: 4);

        Assert.Equal(new ControllerCountEvent(5), await h.Next<ControllerCountEvent>());
    }

    [Fact]
    public async Task Normal_drop_reconnects_after_4_seconds_and_reregisters_with_saved_secret()
    {
        await using var h = new Harness();
        var t0 = await h.Transport(0);
        t0.PushText("""{"event":"host:registered","payload":{"hostId":"win-1234","pairingCode":"1","pairingUrl":"u","controllerCount":0,"hostSecret":"issued"}}""");
        await h.Next<RegisteredEvent>();
        t0.PushClose(1001);

        var dc = await h.Next<DisconnectedEvent>();
        Assert.Equal(TimeSpan.FromSeconds(4), dc.RetryIn);
        Assert.False(dc.AuthRejected);
        var p = (await h.Transport(1)).RegisterPayload();
        Assert.Equal("issued", p.GetProperty("hostSecret").GetString());
        Assert.Equal(TimeSpan.FromSeconds(4), h.Delays[0]);
    }

    [Theory]
    [InlineData(4401, false)]
    [InlineData(4409, true)]
    public async Task Auth_close_codes_wait_60_seconds(int code, bool replaced)
    {
        await using var h = new Harness();
        var t0 = await h.Transport(0);
        t0.PushClose(code, "x");

        var dc = await h.Next<DisconnectedEvent>();
        Assert.Equal(code, dc.CloseCode);
        Assert.Equal(replaced, dc.Replaced);
        Assert.Equal(TimeSpan.FromSeconds(60), dc.RetryIn);
        await h.Transport(1);
        Assert.Equal(TimeSpan.FromSeconds(60), h.Delays[0]);
    }

    [Fact]
    public async Task Auth_error_event_then_close_waits_60_seconds()
    {
        await using var h = new Harness();
        var t0 = await h.Transport(0);
        t0.PushText("""{"event":"host:auth_error","payload":{"error":"bad"}}""");
        t0.PushClose(1000);

        var dc = await h.Next<DisconnectedEvent>();
        Assert.True(dc.AuthRejected);
        Assert.Equal(TimeSpan.FromSeconds(60), dc.RetryIn);
    }

    [Fact]
    public async Task Sends_are_serialized()
    {
        await using var h = new Harness();
        h.Factory.SendDelay = true;
        // Created lazily on first connect, so SendDelay applies to transport 0 before it is created.
        await WaitUntil(() => { lock (h.Factory.Created) return h.Factory.Created.Count > 0; });
        var t = h.Factory[0];
        t.SendDelay = true;
        await h.Transport(0);

        var sends = Enumerable.Range(0, 8)
            .Select(i => i % 2 == 0
                ? h.Client.SendBinaryAsync(new byte[] { 1, 2, 3 })
                : h.Client.SendEventAsync("host:update", new { screenWidth = 100 }))
            .ToArray();
        await Task.WhenAll(sends);

        Assert.Equal(1, t.MaxConcurrentSends);
        Assert.Equal(9, t.Sent.Count); // register + 8
    }

    [Fact]
    public async Task Secrets_are_not_exposed_by_ToString()
    {
        await using var h = new Harness(Secret);
        var options = new RelayOptions(new Uri("wss://r/ws"), "id", "n", "g");
        Assert.DoesNotContain(Secret, options.ToString());
        Assert.DoesNotContain(Secret, h.Client.ToString());
        Assert.DoesNotContain(Secret, h.Secrets.ToString());
    }

    [Fact]
    public async Task Send_before_connect_throws_without_leaking_secrets()
    {
        var client = new RelayClient(
            new RelayOptions(new Uri("wss://r/ws"), "id", "n", "g"),
            () => new RegistrationSnapshot(1, 1, [], 0, "os"),
            new InMemoryHostSecretStore(Secret),
            new FakeFactory());
        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => client.SendBinaryAsync(new byte[1]));
        Assert.DoesNotContain(Secret, ex.Message);
    }

    [Fact]
    public async Task Close_4403_clears_the_secret_reports_revoked_and_stops_retrying()
    {
        await using var h = new Harness(Secret);
        var t0 = await h.Transport(0);
        t0.PushClose(4403, "Host unknown or revoked");

        var dc = await h.Next<DisconnectedEvent>();
        Assert.True(dc.Revoked);
        Assert.Equal(4403, dc.CloseCode);
        Assert.Null(h.Secrets.Load());
        Assert.Equal(RelayStopReason.Revoked, await h.Run.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Single(h.Factory.Created);
        Assert.Empty(h.Delays);
        await WaitUntil(() => h.Client.Events.Completion.IsCompleted);
    }

    [Fact]
    public async Task Close_4401_keeps_the_secret()
    {
        await using var h = new Harness(Secret);
        var t0 = await h.Transport(0);
        t0.PushClose(4401, "bad");
        var dc = await h.Next<DisconnectedEvent>();
        Assert.False(dc.Revoked);
        Assert.Equal(Secret, h.Secrets.Load());
    }

    [Fact]
    public async Task Cancellation_stops_run_and_completes_events()
    {
        var h = new Harness();
        await h.Transport(0);
        await h.DisposeAsync();
        Assert.Equal(RelayStopReason.Cancelled, await h.Run);
        await WaitUntil(() => h.Client.Events.Completion.IsCompleted);
    }
}
