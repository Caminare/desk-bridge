using DeskBridge.Agent.Core.Cursor;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Cursor;

public class CursorShapeConverterTests
{
    private static (byte R, byte G, byte B, byte A) Px(CursorShapeData s, int x, int y)
    {
        int i = (y * s.Width + x) * 4;
        return (s.Rgba[i], s.Rgba[i + 1], s.Rgba[i + 2], s.Rgba[i + 3]);
    }

    [Fact]
    public void Color_shape_swaps_bgra_to_rgba_and_keeps_alpha()
    {
        // 2x1 BGRA: blue opaque, half-transparent red.
        byte[] bgra = [255, 0, 0, 255, 0, 0, 255, 128];
        var s = CursorShapeConverter.Convert(CursorShapeType.Color, bgra, 2, 1, 8, 1, 0);

        Assert.Equal((2, 1, 1, 0), (s.Width, s.Height, s.HotX, s.HotY));
        Assert.Equal(((byte)0, (byte)0, (byte)255, (byte)255), Px(s, 0, 0));
        Assert.Equal(((byte)255, (byte)0, (byte)0, (byte)128), Px(s, 1, 0));
    }

    [Fact]
    public void Masked_color_replaces_where_mask_is_clear_and_xor_black_is_transparent()
    {
        // 3x1: alpha 0 = opaque colour; alpha 0xFF with black = no change (transparent).
        byte[] px = [10, 20, 30, 0, 0, 0, 0, 0xFF, 0, 0, 0, 0xFF];
        var s = CursorShapeConverter.Convert(CursorShapeType.MaskedColor, px, 3, 1, 12, 0, 0);

        Assert.Equal(((byte)30, (byte)20, (byte)10, (byte)255), Px(s, 0, 0));
        Assert.Equal((byte)0, Px(s, 1, 0).A);
        Assert.Equal((byte)0, Px(s, 2, 0).A);
    }

    [Fact]
    public void Monochrome_maps_and_xor_bits_and_inverting_pixels_become_black_with_a_white_outline()
    {
        // 4x3 monochrome: AND mask rows then XOR mask rows, 1 bpp MSB first, pitch 1 byte.
        // Row 1: pixel 0 = black (AND 0, XOR 0), 1 = white (AND 0, XOR 1), 2 = invert (AND 1, XOR 1), 3 = transparent (AND 1, XOR 0).
        // Rows 0 and 2 are fully transparent.
        byte[] mask =
        [
            0b1111_0000, 0b0011_0000, 0b1111_0000, // AND
            0b0000_0000, 0b0110_0000, 0b0000_0000, // XOR
        ];
        var s = CursorShapeConverter.Convert(CursorShapeType.Monochrome, mask, 4, 6, 1, 0, 0);

        Assert.Equal((4, 3), (s.Width, s.Height));
        Assert.Equal(((byte)0, (byte)0, (byte)0, (byte)255), Px(s, 0, 1));
        Assert.Equal(((byte)255, (byte)255, (byte)255, (byte)255), Px(s, 1, 1));
        Assert.Equal(((byte)0, (byte)0, (byte)0, (byte)255), Px(s, 2, 1)); // inverting -> black
        // Transparent neighbours of the inverting pixel get the white outline.
        Assert.Equal(((byte)255, (byte)255, (byte)255, (byte)255), Px(s, 3, 1));
        Assert.Equal(((byte)255, (byte)255, (byte)255, (byte)255), Px(s, 2, 0));
        Assert.Equal(((byte)255, (byte)255, (byte)255, (byte)255), Px(s, 3, 2));
        // Pixels not next to an inverting pixel stay transparent.
        Assert.Equal((byte)0, Px(s, 0, 0).A);
    }

    [Fact]
    public void Masked_color_inverting_pixels_get_the_same_outline()
    {
        // 3x1: transparent, invert (alpha 0xFF, non-black colour), transparent.
        byte[] px = [0, 0, 0, 0xFF, 255, 255, 255, 0xFF, 0, 0, 0, 0xFF];
        var s = CursorShapeConverter.Convert(CursorShapeType.MaskedColor, px, 3, 1, 12, 0, 0);
        Assert.Equal(((byte)255, (byte)255, (byte)255, (byte)255), Px(s, 0, 0));
        Assert.Equal(((byte)0, (byte)0, (byte)0, (byte)255), Px(s, 1, 0));
        Assert.Equal(((byte)255, (byte)255, (byte)255, (byte)255), Px(s, 2, 0));
    }

    [Fact]
    public void Respects_the_row_pitch()
    {
        // 1x2 colour shape with 8 bytes per row (4 bytes padding).
        byte[] bgra = [1, 2, 3, 255, 9, 9, 9, 9, 4, 5, 6, 255, 9, 9, 9, 9];
        var s = CursorShapeConverter.Convert(CursorShapeType.Color, bgra, 1, 2, 8, 0, 0);
        Assert.Equal(((byte)6, (byte)5, (byte)4, (byte)255), Px(s, 0, 1));
    }

    [Fact]
    public void Id_is_stable_for_equal_shapes_and_differs_when_pixels_or_hotspot_differ()
    {
        byte[] a = [255, 0, 0, 255];
        byte[] b = [0, 255, 0, 255];
        var s1 = CursorShapeConverter.Convert(CursorShapeType.Color, a, 1, 1, 4, 0, 0);
        var s2 = CursorShapeConverter.Convert(CursorShapeType.Color, a, 1, 1, 4, 0, 0);
        var s3 = CursorShapeConverter.Convert(CursorShapeType.Color, b, 1, 1, 4, 0, 0);
        var s4 = CursorShapeConverter.Convert(CursorShapeType.Color, (byte[])[255, 0, 0, 255, 255, 0, 0, 255], 2, 1, 8, 1, 0);
        var s5 = CursorShapeConverter.Convert(CursorShapeType.Color, (byte[])[255, 0, 0, 255, 255, 0, 0, 255], 2, 1, 8, 0, 0);

        Assert.Equal(s1.Id, s2.Id);
        Assert.NotEqual(s1.Id, s3.Id);
        Assert.NotEqual(s4.Id, s5.Id);
        Assert.Matches("^[0-9a-f]{16}$", s1.Id);
    }

    [Fact]
    public void Shapes_larger_than_the_protocol_limit_are_downscaled_with_the_hotspot()
    {
        int w = 256, h = 200;
        var bgra = new byte[w * h * 4];
        for (int i = 3; i < bgra.Length; i += 4) bgra[i] = 255;
        var s = CursorShapeConverter.Convert(CursorShapeType.Color, bgra, w, h, w * 4, 200, 100);

        Assert.True(s.Width <= CursorShapeConverter.MaxSize && s.Height <= CursorShapeConverter.MaxSize);
        Assert.Equal((128, 100, 100, 50), (s.Width, s.Height, s.HotX, s.HotY));
        Assert.Equal(s.Width * s.Height * 4, s.Rgba.Length);
    }

    [Fact]
    public void Empty_shapes_are_rejected()
    {
        Assert.Null(CursorShapeConverter.TryConvert(CursorShapeType.Color, [], 0, 0, 0, 0, 0));
        Assert.Null(CursorShapeConverter.TryConvert(CursorShapeType.Monochrome, [0], 8, 1, 1, 0, 0)); // odd raw height
        Assert.Null(CursorShapeConverter.TryConvert(CursorShapeType.Color, new byte[3], 1, 1, 4, 0, 0)); // buffer too short
    }
}
