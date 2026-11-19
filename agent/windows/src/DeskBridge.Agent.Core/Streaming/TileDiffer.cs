using System.Numerics;
using System.Runtime.InteropServices;

namespace DeskBridge.Agent.Core.Streaming;

/// <summary>
/// A private, tightly packed copy of a captured frame (stride = width * 4). It becomes the diff reference
/// once <see cref="TileDiffer.Commit"/> accepts it; until then whoever holds it must <see cref="Release"/> it
/// if the frame is thrown away.
/// </summary>
public sealed class PixelSnapshot
{
    private enum State { Live, Reference, Released }

    private readonly TileDiffer _owner;
    private State _state;

    internal PixelSnapshot(TileDiffer owner, byte[] buffer, int width, int height, int generation)
    {
        _owner = owner;
        Buffer = buffer;
        Width = width;
        Height = height;
        Generation = generation;
    }

    internal byte[] Buffer { get; }
    public int Width { get; }
    public int Height { get; }
    public int Stride => Width * 4;
    /// <summary>Reference generation this snapshot was diffed against.</summary>
    public int Generation { get; }
    public ReadOnlySpan<byte> Pixels => Buffer.AsSpan(0, Stride * Height);

    /// <summary>Returns the buffer for reuse. No-op once committed or already released.</summary>
    public void Release()
    {
        lock (_owner.Gate)
        {
            if (_state != State.Live) return;
            _state = State.Released;
            _owner.Recycle(Buffer);
        }
    }

    // Callers hold the owner's gate.
    internal void MarkReference() => _state = State.Reference;
    internal void MarkRecycled() => _state = State.Released;
    internal bool IsLive => _state == State.Live;
}

/// <summary>Outcome of <see cref="TileDiffer.Diff"/>. <see cref="Changed"/> is valid until the next Diff call.</summary>
public readonly struct DiffResult
{
    private readonly bool[]? _grid;

    internal DiffResult(bool[] grid, int tilesX, int tilesY, int changedCount, bool hasReference, int generation, PixelSnapshot? snapshot)
    {
        _grid = grid;
        TilesX = tilesX;
        TilesY = tilesY;
        ChangedCount = changedCount;
        HasReference = hasReference;
        Generation = generation;
        Snapshot = snapshot;
    }

    public int TilesX { get; }
    public int TilesY { get; }
    public int TotalTiles => TilesX * TilesY;
    public int ChangedCount { get; }
    /// <summary>False when there was nothing valid to compare against (first frame or size change): every tile counts as changed.</summary>
    public bool HasReference { get; }
    /// <summary>Reference generation the comparison used; the frame is stale if <see cref="TileDiffer.Generation"/> moved on.</summary>
    public int Generation { get; }
    /// <summary>Row-major tile grid, true = changed.</summary>
    public ReadOnlySpan<bool> Changed => _grid is null ? default : _grid.AsSpan(0, TotalTiles);
    /// <summary>Copy of the frame, null when nothing changed (nothing to send, nothing to keep).</summary>
    public PixelSnapshot? Snapshot { get; }
}

/// <summary>
/// 64x64 tile diff of BGRA frames (alpha ignored) against the last frame handed to the sender.
/// The reference only moves through <see cref="Commit"/>, which bumps <see cref="Generation"/>, so a
/// frame diffed against an outdated reference can be recognised and discarded. Diff runs on the capture
/// thread; Commit, Invalidate and Generation may be called from any thread.
/// </summary>
public sealed class TileDiffer
{
    public const int TileSize = 64;

    private readonly Stack<byte[]> _pool = new();
    private PixelSnapshot? _reference;
    private int _generation;
    private bool[] _grid = [];
    private bool[] _mask = [];

    internal object Gate { get; } = new();

    public int Generation { get { lock (Gate) return _generation; } }
    public bool HasReference { get { lock (Gate) return _reference is not null; } }

    /// <summary>
    /// Compares <paramref name="image"/> with the reference. <paramref name="dirtyHint"/> (if not null) lists
    /// every region that may have changed since the reference; tiles outside it are not compared and count
    /// as unchanged. Pass <paramref name="compare"/> = false when the frame will be a keyframe anyway: only
    /// the snapshot is taken and every tile counts as changed.
    /// </summary>
    public DiffResult Diff(in FrameImage image, IReadOnlyList<PixelRect>? dirtyHint = null, bool compare = true)
    {
        int w = image.Width, h = image.Height;
        if (w <= 0 || h <= 0) throw new ArgumentException("empty image", nameof(image));
        int tilesX = (w + TileSize - 1) / TileSize;
        int tilesY = (h + TileSize - 1) / TileSize;
        int total = tilesX * tilesY;
        if (_grid.Length < total) { _grid = new bool[total]; _mask = new bool[total]; }

        PixelSnapshot? reference;
        int generation;
        lock (Gate) { reference = _reference; generation = _generation; }

        bool usable = reference is not null && reference.Width == w && reference.Height == h;
        if (!usable || !compare)
        {
            Array.Fill(_grid, true, 0, total);
            return new DiffResult(_grid, tilesX, tilesY, total, usable, generation, Copy(image, generation));
        }

        ReadOnlySpan<byte> src = image.Pixels.Span;
        ReadOnlySpan<byte> refPix = reference!.Buffer;
        int refStride = reference.Stride;
        BuildMask(dirtyHint, tilesX, tilesY, w, h);
        int changed = 0;
        for (int ty = 0; ty < tilesY; ty++)
        {
            for (int tx = 0; tx < tilesX; tx++)
            {
                int i = ty * tilesX + tx;
                bool diff = _mask[i] && TileDiffers(src, image.Stride, refPix, refStride, tx, ty, w, h);
                _grid[i] = diff;
                if (diff) changed++;
            }
        }
        PixelSnapshot? snap = changed > 0 ? Copy(image, generation) : null;
        return new DiffResult(_grid, tilesX, tilesY, changed, true, generation, snap);
    }

