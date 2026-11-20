using DeskBridge.Agent.Core.Streaming;
using DeskBridge.Agent.Windows.Capture;
using Xunit;

namespace DeskBridge.Agent.Windows.Tests.Capture;

public class CursorBlenderTests
{
    private const int W = 6, H = 6, Stride = W * 4;

    private static byte[] Canvas(byte b, byte g, byte r)
    {
        var buf = new byte[Stride * H];
        for (int i = 0; i < buf.Length; i += 4) { buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = 255; }
        return buf;
    }

    private static (byte B, byte G, byte R) Px(byte[] buf, int x, int y) => (buf[y * Stride + x * 4], buf[y * Stride + x * 4 + 1], buf[y * Stride + x * 4 + 2]);

    private static byte[] Solid(int w, int h, byte b, byte g, byte r, byte a)
    {
        var s = new byte[w * h * 4];
        for (int i = 0; i < s.Length; i += 4) { s[i] = b; s[i + 1] = g; s[i + 2] = r; s[i + 3] = a; }
        return s;
    }

    [Fact]
    public void Opaque_colour_shape_replaces_pixels_and_reports_its_rect()
    {
        byte[] dst = Canvas(0, 0, 0);
        byte[] shape = Solid(2, 2, 10, 20, 200, 255);

        PixelRect rect = CursorBlender.Draw(dst, W, H, Stride, CursorBlender.Color, shape, 2, 2, 8, 1, 2, 1, 1);

        Assert.Equal(new PixelRect(1, 2, 2, 2), rect);
        Assert.Equal(((byte)10, (byte)20, (byte)200), Px(dst, 1, 2));
        Assert.Equal(((byte)10, (byte)20, (byte)200), Px(dst, 2, 3));
        Assert.Equal(((byte)0, (byte)0, (byte)0), Px(dst, 0, 2));
        Assert.Equal(((byte)0, (byte)0, (byte)0), Px(dst, 3, 3));
    }

    [Fact]
    public void Colour_shape_alpha_blends_with_the_screen()
    {
        byte[] dst = Canvas(100, 100, 100);
        byte[] shape = Solid(1, 1, 200, 200, 200, 128);

        CursorBlender.Draw(dst, W, H, Stride, CursorBlender.Color, shape, 1, 1, 4, 0, 0, 1, 1);

        // (200*128 + 100*127 + 127) / 255 = 150
        Assert.Equal(((byte)150, (byte)150, (byte)150), Px(dst, 0, 0));
        Assert.Equal(((byte)100, (byte)100, (byte)100), Px(dst, 1, 0));
    }

    [Fact]
    public void Transparent_colour_pixels_leave_the_screen_alone()
    {
        byte[] dst = Canvas(7, 8, 9);
        CursorBlender.Draw(dst, W, H, Stride, CursorBlender.Color, Solid(2, 2, 255, 255, 255, 0), 2, 2, 8, 2, 2, 1, 1);
        Assert.Equal(((byte)7, (byte)8, (byte)9), Px(dst, 2, 2));
    }

    [Fact]
    public void Masked_colour_replaces_when_alpha_is_zero_and_xors_when_it_is_set()
    {
        byte[] dst = Canvas(0x0F, 0xF0, 0xFF);
        // pixel 0: alpha 0 -> replace; pixel 1: alpha 255 -> XOR
        byte[] shape = [1, 2, 3, 0, 0xFF, 0xFF, 0xFF, 0xFF];

        CursorBlender.Draw(dst, W, H, Stride, CursorBlender.MaskedColor, shape, 2, 1, 8, 0, 0, 1, 1);

        Assert.Equal(((byte)1, (byte)2, (byte)3), Px(dst, 0, 0));
        Assert.Equal(((byte)0xF0, (byte)0x0F, (byte)0x00), Px(dst, 1, 0));
    }

