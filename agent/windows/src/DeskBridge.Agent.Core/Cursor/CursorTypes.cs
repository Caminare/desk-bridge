namespace DeskBridge.Agent.Core.Cursor;

/// <summary>Pointer shape layouts, numbered as DXGI_OUTDUPL_POINTER_SHAPE_TYPE.</summary>
public enum CursorShapeType : uint
{
    /// <summary>1 bpp AND mask on top of a 1 bpp XOR mask (raw height is twice the cursor height).</summary>
    Monochrome = 1,
    /// <summary>32 bpp BGRA with straight alpha.</summary>
    Color = 2,
    /// <summary>32 bpp BGR where the alpha byte is a mask: 0 replaces the screen pixel, 0xFF XORs into it.</summary>
    MaskedColor = 4,
}

/// <summary>
/// A cursor image as sent in <c>host:cursor_shape</c>: straight RGBA, rows top-down, sizes and hotspot
/// in the PC's physical pixels. <see cref="Id"/> is a hash of the pixels and hotspot.
/// </summary>
public sealed record CursorShapeData(string Id, int Width, int Height, int HotX, int HotY, byte[] Rgba);

/// <summary>
/// The pointer as the capture source last saw it. <see cref="X"/>/<see cref="Y"/> are the hotspot in
/// physical pixels relative to the captured monitor's top-left (may lie outside it).
/// </summary>
public readonly record struct CursorSnapshot(bool Visible, int X, int Y, CursorShapeData? Shape);

/// <summary><c>host:cursor</c> payload: hotspot normalized on the streamed monitor.</summary>
public sealed record CursorPositionMessage(double X, double Y, bool Visible, string? Shape);
