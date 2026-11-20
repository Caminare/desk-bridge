namespace DeskBridge.Agent.Core.Streaming;

/// <summary>
/// Merges changed tiles into rectangles: horizontal runs per tile row, then runs with the same span on
/// consecutive rows are joined. A video area becomes one JPEG instead of many strips. Output order is
/// the order rectangles complete, like the PowerShell agent. Not thread safe; reuses its buffers.
/// </summary>
public sealed class RegionMerger
{
    private struct Run { public int Start, End, FirstRow, LastRow; }

    private List<Run> _open = new();
    private List<Run> _next = new();
    private readonly List<Run> _done = new();
    private readonly List<PixelRect> _result = new();

    /// <summary>The returned list is reused by the next call.</summary>
    public IReadOnlyList<PixelRect> Merge(ReadOnlySpan<bool> changed, int tilesX, int tilesY, int frameWidth, int frameHeight)
    {
        if (changed.Length < tilesX * tilesY) throw new ArgumentException("changed grid too small", nameof(changed));
        _open.Clear();
        _next.Clear();
        _done.Clear();
        _result.Clear();
        for (int ty = 0; ty < tilesY; ty++)
        {
            ReadOnlySpan<bool> row = changed.Slice(ty * tilesX, tilesX);
            _next.Clear();
            int tx = 0;
            while (tx < tilesX)
            {
                if (!row[tx]) { tx++; continue; }
                int start = tx;
                while (tx < tilesX && row[tx]) tx++;
                int match = -1;
                for (int i = 0; i < _open.Count; i++)
                {
                    Run o = _open[i];
                    if (o.Start == start && o.End == tx && o.LastRow == ty - 1) { match = i; break; }
                }
                if (match >= 0)
                {
                    Run m = _open[match];
                    m.LastRow = ty;
                    _open.RemoveAt(match);
                    _next.Add(m);
                }
                else
                {
                    _next.Add(new Run { Start = start, End = tx, FirstRow = ty, LastRow = ty });
                }
            }
            _done.AddRange(_open); // not continued on this row: finished
            (_open, _next) = (_next, _open);
        }
        _done.AddRange(_open);
        foreach (Run r in _done)
        {
            int x = r.Start * TileDiffer.TileSize;
            int y = r.FirstRow * TileDiffer.TileSize;
            int w = Math.Min(r.End * TileDiffer.TileSize, frameWidth) - x;
            int h = Math.Min((r.LastRow + 1) * TileDiffer.TileSize, frameHeight) - y;
            _result.Add(new PixelRect(x, y, w, h));
        }
        return _result;
    }
}
