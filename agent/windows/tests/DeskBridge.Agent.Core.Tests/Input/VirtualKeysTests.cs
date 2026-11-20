using DeskBridge.Agent.Core.Input;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Input;

public class VirtualKeysTests
{
    [Theory]
    [InlineData("Enter", 0x0D)]
    [InlineData("Return", 0x0D)]
    [InlineData("Tab", 0x09)]
    [InlineData("Escape", 0x1B)]
    [InlineData("Esc", 0x1B)]
    [InlineData("Backspace", 0x08)]
    [InlineData("Delete", 0x2E)]
    [InlineData("Del", 0x2E)]
    [InlineData("Insert", 0x2D)]
    [InlineData("Ins", 0x2D)]
    [InlineData("Home", 0x24)]
    [InlineData("End", 0x23)]
    [InlineData("PageUp", 0x21)]
    [InlineData("PgUp", 0x21)]
    [InlineData("PageDown", 0x22)]
    [InlineData("PgDn", 0x22)]
    [InlineData("Space", 0x20)]
    [InlineData("ArrowUp", 0x26)]
    [InlineData("Up", 0x26)]
    [InlineData("ArrowDown", 0x28)]
    [InlineData("Down", 0x28)]
    [InlineData("ArrowLeft", 0x25)]
    [InlineData("Left", 0x25)]
    [InlineData("ArrowRight", 0x27)]
    [InlineData("Right", 0x27)]
    [InlineData("PrintScreen", 0x2C)]
    [InlineData("PrtSc", 0x2C)]
    [InlineData("Pause", 0x13)]
    [InlineData("CapsLock", 0x14)]
    [InlineData("Menu", 0x5D)]
    [InlineData("Apps", 0x5D)]
    [InlineData("VolumeMute", 0xAD)]
    [InlineData("VolumeDown", 0xAE)]
    [InlineData("VolumeUp", 0xAF)]
    [InlineData("MediaNext", 0xB0)]
    [InlineData("MediaPrev", 0xB1)]
    [InlineData("MediaPlayPause", 0xB3)]
    [InlineData("-", 0xBD)]
    [InlineData("=", 0xBB)]
    [InlineData("+", 0xBB)]
    [InlineData("[", 0xDB)]
    [InlineData("]", 0xDD)]
    [InlineData(";", 0xBA)]
    [InlineData(",", 0xBC)]
    [InlineData(".", 0xBE)]
    [InlineData("/", 0xBF)]
    [InlineData("Ctrl", 0x11)]
    [InlineData("Control", 0x11)]
    [InlineData("Alt", 0x12)]
    [InlineData("Shift", 0x10)]
    [InlineData("Win", 0x5B)]
    [InlineData("Meta", 0x5B)]
    [InlineData("Cmd", 0x5B)]
    [InlineData("0", 0x30)]
    [InlineData("9", 0x39)]
    [InlineData("F1", 0x70)]
    [InlineData("F12", 0x7B)]
    [InlineData("F24", 0x87)]
    public void Known_names_map_to_the_powershell_agent_codes(string name, int expected)
    {
        Assert.True(VirtualKeys.TryGetVirtualKey(name, out ushort vk));
        Assert.Equal(expected, vk);
    }

    [Theory]
    [InlineData("a", 0x41)]
    [InlineData("A", 0x41)]
    [InlineData("z", 0x5A)]
    [InlineData("Z", 0x5A)]
    [InlineData("enter", 0x0D)]
    [InlineData("arrowleft", 0x25)]
    [InlineData("f5", 0x74)]
    public void Names_are_case_insensitive(string name, int expected)
    {
        Assert.True(VirtualKeys.TryGetVirtualKey(name, out ushort vk));
        Assert.Equal(expected, vk);
    }

    [Theory]
    [InlineData("F25")]
    [InlineData("F0")]
    [InlineData("NoSuchKey")]
    [InlineData("Ctrl+C")]
    [InlineData("")]
    [InlineData(" ")]
    public void Unknown_names_are_rejected(string name)
    {
        Assert.False(VirtualKeys.TryGetVirtualKey(name, out _));
    }

    [Fact]
    public void Null_name_is_rejected()
    {
        Assert.False(VirtualKeys.TryGetVirtualKey(null!, out _));
    }
}
