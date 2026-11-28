using System.Globalization;
using DeskBridge.Agent.Core.Streaming;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Streaming;

public class CsvPerfLogTests
{
    private static FramePerfSample Sample(double encodeMs = 2.25, ulong cycles = 9_000_000) => new(
        TimestampMs: 1500, CaptureId: 42, Key: true, Regions: 3, EncodedPixels: 1_258_291, Bytes: 81_234,
        CaptureMs: 6.5, DiffMs: 1.25, EncodeMs: encodeMs, EncodeCycles: cycles, ProcessorId: 5,
        Width: 1093, Height: 683, Quality: 62);

    private const string Header =
        "kind,t_ms,capture_id,key,regions,pixels,bytes,capture_ms,diff_ms,encode_ms,encode_mcycles,cpu," +
        "width,height,quality,max_width,seq,rtt_sample_ms,rtt_ms,base_rtt_ms,window_bytes,inflight_bytes";

    [Fact]
    public void Writes_a_header_then_one_frame_row_per_sample()
    {
        var text = new StringWriter();
        using (var log = new CsvPerfLog(text))
        {
            log.Record(Sample());
            log.Record(Sample(encodeMs: 30));
        }
        string[] lines = text.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        Assert.Equal(3, lines.Length);
        Assert.Equal(Header, lines[0]);
        Assert.Equal("frame,1500,42,1,3,1258291,81234,6.50,1.25,2.25,9.00,5,1093,683,62,,,,,,,", lines[1]);
    }

    [Fact]
    public void Ack_row_pairs_the_raw_rtt_sample_with_the_acked_frames_size()
    {
        var text = new StringWriter();
        using (var log = new CsvPerfLog(text))
            log.RecordAck(new AckPerfSample(TimestampMs: 2100, Seq: 17, Bytes: 312_000, SampleMs: 640,
                RttMs: 230.5, BaseRttMs: 48, WindowBytes: 183_500.8, InFlightBytesAtSend: 420_000));
        string row = text.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)[1];
        Assert.Equal("ack,2100,,,,,312000,,,,,,,,,,17,640.0,230.5,48.0,183501,420000", row);
    }

    [Fact]
    public void Quality_row_records_the_level_the_relay_asked_for()
    {
        var text = new StringWriter();
        using (var log = new CsvPerfLog(text))
            log.RecordQuality(new QualityPerfSample(TimestampMs: 2500, MaxWidth: 1366, Quality: 68));
        string row = text.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)[1];
        Assert.Equal("quality,2500,,,,,,,,,,,,,68,1366,,,,,,", row);
    }

    [Fact]
    public void Uses_invariant_number_format_whatever_the_thread_culture()
    {
        CultureInfo before = CultureInfo.CurrentCulture;
        CultureInfo.CurrentCulture = new CultureInfo("pt-BR");
        try
        {
            var text = new StringWriter();
            using (var log = new CsvPerfLog(text)) log.Record(Sample());
            Assert.Contains(",6.50,1.25,2.25,", text.ToString());
        }
        finally
        {
            CultureInfo.CurrentCulture = before;
        }
    }

    [Fact]
    public void Cycles_are_empty_when_the_counter_is_unavailable()
    {
        var text = new StringWriter();
        using (var log = new CsvPerfLog(text)) log.Record(Sample(cycles: 0));
        Assert.Contains(",2.25,,5,", text.ToString());
    }

    [Fact]
    public void File_has_no_byte_order_mark()
    {
        string path = Path.Combine(Path.GetTempPath(), $"perf-{Guid.NewGuid():N}.csv");
        try
        {
            using (var log = CsvPerfLog.Create(path)) log.Record(Sample());
            Assert.Equal((byte)'k', File.ReadAllBytes(path)[0]);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
