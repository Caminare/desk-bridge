using System.Globalization;
using DeskBridge.Agent.Core.Streaming;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Streaming;

public class CsvPerfLogTests
{
    private static FramePerfSample Sample(double encodeMs = 2.25, ulong cycles = 9_000_000) => new(
        TimestampMs: 1500, CaptureId: 42, Key: true, Regions: 3, EncodedPixels: 1_258_291, Bytes: 81_234,
        CaptureMs: 6.5, DiffMs: 1.25, EncodeMs: encodeMs, EncodeCycles: cycles, ProcessorId: 5);

    [Fact]
    public void Writes_a_header_then_one_line_per_sample()
    {
        var text = new StringWriter();
        using (var log = new CsvPerfLog(text))
        {
            log.Record(Sample());
            log.Record(Sample(encodeMs: 30));
        }
        string[] lines = text.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        Assert.Equal(3, lines.Length);
        Assert.Equal("t_ms,capture_id,key,regions,pixels,bytes,capture_ms,diff_ms,encode_ms,encode_mcycles,cpu", lines[0]);
        Assert.Equal("1500,42,1,3,1258291,81234,6.50,1.25,2.25,9.00,5", lines[1]);
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
        Assert.EndsWith(",2.25,,5", text.ToString().TrimEnd());
    }

    [Fact]
    public void File_has_no_byte_order_mark()
    {
        string path = Path.Combine(Path.GetTempPath(), $"perf-{Guid.NewGuid():N}.csv");
        try
        {
            using (var log = CsvPerfLog.Create(path)) log.Record(Sample());
            Assert.Equal((byte)'t', File.ReadAllBytes(path)[0]);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
