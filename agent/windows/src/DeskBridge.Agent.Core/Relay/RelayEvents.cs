using System.Text.Json;

namespace DeskBridge.Agent.Core.Relay;

public abstract record RelayEvent;

public sealed record RegisteredEvent(string HostId, string PairingCode, string PairingUrl, int ControllerCount) : RelayEvent;

public sealed record ControllerCountEvent(int Count) : RelayEvent;

public sealed record FrameAckEvent(long Seq, bool IsRelayAck) : RelayEvent;

public sealed record KeyframeRequestEvent : RelayEvent;

/// <summary>Raw <c>client:input</c> payload; parsing input types is a later slice.</summary>
public sealed record InputEvent(JsonElement Payload) : RelayEvent;

public sealed record AuthErrorEvent(string Message) : RelayEvent;

/// <param name="Replaced">Close code 4409: a newer connection for this host id took over (likely a second agent).</param>
/// <param name="AuthRejected">Auth error or close code 4401.</param>
public sealed record DisconnectedEvent(
    string Reason,
    int? CloseCode,
    bool Replaced,
    bool AuthRejected,
    TimeSpan RetryIn) : RelayEvent;
