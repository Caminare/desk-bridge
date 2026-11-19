using System.Text.Json;

namespace DeskBridge.Agent.Core.Input;

/// <summary>
/// Turns a <c>client:input</c> payload into an <see cref="InputCommand"/>. Field names and
/// coordinate conventions follow the PowerShell agent (<c>Handle-RemoteInput</c>).
/// </summary>
/// <remarks>
/// Never throws. Returns null for unsupported event types, malformed payloads, and values of the
/// wrong type. A missing optional field takes the PowerShell agent's default.
/// </remarks>
public static class InputParser
{
    public static InputCommand? Parse(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object)
        {
            return null;
        }
        if (!payload.TryGetProperty("type", out JsonElement typeElement) ||
            typeElement.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        return typeElement.GetString() switch
        {
            "mousemove" => ParseMouseMove(payload),
            "click" => ParseClick(payload),
            "mousedown" => ParseButtonState(payload, isDown: true),
            "mouseup" => ParseButtonState(payload, isDown: false),
            "scroll" => ParseScroll(payload),
            "type" => ParseType(payload),
            "key" => ParseKey(payload),
            _ => null,
        };
    }

    private static InputCommand? ParseMouseMove(JsonElement obj)
    {
        if (IsTrue(obj, "relative"))
        {
            if (!TryRequiredNumber(obj, "dx", out double dx) || !TryRequiredNumber(obj, "dy", out double dy))
            {
                return null;
            }
            if (!TryToInt(dx, out int rx) || !TryToInt(dy, out int ry))
            {
                return null;
            }
            return new MouseMoveRelative(rx, ry);
        }

        if (!TryRequiredNumber(obj, "x", out double x) || !TryRequiredNumber(obj, "y", out double y))
        {
            return null;
        }
        return new MouseMoveAbsolute(x, y);
    }

    private static InputCommand? ParseClick(JsonElement obj)
    {
        if (!TryOptionalString(obj, "button", out string? buttonName))
        {
            return null;
        }
        // Missing button means left, as in the PowerShell agent. "middle" is accepted because the
        // TypeScript RemoteInputEvent type allows it, even though the PowerShell agent sends left.
        MouseButton? button = buttonName switch
        {
            null => MouseButton.Left,
            "left" => MouseButton.Left,
            "right" => MouseButton.Right,
            "middle" => MouseButton.Middle,
            _ => null,
        };
        if (button is null)
        {
            return null;
        }

        // The PowerShell agent moves only when both x and y are present, and clicks either way.
        if (!TryOptionalNumber(obj, "x", out double? x) || !TryOptionalNumber(obj, "y", out double? y))
        {
            return null;
        }
        MouseMoveAbsolute? moveTo = x is { } px && y is { } py ? new MouseMoveAbsolute(px, py) : null;

        return new MouseClick(button.Value, IsTrue(obj, "double"), moveTo);
    }

    private static InputCommand? ParseButtonState(JsonElement obj, bool isDown)
    {
        if (!TryOptionalString(obj, "button", out string? buttonName))
        {
            return null;
        }
        // Mirrors the TypeScript RemoteInputEvent type, which allows only left and right here.
        MouseButton? button = buttonName switch
        {
            "left" => MouseButton.Left,
            "right" => MouseButton.Right,
            _ => null,
        };
        return button is { } b ? new MouseButtonState(b, isDown) : null;
    }

    private static InputCommand? ParseScroll(JsonElement obj)
    {
        if (!TryOptionalNumber(obj, "deltaX", out double? dx) || !TryOptionalNumber(obj, "deltaY", out double? dy))
        {
            return null;
        }
        if (dx is null && dy is null)
        {
            return null;
        }
        return new Scroll(dx ?? 0, dy ?? 0);
    }

    private static InputCommand? ParseType(JsonElement obj)
    {
        if (!TryRequiredString(obj, "text", out string? text))
        {
            return null;
        }
        return new TypeText(text);
    }

    private static InputCommand? ParseKey(JsonElement obj)
    {
        if (!TryRequiredString(obj, "key", out string? keyName) ||
            !VirtualKeys.TryGetVirtualKey(keyName, out ushort vk))
        {
            return null;
        }
        if (!TryParseModifiers(obj, out Modifiers modifiers))
        {
            return null;
        }
        return new KeyPress(vk, modifiers);
    }

    private static bool TryParseModifiers(JsonElement obj, out Modifiers modifiers)
    {
        modifiers = Modifiers.None;
        if (!obj.TryGetProperty("modifiers", out JsonElement list) || list.ValueKind == JsonValueKind.Null)
        {
            return true;
        }
        if (list.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        foreach (JsonElement item in list.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String)
            {
                return false;
            }
            Modifiers flag = item.GetString()!.ToLowerInvariant() switch
            {
                "ctrl" or "control" => Modifiers.Ctrl,
                "alt" => Modifiers.Alt,
                "shift" => Modifiers.Shift,
                "win" or "meta" or "cmd" => Modifiers.Win,
                _ => Modifiers.None,
            };
            if (flag == Modifiers.None)
            {
                return false;
            }
            modifiers |= flag;
        }
        return true;
    }

    private static bool IsTrue(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.True;

    /// <summary>Missing or null yields null with success. A present value of the wrong type fails.</summary>
    private static bool TryOptionalNumber(JsonElement obj, string name, out double? value)
    {
        value = null;
        if (!obj.TryGetProperty(name, out JsonElement element) || element.ValueKind == JsonValueKind.Null)
        {
            return true;
        }
        if (element.ValueKind != JsonValueKind.Number || !element.TryGetDouble(out double number) || !double.IsFinite(number))
        {
            return false;
        }
        value = number;
        return true;
    }

    private static bool TryRequiredNumber(JsonElement obj, string name, out double value)
    {
        value = 0;
        if (!TryOptionalNumber(obj, name, out double? number) || number is not { } n)
        {
            return false;
        }
        value = n;
        return true;
    }

    private static bool TryOptionalString(JsonElement obj, string name, out string? value)
    {
        value = null;
        if (!obj.TryGetProperty(name, out JsonElement element) || element.ValueKind == JsonValueKind.Null)
        {
            return true;
        }
        if (element.ValueKind != JsonValueKind.String)
        {
            return false;
        }
        value = element.GetString();
        return value is not null;
    }

    private static bool TryRequiredString(JsonElement obj, string name, out string value)
    {
        value = string.Empty;
        if (!TryOptionalString(obj, name, out string? s) || s is null)
        {
            return false;
        }
        value = s;
        return true;
    }

    private static bool TryToInt(double value, out int result)
    {
        double rounded = Math.Round(value);
        if (rounded < int.MinValue || rounded > int.MaxValue)
        {
            result = 0;
            return false;
        }
        result = (int)rounded;
        return true;
    }
}
