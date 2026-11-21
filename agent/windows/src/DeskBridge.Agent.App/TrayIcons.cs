using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using DeskBridge.Agent.Core.Status;

namespace DeskBridge.Agent.App;

/// <summary>
/// Tray icons drawn at the system small-icon size (so they stay sharp at any DPI) instead of shipping .ico assets:
/// a coloured disc with a screen glyph. Grey = not connected, blue = online, orange = a controller is connected.
/// </summary>
internal sealed class TrayIcons : IDisposable
{
    private static readonly Color Grey = Color.FromArgb(0x8A, 0x8A, 0x8A);
    private static readonly Color Blue = Color.FromArgb(0x2E, 0x7D, 0xD7);
    private static readonly Color Orange = Color.FromArgb(0xE8, 0x59, 0x0C);

    private readonly Icon _offline = Draw(Grey, pause: false);
    private readonly Icon _online = Draw(Blue, pause: false);
    private readonly Icon _controlled = Draw(Orange, pause: false);
    private readonly Icon _paused = Draw(Grey, pause: true);

    public Icon For(AgentStatusKind kind) => kind switch
    {
        AgentStatusKind.Online => _online,
        AgentStatusKind.Controlled => _controlled,
        AgentStatusKind.Paused => _paused,
        _ => _offline,
    };

    public void Dispose()
    {
        _offline.Dispose();
        _online.Dispose();
        _controlled.Dispose();
        _paused.Dispose();
    }

    private static Icon Draw(Color disc, bool pause)
    {
        int size = SystemInformation.SmallIconSize.Width;
        using var bitmap = new Bitmap(size, size);
        using (Graphics g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using (var brush = new SolidBrush(disc)) g.FillEllipse(brush, 0, 0, size - 1, size - 1);

            float u = size / 16f;
            using var white = new SolidBrush(Color.White);
            if (pause)
            {
                g.FillRectangle(white, 5 * u, 4 * u, 2 * u, 8 * u);
                g.FillRectangle(white, 9 * u, 4 * u, 2 * u, 8 * u);
            }
            else
            {
                using var pen = new Pen(Color.White, Math.Max(1f, 1.25f * u));
                g.DrawRectangle(pen, 4 * u, 4.5f * u, 8 * u, 5.5f * u);
                g.FillRectangle(white, 7.25f * u, 10 * u, 1.5f * u, 1.5f * u);
                g.FillRectangle(white, 5.5f * u, 11.5f * u, 5 * u, 1.1f * u);
            }
        }

        nint handle = bitmap.GetHicon();
        try
        {
            using var temporary = Icon.FromHandle(handle);
            return (Icon)temporary.Clone();
        }
        finally
        {
            DestroyIcon(handle);
        }
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(nint hIcon);
}
