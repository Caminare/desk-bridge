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
    int ProcessorId,
    /// <summary>Stream size the frame was encoded at.</summary>
    int Width,
    int Height,
    /// <summary>JPEG quality the frame was encoded with.</summary>
    int Quality);

/// <summary>
/// One path ack: the raw round trip of a frame next to its size, and the send window's state after it.
/// Separates queuing on the path from the time a large frame takes to upload.
/// </summary>
public readonly record struct AckPerfSample(
    long TimestampMs,
    long Seq,
    int Bytes,
    double SampleMs,
    double RttMs,
    double BaseRttMs,
    double WindowBytes,
    /// <summary>Bytes in flight when the frame was sent, itself included.</summary>
    long InFlightBytesAtSend);

/// <summary>A quality level the relay's adaptive control asked for.</summary>
public readonly record struct QualityPerfSample(long TimestampMs, int MaxWidth, int Quality);

/// <summary>Receives per-frame timing, path acks and quality changes. Must be cheap: called on the capture and relay threads.</summary>
public interface IFramePerfSink
{
    void Record(in FramePerfSample sample);
    void RecordAck(in AckPerfSample sample);
    void RecordQuality(in QualityPerfSample sample);
}

/// <summary>Writes frame, ack and quality rows as one CSV table (a <c>kind</c> column tells them apart), with invariant number formatting.</summary>
public sealed class CsvPerfLog : IFramePerfSink, IDisposable
{
    // One schema for every row kind, so the file loads as a single table; columns a kind lacks stay empty.
    private const string Header =
        "kind,t_ms,capture_id,key,regions,pixels,bytes,capture_ms,diff_ms,encode_ms,encode_mcycles,cpu," +
        "width,height,quality,max_width,seq,rtt_sample_ms,rtt_ms,base_rtt_ms,window_bytes,inflight_bytes";
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
            $"frame,{s.TimestampMs},{s.CaptureId},{(s.Key ? 1 : 0)},{s.Regions},{s.EncodedPixels},{s.Bytes},{s.CaptureMs:F2},{s.DiffMs:F2},{s.EncodeMs:F2},{mcycles},{s.ProcessorId}," +
            $"{s.Width},{s.Height},{s.Quality},,,,,,,");
        lock (_gate) _out.WriteLine(line);
    }

    public void RecordAck(in AckPerfSample s)
    {
        string line = string.Create(CultureInfo.InvariantCulture,
            $"ack,{s.TimestampMs},,,,,{s.Bytes},,,,,,,,,,{s.Seq},{s.SampleMs:F1},{s.RttMs:F1},{s.BaseRttMs:F1},{s.WindowBytes:F0},{s.InFlightBytesAtSend}");
        lock (_gate) _out.WriteLine(line);
    }

    public void RecordQuality(in QualityPerfSample s)
    {
        string line = string.Create(CultureInfo.InvariantCulture,
            $"quality,{s.TimestampMs},,,,,,,,,,,,,{s.Quality},{s.MaxWidth},,,,,,");
        lock (_gate) _out.WriteLine(line);
    }

    public void Dispose()
    {
        lock (_gate) _out.Dispose();
    }
}
