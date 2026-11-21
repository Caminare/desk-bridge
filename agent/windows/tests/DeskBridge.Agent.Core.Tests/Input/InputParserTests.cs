using System.Text.Json;
using DeskBridge.Agent.Core.Input;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Input;

public class InputParserTests
{
    private static InputCommand? Parse(string json)
    {
        using JsonDocument doc = JsonDocument.Parse(json);
        return InputParser.Parse(doc.RootElement.Clone());
    }

    [Fact]
    public void MouseMove_absolute_reads_normalized_coordinates()
    {
        Assert.Equal(new MouseMoveAbsolute(0.25, 0.75), Parse("""{"type":"mousemove","x":0.25,"y":0.75}"""));
    }

    [Fact]
    public void MouseMove_relative_rounds_deltas_to_whole_pixels()
    {
        Assert.Equal(new MouseMoveRelative(-3, 5), Parse("""{"type":"mousemove","relative":true,"dx":-3,"dy":4.6}"""));
    }

    [Fact]
    public void MouseMove_relative_requires_string_or_bool_true_only()
    {
        // The PowerShell agent compares relative with -eq $true, so a string "true" is absolute.
        Assert.Equal(new MouseMoveAbsolute(0.1, 0.2), Parse("""{"type":"mousemove","relative":"true","x":0.1,"y":0.2}"""));
    }

    [Theory]
    [InlineData("""{"type":"mousemove","x":0.5}""")]
    [InlineData("""{"type":"mousemove"}""")]
    [InlineData("""{"type":"mousemove","x":"0.5","y":0.5}""")]
    [InlineData("""{"type":"mousemove","x":null,"y":0.5}""")]
    [InlineData("""{"type":"mousemove","relative":true,"dx":1}""")]
    [InlineData("""{"type":"mousemove","relative":true,"dx":1e300,"dy":0}""")]
    public void MouseMove_malformed_returns_null(string json)
    {
        Assert.Null(Parse(json));
    }

    [Fact]
    public void Click_defaults_to_left_single_without_move()
    {
        Assert.Equal(new MouseClick(MouseButton.Left, false, null), Parse("""{"type":"click"}"""));
    }

    [Fact]
    public void Click_reads_button_double_and_position()
    {
        Assert.Equal(
            new MouseClick(MouseButton.Right, true, new MouseMoveAbsolute(0.1, 0.2)),
            Parse("""{"type":"click","button":"right","double":true,"x":0.1,"y":0.2}"""));
    }

    [Fact]
    public void Click_accepts_middle_and_ignores_null_button()
    {
        Assert.Equal(new MouseClick(MouseButton.Middle, false, null), Parse("""{"type":"click","button":"middle"}"""));
        Assert.Equal(new MouseClick(MouseButton.Left, false, null), Parse("""{"type":"click","button":null}"""));
    }

    [Fact]
    public void Click_with_only_one_coordinate_clicks_without_moving()
    {
        Assert.Equal(new MouseClick(MouseButton.Left, false, null), Parse("""{"type":"click","x":0.5}"""));
    }

    [Theory]
    [InlineData("""{"type":"click","button":"back"}""")]
    [InlineData("""{"type":"click","button":3}""")]
    [InlineData("""{"type":"click","x":"0.5","y":0.5}""")]
    public void Click_malformed_returns_null(string json)
    {
        Assert.Null(Parse(json));
    }

    [Theory]
    [InlineData("left", true)]
    [InlineData("right", false)]
    public void MouseDownUp_map_left_and_right(string button, bool down)
    {
        string type = down ? "mousedown" : "mouseup";
        var expected = new MouseButtonState(button == "left" ? MouseButton.Left : MouseButton.Right, down);
        Assert.Equal(expected, Parse($$"""{"type":"{{type}}","button":"{{button}}"}"""));
    }

    [Theory]
    [InlineData("""{"type":"mousedown","button":"middle"}""")]
    [InlineData("""{"type":"mouseup"}""")]
    public void MouseDownUp_rejects_other_buttons_and_missing_button(string json)
    {
        Assert.Null(Parse(json));
    }

    [Fact]
    public void Scroll_reads_both_axes_and_defaults_the_missing_one_to_zero()
    {
        Assert.Equal(new Scroll(0, -1.5), Parse("""{"type":"scroll","deltaX":0,"deltaY":-1.5}"""));
        Assert.Equal(new Scroll(2, 0), Parse("""{"type":"scroll","deltaX":2}"""));
    }

    [Theory]
    [InlineData("""{"type":"scroll"}""")]
    [InlineData("""{"type":"scroll","deltaY":"1"}""")]
    [InlineData("""{"type":"scroll","deltaY":1e400}""")]
    public void Scroll_malformed_returns_null(string json)
    {
        Assert.Null(Parse(json));
    }

    [Fact]
    public void Type_keeps_text_exactly_including_newlines_and_emoji()
    {
        Assert.Equal(new TypeText("héllo \U0001F600\n"), Parse("""{"type":"type","text":"héllo 😀\n"}"""));
    }

    [Fact]
    public void Type_allows_empty_text()
    {
        Assert.Equal(new TypeText(string.Empty), Parse("""{"type":"type","text":""}"""));
    }

    [Theory]
    [InlineData("""{"type":"type"}""")]
    [InlineData("""{"type":"type","text":42}""")]
    [InlineData("""{"type":"type","text":null}""")]
    public void Type_malformed_returns_null(string json)
    {
        Assert.Null(Parse(json));
    }

    [Fact]
    public void Key_resolves_name_without_modifiers()
    {
        Assert.Equal(new KeyPress(0x0D, Modifiers.None), Parse("""{"type":"key","key":"Enter"}"""));
    }

