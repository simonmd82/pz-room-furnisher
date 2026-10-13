namespace backend.Services;

using backend.Models;

/// <summary>
/// Finds narrow parts of rooms — 1-wide necks/corridors and 2-wide passages — where hardly any
/// furniture fits. A cell's width is the largest k (1..3) such that some k×k square of the
/// room's own cells contains it, with no stair cell and no inner wall crossing the square;
/// cells on either side of a link narrower than one of them (bottlenecks, entry cells of narrow
/// corridors) are narrowed to the link width.
/// </summary>
public static class NarrowAreaDetector
{
    private const int MaxWidth = 3;

    /// <summary>
    /// Per 1-based room index: [col, row, width] for every cell narrower than 3.
    /// <paramref name="ignoreInnerWalls"/>: judge only the room shape, so cells made narrow
    /// solely by inner walls (e.g. a walled-off toilet stall) aren't reported.
    /// </summary>
    public static Dictionary<int, List<int[]>> Compute(Building building, int floorIndex, bool ignoreInnerWalls = false)
    {
        var floor        = building.Floors[floorIndex];
        var grid         = floor.RoomGrid;
        var stairBlocked = PathfinderService.BuildStairBlockedCells(floor, building, floorIndex);
        var innerWalls   = ignoreInnerWalls
            ? new HashSet<string>()
            : floor.Edges
                .Where(e => e.Type == FloorObjectType.InnerWall)
                .Select(e => e.EdgeKey)
                .ToHashSet();

        int RoomAt(int c, int r) =>
            r >= 0 && r < grid.Length && c >= 0 && c < grid[r].Length && !stairBlocked.Contains((c, r))
                ? grid[r][c] : 0;

        // k×k square with top-left (c0, r0) lies entirely in room `ri` and no inner wall splits it.
        bool ValidSquare(int ri, int c0, int r0, int k)
        {
            for (int r = r0; r < r0 + k; r++)
                for (int c = c0; c < c0 + k; c++)
                {
                    if (RoomAt(c, r) != ri) return false;
                    if (c > c0 && innerWalls.Contains($"V:{c},{r}")) return false;
                    if (r > r0 && innerWalls.Contains($"H:{c},{r}")) return false;
                }
            return true;
        }

        // Largest k such that a valid k×k square contains every cell of the bounding box
        // [minC..maxC] × [minR..maxR] (a single cell, or two neighbouring cells).
        int MaxSquare(int ri, int minC, int minR, int maxC, int maxR)
        {
            int width = 1;
            for (int k = 2; k <= MaxWidth; k++)
            {
                bool fits = false;
                for (int r0 = maxR - k + 1; r0 <= minR && !fits; r0++)
                    for (int c0 = maxC - k + 1; c0 <= minC && !fits; c0++)
                        fits = ValidSquare(ri, c0, r0, k);
                if (!fits) break;
                width = k;
            }
            return width;
        }

        // Pass 1: width of the widest square around each cell (1-wide strips, 2-wide passages).
        var squareWidth = new Dictionary<(int c, int r), int>();
        for (int r = 0; r < grid.Length; r++)
            for (int c = 0; c < grid[r].Length; c++)
                if (RoomAt(c, r) is var ri and > 0)
                    squareWidth[(c, r)] = MaxSquare(ri, c, r, c, r);

        // Pass 2: links narrower than a cell. Two neighbouring cells can each sit in a wide square
        // of their own yet only touch through a single edge (e.g. a 2-wide strip meeting a big
        // area at one cell) — no square wider than that link contains both. Any link narrower
        // than at least one side narrows both cells to the link width: that marks such
        // bottlenecks AND the entry cell of the wider area in front of a narrow corridor/nook
        // (one cell deep — widths come from pass 1, so it doesn't spread further).
        var narrowed = new Dictionary<(int c, int r), int>(squareWidth);
        foreach (var ((c, r), w) in squareWidth)
        {
            int ri = RoomAt(c, r);
            foreach (var (nc, nr, edgeKey) in new[] { (c + 1, r, $"V:{c + 1},{r}"), (c, r + 1, $"H:{c},{r + 1}") })
            {
                if (!squareWidth.TryGetValue((nc, nr), out var nw) || RoomAt(nc, nr) != ri || innerWalls.Contains(edgeKey))
                    continue;
                int link = MaxSquare(ri, c, r, nc, nr);
                if (link < Math.Max(w, nw))
                {
                    narrowed[(c, r)]   = Math.Min(narrowed[(c, r)], link);
                    narrowed[(nc, nr)] = Math.Min(narrowed[(nc, nr)], link);
                }
            }
        }

        var result = new Dictionary<int, List<int[]>>();
        foreach (var ((c, r), w) in narrowed)
        {
            if (w >= MaxWidth) continue;
            int ri = RoomAt(c, r);
            if (!result.TryGetValue(ri, out var list)) result[ri] = list = [];
            list.Add([c, r, w]);
        }
        return result;
    }
}
