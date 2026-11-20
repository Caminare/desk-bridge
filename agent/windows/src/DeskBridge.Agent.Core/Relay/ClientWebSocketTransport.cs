using System.Net.Sockets;
using System.Net.WebSockets;

namespace DeskBridge.Agent.Core.Relay;

public sealed class ClientWebSocketTransportFactory : IRelayTransportFactory
{
    public IRelayTransport Create() => new ClientWebSocketTransport();
}

/// <summary>Real transport. Nagle is disabled through a custom connect callback.</summary>
public sealed class ClientWebSocketTransport : IRelayTransport
{
    private readonly ClientWebSocket _ws = new();
    private readonly SocketsHttpHandler _handler;
    private readonly HttpMessageInvoker _invoker;

    public ClientWebSocketTransport()
    {
        _ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(10);
        _ws.Options.SetRequestHeader("ngrok-skip-browser-warning", "true");
        _handler = new SocketsHttpHandler { ConnectCallback = ConnectNoDelayAsync };
        _invoker = new HttpMessageInvoker(_handler);
    }

    private static async ValueTask<Stream> ConnectNoDelayAsync(SocketsHttpConnectionContext ctx, CancellationToken ct)
    {
        var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(ctx.DnsEndPoint, ct).ConfigureAwait(false);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    public Task ConnectAsync(Uri uri, CancellationToken ct) => _ws.ConnectAsync(uri, _invoker, ct);

    public ValueTask SendAsync(ReadOnlyMemory<byte> data, bool binary, CancellationToken ct) =>
        _ws.SendAsync(data, binary ? WebSocketMessageType.Binary : WebSocketMessageType.Text, true, ct);

    public async ValueTask<TransportReceiveResult> ReceiveAsync(Memory<byte> buffer, CancellationToken ct)
    {
        var r = await _ws.ReceiveAsync(buffer, ct).ConfigureAwait(false);
        return r.MessageType switch
        {
            WebSocketMessageType.Close => new TransportReceiveResult(
                0, true, RelayMessageKind.Close, (int?)_ws.CloseStatus, _ws.CloseStatusDescription),
            WebSocketMessageType.Binary => new TransportReceiveResult(r.Count, r.EndOfMessage, RelayMessageKind.Binary),
            _ => new TransportReceiveResult(r.Count, r.EndOfMessage, RelayMessageKind.Text),
        };
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (_ws.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await _ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", cts.Token).ConfigureAwait(false);
            }
        }
        catch
        {
            // Best effort; the socket is discarded either way.
        }
        _ws.Dispose();
        _invoker.Dispose();
        _handler.Dispose();
    }
}
