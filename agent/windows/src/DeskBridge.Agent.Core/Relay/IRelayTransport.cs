namespace DeskBridge.Agent.Core.Relay;

public enum RelayMessageKind { Text, Binary, Close }

/// <param name="Count">Bytes written to the caller's buffer.</param>
/// <param name="EndOfMessage">False when more fragments of the same message follow.</param>
public readonly record struct TransportReceiveResult(
    int Count,
    bool EndOfMessage,
    RelayMessageKind Kind,
    int? CloseCode = null,
    string? CloseDescription = null);

/// <summary>One connection to the relay. Created fresh per connection attempt.</summary>
public interface IRelayTransport : IAsyncDisposable
{
    Task ConnectAsync(Uri uri, CancellationToken ct);
    ValueTask SendAsync(ReadOnlyMemory<byte> data, bool binary, CancellationToken ct);
    ValueTask<TransportReceiveResult> ReceiveAsync(Memory<byte> buffer, CancellationToken ct);
}

public interface IRelayTransportFactory
{
    IRelayTransport Create();
}