    [Fact]
    public void Key_maps_lowercase_modifier_names_to_flags()
    {
        Assert.Equal(
            new KeyPress(0x54, Modifiers.Ctrl | Modifiers.Shift),
            Parse("""{"type":"key","key":"T","modifiers":["ctrl","shift"]}"""));
    }

    [Fact]
    public void Key_accepts_modifier_aliases_and_null_modifiers()
    {
        Assert.Equal(new KeyPress(0x5B, Modifiers.None), Parse("""{"type":"key","key":"Win","modifiers":null}"""));
        Assert.Equal(new KeyPress(0x41, Modifiers.Win | Modifiers.Alt), Parse("""{"type":"key","key":"a","modifiers":["Meta","alt"]}"""));
        Assert.Equal(new KeyPress(0x41, Modifiers.Ctrl), Parse("""{"type":"key","key":"a","modifiers":["control"]}"""));
    }

    [Fact]
    public void Key_can_be_a_modifier_pressed_alone()
    {
        Assert.Equal(new KeyPress(0x10, Modifiers.None), Parse("""{"type":"key","key":"Shift"}"""));
    }

    [Theory]
    [InlineData("""{"type":"key"}""")]
    [InlineData("""{"type":"key","key":"NoSuchKey"}""")]
    [InlineData("""{"type":"key","key":""}""")]
    [InlineData("""{"type":"key","key":"a","modifiers":"ctrl"}""")]
    [InlineData("""{"type":"key","key":"a","modifiers":["hyper"]}""")]
    [InlineData("""{"type":"key","key":"a","modifiers":[1]}""")]
    public void Key_malformed_returns_null(string json)
    {
        Assert.Null(Parse(json));
    }

    [Theory]
    [InlineData("Ctrl+C", 0x43, Modifiers.Ctrl)]
    [InlineData("Ctrl+V", 0x56, Modifiers.Ctrl)]
    [InlineData("ctrl + shift + t", 0x54, Modifiers.Ctrl | Modifiers.Shift)]
    [InlineData("Alt+F4", 0x73, Modifiers.Alt)]
    [InlineData("Win+E", 0x45, Modifiers.Win)]
    [InlineData("F5", 0x74, Modifiers.None)]
    [InlineData("Win", 0x5B, Modifiers.None)]
    [InlineData("Ctrl++", 0xBB, Modifiers.Ctrl)]
    [InlineData("Control+Meta+Delete", 0x2E, Modifiers.Ctrl | Modifiers.Win)]
    public void Hotkey_combo_is_a_key_press_with_modifiers(string combo, int vk, Modifiers modifiers)
    {
        Assert.Equal(new KeyPress((ushort)vk, modifiers), Parse($$"""{"type":"hotkey","combo":"{{combo}}"}"""));
    }

    [Fact]
    public void Hotkey_ctrl_shift_esc_opens_task_manager()
    {
        // Injected Ctrl+Shift+Esc is unreliable from an unelevated process (PowerShell agent starts taskmgr).
        Assert.Equal(new OpenTaskManager(), Parse("""{"type":"hotkey","combo":"Ctrl+Shift+Esc"}"""));
        Assert.Equal(new OpenTaskManager(), Parse("""{"type":"hotkey","combo":"shift+ctrl+escape"}"""));
    }

    [Theory]
    [InlineData("""{"type":"hotkey"}""")]
    [InlineData("""{"type":"hotkey","combo":""}""")]
    [InlineData("""{"type":"hotkey","combo":"  "}""")]
    [InlineData("""{"type":"hotkey","combo":7}""")]
    [InlineData("""{"type":"hotkey","combo":"Ctrl+NoSuchKey"}""")]
    [InlineData("""{"type":"hotkey","combo":"Hyper+C"}""")]
    [InlineData("""{"type":"hotkey","combo":"C+Ctrl"}""")]
    public void Hotkey_malformed_returns_null(string json)
    {
        Assert.Null(Parse(json));
    }

    [Fact]
    public void Monitor_selects_by_index()
    {
        Assert.Equal(new SelectMonitor(2), Parse("""{"type":"monitor","index":2}"""));
    }

    [Theory]
    [InlineData("""{"type":"monitor"}""")]
    [InlineData("""{"type":"monitor","index":"1"}""")]
    [InlineData("""{"type":"monitor","index":1.5}""")]
    [InlineData("""{"type":"monitor","index":-1}""")]
    public void Monitor_without_a_non_negative_integer_index_returns_null(string json)
    {
        Assert.Null(Parse(json));
    }

    [Theory]
    [InlineData("""{"type":"launch","target":"notepad"}""")]
    [InlineData("""{"type":"shell","command":"dir"}""")]
    [InlineData("""{"type":"quality","maxWidth":800,"jpegQuality":50}""")]
    [InlineData("""{"type":"MouseMove","x":0,"y":0}""")]
    public void Unsupported_or_unknown_types_return_null(string json)
    {
        Assert.Null(Parse(json));
    }

    [Theory]
    [InlineData("""{}""")]
    [InlineData("""{"type":null}""")]
    [InlineData("""{"type":7}""")]
    [InlineData("""[{"type":"click"}]""")]
    [InlineData("""null""")]
    [InlineData("\"click\"")]
    [InlineData("""42""")]
    public void Non_object_or_missing_type_returns_null(string json)
    {
        Assert.Null(Parse(json));
    }

    [Fact]
    public void Default_element_never_throws()
    {
        Assert.Null(InputParser.Parse(default));
    }
}
