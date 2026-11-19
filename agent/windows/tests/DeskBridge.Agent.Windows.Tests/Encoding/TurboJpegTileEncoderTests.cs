using System.Buffers;
using DeskBridge.Agent.Core.Streaming;
using DeskBridge.Agent.Windows.Encoding;
using Xunit;

namespace DeskBridge.Agent.Windows.Tests.Encoding;

public class TurboJpegTileEncoderTests
{
    private const int W = 128, H = 96;

    /// <summary>Left half red, right half blue (BGRA).</summary>
    private static FrameImage TwoColourImage()
    {
        var px = new byte[W * 4 * H];
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++)
            {
                int i = (y * W + x) * 4;
                if (x < W / 2) px[i + 2] = 255; else px[i] = 255;
                px[i + 3] = 255;
            }
        return new FrameImage(px, W, H, W * 4);
    }

    private static void AssertJpeg(ReadOnlySpan<byte> jpeg)
    {
        Assert.True(jpeg.Length > 4);
        Assert.Equal(0xFF, jpeg[0]);
        Assert.Equal(0xD8, jpeg[1]);
        Assert.Equal(0xFF, jpeg[^2]);
        Assert.Equal(0xD9, jpeg[^1]);
    }

    [Fact]
    public void Encodes_a_tile_as_a_jpeg_for_both_subsamplings()
    {
        using var encoder = new TurboJpegTileEncoder();
        FrameImage image = TwoColourImage();

        foreach (ChromaSubsampling s in new[] { ChromaSubsampling.S420, ChromaSubsampling.S444 })
        {
            var writer = new ArrayBufferWriter<byte>();
            int n = encoder.Encode(image, new PixelRect(16, 16, 64, 64), 80, s, writer);

            Assert.Equal(n, writer.WrittenCount);
            AssertJpeg(writer.WrittenSpan);
        }
    }

    [Fact]
    public void Rect_offset_selects_the_right_pixels_and_output_is_appended()
    {
        using var encoder = new TurboJpegTileEncoder();
        FrameImage image = TwoColourImage();
        var writer = new ArrayBufferWriter<byte>();

        int left = encoder.Encode(image, new PixelRect(0, 0, 32, 32), 90, ChromaSubsampling.S444, writer);
        int right = encoder.Encode(image, new PixelRect(96, 0, 32, 32), 90, ChromaSubsampling.S444, writer);

        Assert.Equal(left + right, writer.WrittenCount);
        byte[] a = writer.WrittenSpan[..left].ToArray();
        byte[] b = writer.WrittenSpan[left..].ToArray();
        AssertJpeg(a);
        AssertJpeg(b);
        Assert.False(a.AsSpan().SequenceEqual(b), "red and blue tiles must not encode identically");
    }

    [Fact]
    public void Same_input_encodes_to_the_same_bytes_and_higher_quality_is_larger()
    {
        using var encoder = new TurboJpegTileEncoder();
        // Noisy tile so quality matters.
        var px = new byte[64 * 4 * 64];
        new Random(1).NextBytes(px);
        var image = new FrameImage(px, 64, 64, 64 * 4);
        var rect = new PixelRect(0, 0, 64, 64);

        var w1 = new ArrayBufferWriter<byte>();
        var w2 = new ArrayBufferWriter<byte>();
        var low = new ArrayBufferWriter<byte>();
        encoder.Encode(image, rect, 75, ChromaSubsampling.S420, w1);
        encoder.Encode(image, rect, 75, ChromaSubsampling.S420, w2);
        encoder.Encode(image, rect, 20, ChromaSubsampling.S420, low);

        Assert.True(w1.WrittenSpan.SequenceEqual(w2.WrittenSpan));
        Assert.True(low.WrittenCount < w1.WrittenCount);
    }

    [Fact]
    public void Rejects_a_rect_outside_the_image()
    {
        using var encoder = new TurboJpegTileEncoder();
        FrameImage image = TwoColourImage();

        Assert.Throws<ArgumentOutOfRangeException>(() =>
            encoder.Encode(image, new PixelRect(100, 0, 64, 64), 80, ChromaSubsampling.S420, new ArrayBufferWriter<byte>()));
    }
}
