namespace DeskBridge.Agent.Core.Input;

[Flags]
public enum Modifiers
{
    None = 0,
    Ctrl = 1,
    Alt = 2,
    Shift = 4,
    Win = 8,
}

public enum MouseButton
{
    Left,
    Right,
    Middle,
}

/// <summary>A typed input command parsed from a <c>client:input</c> payload.</summary>
public abstract record InputCommand;

/// <summary>Move to a position normalized to 0..1 on the active monitor.</summary>
public sealed record MouseMoveAbsolute(double X, double Y) : InputCommand;

/// <summary>Move the cursor by a pixel delta, clamped to the active monitor.</summary>
public sealed record MouseMoveRelative(int Dx, int Dy) : InputCommand;

/// <param name="MoveTo">Position to move to before clicking, if the payload carried one.</param>
public sealed record MouseClick(MouseButton Button, bool DoubleClick, MouseMoveAbsolute? MoveTo) : InputCommand;

public sealed record MouseButtonState(MouseButton Button, bool IsDown) : InputCommand;

/// <summary>Wheel movement in notches (1 notch = WHEEL_DELTA 120). Positive DeltaY scrolls down, as in the browser.</summary>
public sealed record Scroll(double DeltaX, double DeltaY) : InputCommand;

/// <summary>Text typed as Unicode. Line feeds become Enter and tabs become Tab at injection time.</summary>
public sealed record TypeText(string Text) : InputCommand;

public sealed record KeyPress(ushort VirtualKey, Modifiers Modifiers) : InputCommand;

/// <summary>Ctrl+Shift+Esc: injecting it is unreliable from an unelevated process, so Task Manager is started instead.</summary>
public sealed record OpenTaskManager : InputCommand;

/// <summary>
/// Switch the streamed monitor. Not injected: the agent routes it to the display selection, which
/// applies it on the capture thread.
/// </summary>
public sealed record SelectMonitor(int Index) : InputCommand;
