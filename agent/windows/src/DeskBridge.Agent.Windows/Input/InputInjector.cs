using System.Runtime.InteropServices;
using DeskBridge.Agent.Core.Input;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.UI.Input.KeyboardAndMouse;
using Windows.Win32.UI.WindowsAndMessaging;

namespace DeskBridge.Agent.Windows.Input;

/// <summary>
/// Turns input commands into SendInput calls. Coordinates are physical pixels, so the process must
/// be per-monitor DPI aware before the first call (see the DPI convention in AGENTS.md).
/// </summary>
public sealed class InputInjector : IInputInjector
{
    /// <summary>Pause between the clicks of a double click. The PowerShell agent uses the same gap.</summary>
    private const int DoubleClickGapMs = 25;

    /// <summary>Settle time after moving onto a click target, so hover state updates first.</summary>
    private const int MoveSettleMs = 12;

    private const ushort VkShift = 0x10;
    private const ushort VkControl = 0x11;
    private const ushort VkMenu = 0x12;
    private const ushort VkLWin = 0x5B;
    private const ushort VkL = 0x4C;

    private readonly Func<(int X, int Y, int Width, int Height)> _activeMonitor;

    /// <param name="activeMonitor">Bounds of the monitor being streamed, in virtual-desktop physical pixels.</param>
    public InputInjector(Func<(int X, int Y, int Width, int Height)> activeMonitor)
    {
        _activeMonitor = activeMonitor;
    }

