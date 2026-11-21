using System.Globalization;

namespace DeskBridge.Agent.Core.Streaming;

/// <summary>
/// Timing of one encoded frame, for offline latency analysis (<c>--perf-log</c>). Compare encode time per
/// pixel across processors and runs: the same work taking longer on some cores points at scheduling or
/// power policy rather than the encoder.
/// </summary>
public readonly record struct FramePerfSample(
    long TimestampMs,
    long CaptureId,
    bool Key,
    int Regions,
    long EncodedPixels,
    int Bytes,
    double CaptureMs,
    double DiffMs,
    double EncodeMs,
    /// <summary>
    /// Thread cycles spent encoding; 0 when unavailable. Only counts while the thread runs, but the unit is
    /// platform-defined (not the core clock on current Windows), so compare it across runs, not to GHz.
    /// </summary>
    ulong EncodeCycles,
    /// <summary>Processor the capture thread was on when the encode finished.</summary>
    int ProcessorId);

/// <summary>Receives per-frame timing. Called on the capture thread, so it must be cheap.</summary>
public interface IFramePerfSink
{
    void Record(in FramePerfSample sample);
}

/// <summary>Writes <see cref="FramePerfSample"/>s as CSV with invariant number formatting.</summary>
public sealed class CsvPerfLog : IFramePerfSink, IDisposable
{
    private const string Header = "t_ms,capture_id,key,regions,pixels,bytes,capture_ms,diff_ms,encode_ms,encode_mcycles,cpu";
    private readonly TextWriter _out;
    private readonly object _gate = new();

    public CsvPerfLog(TextWriter output)
    {
        _out = output;
        _out.WriteLine(Header);
    }

    /// <summary>Opens (or replaces) a CSV file with a large buffer, so writes rarely touch the disk.</summary>
    public static CsvPerfLog Create(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        return new CsvPerfLog(new StreamWriter(path, append: false, new System.Text.UTF8Encoding(encoderShouldEmitUTF8Identifier: false), bufferSize: 64 * 1024));
    }

    public void Record(in FramePerfSample s)
    {
        IFormatProvider inv = CultureInfo.InvariantCulture;
        string mcycles = s.EncodeCycles == 0 ? "" : (s.EncodeCycles / 1e6).ToString("F2", inv);
        string line = string.Create(inv,
            $"{s.TimestampMs},{s.CaptureId},{(s.Key ? 1 : 0)},{s.Regions},{s.EncodedPixels},{s.Bytes},{s.CaptureMs:F2},{s.DiffMs:F2},{s.EncodeMs:F2},{mcycles},{s.ProcessorId}");
        lock (_gate) _out.WriteLine(line);
    }

    public void Dispose()
    {
        lock (_gate) _out.Dispose();
    }
}