    [Theory]
    [InlineData(0, 0, 0, 0, 0)] // AND 0, XOR 0 -> black
    [InlineData(0, 1, 255, 255, 255)] // AND 0, XOR 1 -> white
    [InlineData(1, 0, 40, 80, 120)] // AND 1, XOR 0 -> screen unchanged
    [InlineData(1, 1, 215, 175, 135)] // AND 1, XOR 1 -> screen inverted
    public void Monochrome_shape_applies_and_then_xor_masks(int and, int xor, int b, int g, int r)
    {
        byte[] dst = Canvas(40, 80, 120);
        // 8x1 shape stored as 8x2 rows (AND row, then XOR row), 1 bpp, MSB first, pitch 1. Only the top-left bit is set.
        byte[] shape = [(byte)(and << 7), (byte)(xor << 7)];

        PixelRect rect = CursorBlender.Draw(dst, W, H, Stride, CursorBlender.Monochrome, shape, 8, 2, 1, 0, 0, 1, 1);

        Assert.Equal(new PixelRect(0, 0, 6, 1), rect); // 8 wide, clipped to the 6 px canvas
        Assert.Equal(((byte)b, (byte)g, (byte)r), Px(dst, 0, 0));
    }

    [Fact]
    public void Monochrome_bits_beyond_the_first_pixel_select_their_own_mask_bit()
    {
        byte[] dst = Canvas(50, 50, 50);
        // AND = 0b01000000 (pixel 1 keeps the screen), XOR = 0 -> pixel 0 black, pixel 1 unchanged.
        byte[] shape = [0b0100_0000, 0];

        CursorBlender.Draw(dst, W, H, Stride, CursorBlender.Monochrome, shape, 8, 2, 1, 0, 0, 1, 1);

        Assert.Equal(((byte)0, (byte)0, (byte)0), Px(dst, 0, 0));
        Assert.Equal(((byte)50, (byte)50, (byte)50), Px(dst, 1, 0));
    }

    [Fact]
    public void Shape_is_scaled_down_with_the_stream()
    {
        byte[] dst = Canvas(0, 0, 0);
        byte[] shape = Solid(4, 4, 255, 255, 255, 255);

        PixelRect rect = CursorBlender.Draw(dst, W, H, Stride, CursorBlender.Color, shape, 4, 4, 16, 2, 2, 0.5, 0.5);

        Assert.Equal(new PixelRect(1, 1, 2, 2), rect);
        Assert.Equal(((byte)255, (byte)255, (byte)255), Px(dst, 2, 2));
        Assert.Equal(((byte)0, (byte)0, (byte)0), Px(dst, 3, 3));
    }

    [Fact]
    public void Shape_partly_off_screen_is_clipped_and_fully_off_screen_draws_nothing()
    {
        byte[] dst = Canvas(0, 0, 0);
        byte[] shape = Solid(3, 3, 9, 9, 9, 255);

        PixelRect clipped = CursorBlender.Draw(dst, W, H, Stride, CursorBlender.Color, shape, 3, 3, 12, -2, -2, 1, 1);
        Assert.Equal(new PixelRect(0, 0, 1, 1), clipped);
        Assert.Equal(((byte)9, (byte)9, (byte)9), Px(dst, 0, 0));

        PixelRect none = CursorBlender.Draw(dst, W, H, Stride, CursorBlender.Color, shape, 3, 3, 12, 50, 50, 1, 1);
        Assert.Equal(default, none);
    }

    [Fact]
    public void Bounds_matches_what_draw_reports()
    {
        PixelRect bounds = CursorBlender.Bounds(2, 2, CursorBlender.Color, 1, 2, 1, 1, W, H);
        Assert.Equal(new PixelRect(1, 2, 2, 2), bounds);
        // Monochrome height is doubled in the shape description.
        Assert.Equal(new PixelRect(0, 0, 6, 1), CursorBlender.Bounds(8, 2, CursorBlender.Monochrome, 0, 0, 1, 1, W, H));
    }
}