    public void Inject(InputCommand command)
    {
        switch (command)
        {
            case MouseMoveAbsolute move:
                MoveToNormalized(move.X, move.Y);
                break;
            case MouseMoveRelative move:
                MoveBy(move.Dx, move.Dy);
                break;
            case MouseClick click:
                ClickCommand(click);
                break;
            case MouseButtonState state:
                SendInputs([MouseInput(0, 0, 0, ButtonFlag(state.Button, state.IsDown))]);
                break;
            case Scroll scroll:
                ScrollWheel(scroll);
                break;
            case TypeText text:
                TypeUnicode(text.Text);
                break;
            case KeyPress key:
                PressKey(key.VirtualKey, key.Modifiers);
                break;
            case OpenTaskManager:
                using (System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("taskmgr.exe") { UseShellExecute = true })) { }
                break;
        }
    }

    private void MoveToNormalized(double x, double y)
    {
        ScreenRect monitor = ActiveMonitor();
        (int px, int py) = InputMath.NormalizedToPixel(x, y, monitor);
        MoveToPixel(px, py);
    }

    private void MoveBy(int dx, int dy)
    {
        if ((dx == 0 && dy == 0) || !PInvoke.GetCursorPos(out var cursor))
        {
            return;
        }
        (int px, int py) = InputMath.RelativeTarget(cursor.X, cursor.Y, dx, dy, ActiveMonitor());
        MoveToPixel(px, py);
    }

    private static void MoveToPixel(int px, int py)
    {
        (int ax, int ay) = InputMath.PixelToAbsolute(px, py, VirtualScreen());
        SendInputs([MouseInput(ax, ay, 0, MOUSE_EVENT_FLAGS.MOUSEEVENTF_MOVE | MOUSE_EVENT_FLAGS.MOUSEEVENTF_ABSOLUTE | MOUSE_EVENT_FLAGS.MOUSEEVENTF_VIRTUALDESK)]);
    }

    private void ClickCommand(MouseClick click)
    {
        if (click.MoveTo is { } target)
        {
            MoveToNormalized(target.X, target.Y);
            Thread.Sleep(MoveSettleMs);
        }

        Click(click.Button);
        if (click.DoubleClick)
        {
            Thread.Sleep(DoubleClickGapMs);
            Click(click.Button);
        }
    }

    private static void Click(MouseButton button)
    {
        SendInputs(
        [
            MouseInput(0, 0, 0, ButtonFlag(button, isDown: true)),
            MouseInput(0, 0, 0, ButtonFlag(button, isDown: false)),
        ]);
    }

    private static void ScrollWheel(Scroll scroll)
    {
        var inputs = new List<INPUT>(2);
        int vertical = InputMath.WheelData(scroll.DeltaY, horizontal: false);
        if (vertical != 0)
        {
            inputs.Add(MouseInput(0, 0, unchecked((uint)vertical), MOUSE_EVENT_FLAGS.MOUSEEVENTF_WHEEL));
        }
        int horizontal = InputMath.WheelData(scroll.DeltaX, horizontal: true);
        if (horizontal != 0)
        {
            inputs.Add(MouseInput(0, 0, unchecked((uint)horizontal), MOUSE_EVENT_FLAGS.MOUSEEVENTF_HWHEEL));
        }
        SendInputs(inputs);
    }

    private static void TypeUnicode(string text)
    {
        var inputs = new List<INPUT>(text.Length * 2);
        foreach (TextStep step in InputMath.PlanText(text))
        {
            if (step.VirtualKey != 0)
            {
                inputs.Add(KeyInput(step.VirtualKey, 0, 0));
                inputs.Add(KeyInput(step.VirtualKey, 0, KEYBD_EVENT_FLAGS.KEYEVENTF_KEYUP));
            }
            else
            {
                // One event per UTF-16 unit: an emoji arrives as its two surrogate halves.
                inputs.Add(KeyInput(0, step.Unit, KEYBD_EVENT_FLAGS.KEYEVENTF_UNICODE));
                inputs.Add(KeyInput(0, step.Unit, KEYBD_EVENT_FLAGS.KEYEVENTF_UNICODE | KEYBD_EVENT_FLAGS.KEYEVENTF_KEYUP));
            }
        }
        SendInputs(inputs);
    }

    private static void PressKey(ushort vk, Modifiers modifiers)
    {
        // Win+L is handled by the secure desktop and cannot be injected.
        if (modifiers == Modifiers.Win && vk == VkL)
        {
            PInvoke.LockWorkStation();
            return;
        }

        var held = new List<ushort>(4);
        if (modifiers.HasFlag(Modifiers.Ctrl)) held.Add(VkControl);
        if (modifiers.HasFlag(Modifiers.Alt)) held.Add(VkMenu);
        if (modifiers.HasFlag(Modifiers.Shift)) held.Add(VkShift);
        if (modifiers.HasFlag(Modifiers.Win)) held.Add(VkLWin);

        var inputs = new List<INPUT>(held.Count * 2 + 2);
        foreach (ushort modifier in held)
        {
            inputs.Add(KeyInput(modifier, 0, ExtendedFlag(modifier)));
        }
        inputs.Add(KeyInput(vk, 0, ExtendedFlag(vk)));
        inputs.Add(KeyInput(vk, 0, ExtendedFlag(vk) | KEYBD_EVENT_FLAGS.KEYEVENTF_KEYUP));
        for (int i = held.Count - 1; i >= 0; i--)
        {
            inputs.Add(KeyInput(held[i], 0, ExtendedFlag(held[i]) | KEYBD_EVENT_FLAGS.KEYEVENTF_KEYUP));
        }
        SendInputs(inputs);
    }

    private static MOUSE_EVENT_FLAGS ButtonFlag(MouseButton button, bool isDown) => (button, isDown) switch
    {
        (MouseButton.Left, true) => MOUSE_EVENT_FLAGS.MOUSEEVENTF_LEFTDOWN,
        (MouseButton.Left, false) => MOUSE_EVENT_FLAGS.MOUSEEVENTF_LEFTUP,
        (MouseButton.Right, true) => MOUSE_EVENT_FLAGS.MOUSEEVENTF_RIGHTDOWN,
        (MouseButton.Right, false) => MOUSE_EVENT_FLAGS.MOUSEEVENTF_RIGHTUP,
        (MouseButton.Middle, true) => MOUSE_EVENT_FLAGS.MOUSEEVENTF_MIDDLEDOWN,
        _ => MOUSE_EVENT_FLAGS.MOUSEEVENTF_MIDDLEUP,
    };

    private static KEYBD_EVENT_FLAGS ExtendedFlag(ushort vk) =>
        InputMath.IsExtendedKey(vk) ? KEYBD_EVENT_FLAGS.KEYEVENTF_EXTENDEDKEY : 0;

    private static INPUT MouseInput(int dx, int dy, uint mouseData, MOUSE_EVENT_FLAGS flags)
    {
        var input = new INPUT { type = INPUT_TYPE.INPUT_MOUSE };
        input.Anonymous.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = mouseData, dwFlags = flags };
        return input;
    }

    private static INPUT KeyInput(ushort vk, ushort scan, KEYBD_EVENT_FLAGS flags)
    {
        var input = new INPUT { type = INPUT_TYPE.INPUT_KEYBOARD };
        input.Anonymous.ki = new KEYBDINPUT { wVk = (VIRTUAL_KEY)vk, wScan = scan, dwFlags = flags };
        return input;
    }

    private static void SendInputs(IReadOnlyList<INPUT> inputs)
    {
        if (inputs.Count == 0)
        {
            return;
        }
        // SendInput returns how many events were inserted. A value of 0 usually means UIPI blocked
        // the input (an elevated window has focus). That is not an error worth stopping the queue for.
        PInvoke.SendInput(inputs.ToArray(), Marshal.SizeOf<INPUT>());
    }

    private ScreenRect ActiveMonitor()
    {
        (int x, int y, int width, int height) = _activeMonitor();
        return new ScreenRect(x, y, width, height);
    }

    private static ScreenRect VirtualScreen() => new(
        PInvoke.GetSystemMetrics(SYSTEM_METRICS_INDEX.SM_XVIRTUALSCREEN),
        PInvoke.GetSystemMetrics(SYSTEM_METRICS_INDEX.SM_YVIRTUALSCREEN),
        PInvoke.GetSystemMetrics(SYSTEM_METRICS_INDEX.SM_CXVIRTUALSCREEN),
        PInvoke.GetSystemMetrics(SYSTEM_METRICS_INDEX.SM_CYVIRTUALSCREEN));
}
