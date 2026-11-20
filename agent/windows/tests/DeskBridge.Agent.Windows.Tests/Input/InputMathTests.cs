using DeskBridge.Agent.Windows.Input;
using Xunit;

namespace DeskBridge.Agent.Windows.Tests.Input;

public class InputMathTests
{
    // A monitor left of the primary: the virtual desktop origin is negative.
    private static readonly ScreenRect LeftMonitor = new(-1920, 0, 1920, 1080);
    private static readonly ScreenRect VirtualWithLeftMonitor = new(-1920, 0, 3840, 1080);
    private static readonly ScreenRect SingleMonitor = new(0, 0, 1920, 1080);

    [Fact]
    public void Normalized_corners_map_to_the_monitor_edges()
    {
        Assert.Equal((-1920, 0), InputMath.NormalizedToPixel(0, 0, LeftMonitor));
        Assert.Equal((-1, 1079), InputMath.NormalizedToPixel(1, 1, LeftMonitor));
    }

    [Fact]
    public void Normalized_centre_maps_inside_a_monitor_with_an_offset_origin()
    {
        var secondary = new ScreenRect(2560, 0, 2560, 1440);
        Assert.Equal((2560 + 1280, 360), InputMath.NormalizedToPixel(0.5, 0.25, secondary));
        Assert.Equal((-960, 540), InputMath.NormalizedToPixel(0.5, 0.5, LeftMonitor));
    }

    [Fact]
    public void Normalized_values_outside_the_unit_square_are_clamped_to_the_monitor()
    {
        Assert.Equal((-1920, 1079), InputMath.NormalizedToPixel(-0.5, 2, LeftMonitor));
    }

    [Fact]
    public void Virtual_desktop_corners_map_to_the_extremes_of_the_absolute_range()
    {
        Assert.Equal((0, 0), InputMath.PixelToAbsolute(-1920, 0, VirtualWithLeftMonitor));
        Assert.Equal((65535, 65535), InputMath.PixelToAbsolute(1919, 1079, VirtualWithLeftMonitor));
    }

    [Fact]
    public void Virtual_desktop_midpoint_lands_on_the_expected_absolute_coordinate()
    {
        // Pixel 0 is the primary monitor's left edge, 1920 pixels in from the virtual origin.
        (int ax, int ay) = InputMath.PixelToAbsolute(0, 540, VirtualWithLeftMonitor);

        Assert.InRange(ax, 1920 * 65535.0 / 3839 - 1, 1920 * 65535.0 / 3839 + 1);
        Assert.InRange(ay, 540 * 65535.0 / 1079 - 1, 540 * 65535.0 / 1079 + 1);
    }

    [Fact]
    public void Single_monitor_round_trip_hits_the_pixel_it_was_given()
    {
        (int ax, int ay) = InputMath.PixelToAbsolute(960, 540, SingleMonitor);
        // The OS maps the absolute value back to a pixel with the same scale. The error must stay under one pixel.
        Assert.InRange(ax * 1919.0 / 65535.0, 959.5, 960.5);
        Assert.InRange(ay * 1079.0 / 65535.0, 539.5, 540.5);
    }

    [Fact]
    public void Pixels_left_of_the_virtual_desktop_clamp_to_zero()
    {
        Assert.Equal((0, 0), InputMath.PixelToAbsolute(-5000, -5000, VirtualWithLeftMonitor));
    }

    [Fact]
    public void Relative_move_adds_the_delta()
    {
        Assert.Equal((105, 97), InputMath.RelativeTarget(100, 100, 5, -3, SingleMonitor));
    }

    [Fact]
    public void Relative_move_clamps_to_the_active_monitor_edges()
    {
        Assert.Equal((1919, 1079), InputMath.RelativeTarget(1919, 1079, 50, 50, SingleMonitor));
        Assert.Equal((-1920, 500), InputMath.RelativeTarget(-1000, 500, -5000, 0, LeftMonitor));
    }

    [Fact]
    public void Relative_move_keeps_the_cursor_on_the_last_pixel_of_a_left_monitor()
    {
        // -1 is the rightmost pixel of the left monitor, so +1 must not leave it.
        Assert.Equal((-1, 0), InputMath.RelativeTarget(-1, 0, 1, 0, LeftMonitor));
    }

    [Fact]
    public void Vertical_wheel_is_inverted_relative_to_the_browser_delta()
    {
        Assert.Equal(-120, InputMath.WheelData(1, horizontal: false));
        Assert.Equal(240, InputMath.WheelData(-2, horizontal: false));
    }

    [Fact]
    public void Horizontal_wheel_keeps_the_browser_sign()
    {
        Assert.Equal(120, InputMath.WheelData(1, horizontal: true));
        Assert.Equal(60, InputMath.WheelData(0.5, horizontal: true));
    }

    [Fact]
    public void Zero_wheel_and_huge_wheel_values_stay_well_defined()
    {
        Assert.Equal(0, InputMath.WheelData(0, horizontal: false));
        Assert.Equal(int.MaxValue, InputMath.WheelData(1e300, horizontal: true));
    }

    [Fact]
    public void Plain_text_maps_one_unicode_step_per_character()
    {
        Assert.Equal(
            new[] { new TextStep(0, 'a'), new TextStep(0, 'b') },
            InputMath.PlanText("ab").ToArray());
    }

    [Fact]
    public void Line_feed_becomes_enter_and_carriage_return_is_dropped()
    {
        Assert.Equal(
            new[] { new TextStep(0, 'a'), new TextStep(0x0D, '\0'), new TextStep(0, 'b') },
            InputMath.PlanText("a\r\nb").ToArray());
    }

    [Fact]
    public void Tab_becomes_the_tab_key()
    {
        Assert.Equal(new[] { new TextStep(0x09, '\0') }, InputMath.PlanText("\t").ToArray());
    }

    [Fact]
    public void Emoji_is_sent_as_its_two_utf16_surrogate_halves()
    {
        // U+1F600 is 0xD83D 0xDE00 in UTF-16.
        Assert.Equal(
            new[] { new TextStep(0, '\uD83D'), new TextStep(0, '\uDE00') },
            InputMath.PlanText("\U0001F600").ToArray());
    }

    [Fact]
    public void Empty_text_plans_no_steps()
    {
        Assert.Empty(InputMath.PlanText(string.Empty));
    }

    [Theory]
    [InlineData(0x25, true)]
    [InlineData(0x2C, true)]
    [InlineData(0x2E, true)]
    [InlineData(0x5B, true)]
    [InlineData(0x6F, true)]
    [InlineData(0x90, true)]
    [InlineData(0x41, false)]
    [InlineData(0x10, false)]
    [InlineData(0x11, false)]
    [InlineData(0x12, false)]
    public void Only_the_navigation_and_win_keys_are_extended(ushort vk, bool extended)
    {
        Assert.Equal(extended, InputMath.IsExtendedKey(vk));
    }
}
