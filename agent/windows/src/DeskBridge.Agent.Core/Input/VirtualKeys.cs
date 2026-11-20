namespace DeskBridge.Agent.Core.Input;

/// <summary>
/// Key-name to Windows virtual-key lookup. Mirrors <c>$script:VkMap</c> and <c>$script:ModMap</c>
/// in the PowerShell agent, so the same names work on both agents. Names are case-insensitive.
/// </summary>
public static class VirtualKeys
{
    private static readonly Dictionary<string, ushort> Map = Build();

    public static bool TryGetVirtualKey(string name, out ushort virtualKey)
    {
        if (name is null)
        {
            virtualKey = 0;
            return false;
        }
        return Map.TryGetValue(name, out virtualKey);
    }

    private const ushort VkShift = 0x10;
    private const ushort VkControl = 0x11;
    private const ushort VkMenu = 0x12;
    private const ushort VkLWin = 0x5B;

    private static Dictionary<string, ushort> Build()
    {
        var map = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
        {
            ["Enter"] = 0x0D,
            ["Return"] = 0x0D,
            ["Tab"] = 0x09,
            ["Escape"] = 0x1B,
            ["Esc"] = 0x1B,
            ["Backspace"] = 0x08,
            ["Delete"] = 0x2E,
            ["Del"] = 0x2E,
            ["Insert"] = 0x2D,
            ["Ins"] = 0x2D,
            ["Home"] = 0x24,
            ["End"] = 0x23,
            ["PageUp"] = 0x21,
            ["PgUp"] = 0x21,
            ["PageDown"] = 0x22,
            ["PgDn"] = 0x22,
            ["Space"] = 0x20,
            ["ArrowUp"] = 0x26,
            ["Up"] = 0x26,
            ["ArrowDown"] = 0x28,
            ["Down"] = 0x28,
            ["ArrowLeft"] = 0x25,
            ["Left"] = 0x25,
            ["ArrowRight"] = 0x27,
            ["Right"] = 0x27,
            ["PrintScreen"] = 0x2C,
            ["PrtSc"] = 0x2C,
            ["Pause"] = 0x13,
            ["CapsLock"] = 0x14,
            ["Menu"] = 0x5D,
            ["Apps"] = 0x5D,
            ["VolumeMute"] = 0xAD,
            ["VolumeDown"] = 0xAE,
            ["VolumeUp"] = 0xAF,
            ["MediaNext"] = 0xB0,
            ["MediaPrev"] = 0xB1,
            ["MediaPlayPause"] = 0xB3,
            ["-"] = 0xBD,
            ["="] = 0xBB,
            ["+"] = 0xBB,
            ["["] = 0xDB,
            ["]"] = 0xDD,
            [";"] = 0xBA,
            [","] = 0xBC,
            ["."] = 0xBE,
            ["/"] = 0xBF,
            // Modifiers can also be pressed alone ("key": "Shift").
            ["Ctrl"] = VkControl,
            ["Control"] = VkControl,
            ["Alt"] = VkMenu,
            ["Shift"] = VkShift,
            ["Win"] = VkLWin,
            ["Meta"] = VkLWin,
            ["Cmd"] = VkLWin,
        };

        for (ushort c = 'A'; c <= 'Z'; c++)
        {
            map[((char)c).ToString()] = c;
        }
        for (ushort d = 0; d <= 9; d++)
        {
            map[d.ToString()] = (ushort)(0x30 + d);
        }
        for (ushort f = 1; f <= 24; f++)
        {
            map["F" + f.ToString()] = (ushort)(0x6F + f);
        }
        return map;
    }
}