    /// <summary>
    /// Makes <paramref name="snapshot"/> the reference (it was handed to the sender) and bumps the generation.
    /// Returns false, changing nothing, when the snapshot was diffed against an outdated reference.
    /// </summary>
    public bool Commit(PixelSnapshot snapshot)
    {
        lock (Gate)
        {
            if (snapshot.Generation != _generation || !snapshot.IsLive) return false;
            if (_reference is { } old) { old.MarkRecycled(); Recycle(old.Buffer); }
            _reference = snapshot;
            snapshot.MarkReference();
            _generation++;
            return true;
        }
    }

    /// <summary>Drops the reference (monitor switch, capture lost): the next frame must be a keyframe, and in-flight diffs go stale.</summary>
    public void Invalidate()
    {
        lock (Gate)
        {
            if (_reference is { } old) { old.MarkRecycled(); Recycle(old.Buffer); }
            _reference = null;
            _generation++;
        }
    }

    // Callers hold Gate.
    internal void Recycle(byte[] buffer)
    {
        if (_pool.Count < 4) _pool.Push(buffer);
    }

    private PixelSnapshot Copy(in FrameImage image, int generation)
    {
        int rowBytes = image.Width * 4;
        int size = rowBytes * image.Height;
        byte[]? buf = null;
        lock (Gate)
        {
            while (_pool.Count > 0)
            {
                byte[] b = _pool.Pop();
                if (b.Length == size) { buf = b; break; }
            }
        }
        buf ??= new byte[size];
        ReadOnlySpan<byte> src = image.Pixels.Span;
        if (image.Stride == rowBytes)
        {
            src[..size].CopyTo(buf);
        }
        else
        {
            for (int y = 0; y < image.Height; y++) src.Slice(y * image.Stride, rowBytes).CopyTo(buf.AsSpan(y * rowBytes, rowBytes));
        }
        return new PixelSnapshot(this, buf, image.Width, image.Height, generation);
    }

    private void BuildMask(IReadOnlyList<PixelRect>? hint, int tilesX, int tilesY, int w, int h)
    {
        int total = tilesX * tilesY;
        if (hint is null) { Array.Fill(_mask, true, 0, total); return; }
        Array.Clear(_mask, 0, total);
        foreach (PixelRect r in hint)
        {
            int x0 = Math.Max(0, r.X), y0 = Math.Max(0, r.Y);
            int x1 = Math.Min(w, r.X + r.Width), y1 = Math.Min(h, r.Y + r.Height);
            if (x1 <= x0 || y1 <= y0) continue;
            for (int ty = y0 / TileSize; ty <= (y1 - 1) / TileSize; ty++)
                for (int tx = x0 / TileSize; tx <= (x1 - 1) / TileSize; tx++)
                    _mask[ty * tilesX + tx] = true;
        }
    }

    private static bool TileDiffers(ReadOnlySpan<byte> cur, int curStride, ReadOnlySpan<byte> refPix, int refStride, int tx, int ty, int w, int h)
    {
        int x0 = tx * TileSize * 4;
        int len = (Math.Min((tx + 1) * TileSize, w) * 4) - x0;
        int y0 = ty * TileSize;
        int y1 = Math.Min(y0 + TileSize, h);
        for (int y = y0; y < y1; y++)
        {
            ReadOnlySpan<byte> a = cur.Slice(y * curStride + x0, len);
            ReadOnlySpan<byte> b = refPix.Slice(y * refStride + x0, len);
            // Fast path for identical bytes; the masked compare only runs for rows whose bytes differ,
            // to tell a real change from alpha-only noise.
            if (!a.SequenceEqual(b) && !EqualIgnoringAlpha(a, b)) return true;
        }
        return false;
    }

    private static bool EqualIgnoringAlpha(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b)
    {
        ReadOnlySpan<uint> ua = MemoryMarshal.Cast<byte, uint>(a);
        ReadOnlySpan<uint> ub = MemoryMarshal.Cast<byte, uint>(b);
        int i = 0;
        if (Vector.IsHardwareAccelerated)
        {
            var mask = new Vector<uint>(0x00FFFFFFu);
            int n = Vector<uint>.Count;
            for (; i <= ua.Length - n; i += n)
            {
                if (!Vector.EqualsAll(new Vector<uint>(ua[i..]) & mask, new Vector<uint>(ub[i..]) & mask)) return false;
            }
        }
        for (; i < ua.Length; i++)
        {
            if (((ua[i] ^ ub[i]) & 0x00FFFFFFu) != 0) return false;
        }
        return true;
    }
}
