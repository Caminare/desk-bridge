using System.Buffers;

namespace DeskBridge.Agent.Core.Streaming;

/// <summary>Rectangle in stream (scaled) pixel coordinates.</summary>
public readonly record struct PixelRect(int X, int Y, int Width, int Height);

/// <summary>
/// Top-down 32-bit BGRA (alpha ignored) image. The memory belongs to the frame source and is
/// only valid until that source's next <see cref="IFrameSource.TryCapture"/> call.
/// </summary>
public readonly record struct FrameImage(ReadOnlyMemory<byte> Pixels, int Width, int Height, int Stride);

/// <summary>Outcome of one capture attempt.</summary>
public enum CaptureStatus
{
    /// <summary>A frame is available in the result image.</summary>
    Frame,
    /// <summary>The desktop did not change within the timeout; the image is not valid.</summary>
    NoChange,
    /// <summary>
    /// The source lost access (mode change, desktop switch, device lost). The caller should
    /// send a keyframe once capture recovers.
    /// </summary>
    Lost,
}

public readonly record struct CaptureResult(
    CaptureStatus Status,
    FrameImage Image,
    /// <summary>Changed regions in stream coordinates when the source knows them (DXGI dirty rects); null = unknown, diff everything.</summary>
    IReadOnlyList<PixelRect>? DirtyRects,
    /// <summary>Capture plus scale time, ms (stats <c>cap</c>).</summary>
    double CaptureMs);

/// <summary>Captures one monitor, scaled to a requested stream size. Used from a single capture thread.</summary>
public interface IFrameSource : IDisposable
{
    /// <summary>Capture method reported in stats <c>cm</c>, e.g. "dxgi" or "gdi".</summary>
    string Method { get; }

    /// <summary>Size of the captured monitor in physical pixels.</summary>
    (int Width, int Height) SourceSize { get; }

    /// <summary>
    /// Waits up to <paramref name="timeout"/> for a desktop update and returns it scaled to
    /// exactly <paramref name="targetWidth"/> x <paramref name="targetHeight"/>.
    /// <paramref name="forceFrame"/> returns the current picture even without an update (keyframes).
    /// </summary>
    CaptureResult TryCapture(int targetWidth, int targetHeight, TimeSpan timeout, bool forceFrame);
}

public enum ChromaSubsampling
{
    /// <summary>4:2:0, smallest; default for motion.</summary>
    S420,
    /// <summary>4:4:4, sharp coloured text; for refinement tiles.</summary>
    S444,
}

/// <summary>JPEG-encodes rectangles of a <see cref="FrameImage"/>. Used from a single capture thread.</summary>
public interface ITileEncoder : IDisposable
{
    /// <summary>Appends the JPEG for <paramref name="rect"/> to <paramref name="output"/> and returns its length in bytes.</summary>
    int Encode(in FrameImage image, PixelRect rect, int quality, ChromaSubsampling subsampling, IBufferWriter<byte> output);
}
