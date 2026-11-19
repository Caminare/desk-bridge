namespace DeskBridge.Agent.Core.Streaming;

/// <summary>Picks the stream size from the pixel budget, as the PowerShell agent's <c>Configure</c> does.</summary>
public static class StreamSizer
{
    public const int MinWidth = 320;

    /// <summary>
    /// <paramref name="maxWidth"/> is a 16:9-equivalent width: the pixel budget (maxWidth x maxWidth*9/16)
    /// is kept on any aspect ratio, so an ultrawide or 4:3 screen gets as much detail as a 16:9 one.
    /// Never upscales: the result is at most the source size.
    /// </summary>
    public static (int Width, int Height) Compute(int maxWidth, int sourceWidth, int sourceHeight)
    {
        if (sourceWidth <= 0 || sourceHeight <= 0) throw new ArgumentOutOfRangeException(nameof(sourceWidth), "source size must be positive");
        double aspect = sourceWidth / (double)sourceHeight;
        double pixelBudget = maxWidth * (maxWidth * 9.0 / 16.0);
        int w = (int)Math.Round(Math.Sqrt(pixelBudget * aspect));
        w = Math.Min(Math.Max(MinWidth, w), sourceWidth);
        int h = (int)Math.Round(sourceHeight * (w / (double)sourceWidth));
        return (w, Math.Clamp(h, 1, sourceHeight));
    }
}
