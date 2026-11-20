namespace DeskBridge.Agent.Core.Streaming;

public enum KeyframeReason
{
    None,
    /// <summary>A keyframe was requested (relay request, controller joined, monitor switch).</summary>
    Req,
    /// <summary>No usable reference (first frame, size change, capture lost).</summary>
    Init,
    /// <summary>More than half of the tiles changed: one full JPEG beats many tiles.</summary>
    Big,
}

/// <summary>Decides when a frame must be a keyframe. Thread safe (requests arrive from the network thread).</summary>
public sealed class KeyframePolicy
{
    private int _requested;
    private int _satisfied;
    private volatile string _lastReason = "";

    /// <summary>Wire value of the latest keyframe's reason (stats <c>kr</c>); empty before the first keyframe.</summary>
    public string LastReason => _lastReason;

    /// <summary>Counter to remember at the start of a capture; pass it to <see cref="MarkSatisfied"/> when that frame is taken.</summary>
    public int RequestToken => Volatile.Read(ref _requested);

    public void RequestKeyframe() => Interlocked.Increment(ref _requested);

    /// <summary>Checked before diffing: a pending request, or no reference to diff against.</summary>
    public KeyframeReason Evaluate(bool hasReference)
    {
        if (Volatile.Read(ref _requested) != Volatile.Read(ref _satisfied)) return KeyframeReason.Req;
        return hasReference ? KeyframeReason.None : KeyframeReason.Init;
    }

    /// <summary>Checked after diffing a delta frame.</summary>
    public static KeyframeReason EvaluateAfterDiff(int changedTiles, int totalTiles)
        => changedTiles * 2 > totalTiles ? KeyframeReason.Big : KeyframeReason.None;

    /// <summary>Call when a keyframe is handed to the sender, with the token captured when it was produced.</summary>
    public void MarkSatisfied(int token)
    {
        int cur;
        do { cur = Volatile.Read(ref _satisfied); if (token <= cur) return; }
        while (Interlocked.CompareExchange(ref _satisfied, token, cur) != cur);
    }

    /// <summary>Call when a keyframe is posted, to keep <see cref="LastReason"/> current.</summary>
    public void NoteKeyframe(KeyframeReason reason) => _lastReason = ToWire(reason);

    public static string ToWire(KeyframeReason r) => r switch
    {
        KeyframeReason.Req => "req",
        KeyframeReason.Init => "init",
        KeyframeReason.Big => "big",
        _ => "",
    };
}
