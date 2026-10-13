namespace backend.Services;

using backend.Models;

public interface IPathfinderService
{
    void ComputePaths(Building building, int floorIndex, int? seed = null);
    int[][] ComputeRoomPath(Building building, int floorIndex, int roomIndex1Based, int? seed = null, string pathStyle = "wall");
}

public class PathfinderService : IPathfinderService
{
    // Kosten-Konstanten für pathStyle "wall" (Standard)
    private const float CostOpen_Wall    = 1.0f;
    private const float CostWallAdj_Wall = 0.4f;
    private const float CostCorner_Wall  = 0.3f;
    private const float Jitter_Wall      = 0.15f;

    // Kosten-Konstanten für pathStyle "center" (Mitte bevorzugt)
    private const float CostOpen_Center    = 0.4f;
    private const float CostWallAdj_Center = 1.2f;
    private const float CostCorner_Center  = 1.5f;
    private const float Jitter_Center      = 0.15f;

    // Kosten-Konstanten für pathStyle "random" (stark zufällig)
    private const float CostOpen_Random    = 1.0f;
    private const float CostWallAdj_Random = 1.0f;
    private const float CostCorner_Random  = 1.0f;
    private const float Jitter_Random      = 0.80f;

    private const int StairSpan = 5;

    public void ComputePaths(Building building, int floorIndex, int? seed = null)
    {
        var floor        = building.Floors[floorIndex];
        var doorWps      = BuildDoorWaypoints(floor);
        var stairBlocked = BuildStairBlockedCells(floor, building, floorIndex);

        var roomsOnFloor = new HashSet<int>();
        foreach (var row in floor.RoomGrid)
            foreach (var ri in row)
                if (ri > 0) roomsOnFloor.Add(ri);

        floor.PathsByRoom = [];
        foreach (int ri in roomsOnFloor)
            floor.PathsByRoom[ri] = ComputeForRoom(floor, ri, doorWps, stairBlocked, seed);
    }

    public int[][] ComputeRoomPath(Building building, int floorIndex, int roomIndex1Based, int? seed = null, string pathStyle = "wall")
    {
        var floor        = building.Floors[floorIndex];
        var doorWps      = BuildDoorWaypoints(floor);
        var stairBlocked = BuildStairBlockedCells(floor, building, floorIndex);
        var cells        = ComputeForRoom(floor, roomIndex1Based, doorWps, stairBlocked, seed, pathStyle);
        floor.PathsByRoom ??= [];
        floor.PathsByRoom[roomIndex1Based] = cells;
        return [.. cells];
    }

    /// <summary>
    /// All stair cells (full span) on this floor – from own stairs and stairs from floor below.
    /// These are blocked for path routing; only the entry/exit waypoint is re-added as passable.
    /// </summary>
    internal static HashSet<(int col, int row)> BuildStairBlockedCells(
        Floor floor, Building building, int floorIndex)
    {
        var blocked = new HashSet<(int, int)>();

        void AddSpan(FloorObject obj)
        {
            for (int i = 0; i < StairSpan; i++)
            {
                int cx = obj.Dir == Direction.W ? obj.X + i : obj.X;
                int cy = obj.Dir == Direction.N ? obj.Y + i : obj.Y;
                blocked.Add((cx, cy));
            }
        }

        foreach (var obj in floor.Objects)
            if (obj.Type == FloorObjectType.Stairs) AddSpan(obj);

        if (floorIndex > 0)
            foreach (var obj in building.Floors[floorIndex - 1].Objects)
                if (obj.Type == FloorObjectType.Stairs) AddSpan(obj);

        return blocked;
    }

    // ── Waypoint builders ────────────────────────────────────────────────────

    private static Dictionary<int, List<(int col, int row)>> BuildDoorWaypoints(Floor floor)
    {
        var result = new Dictionary<int, List<(int, int)>>();

        void TryAdd(int col, int row)
        {
            if (row < 0 || row >= floor.RoomGrid.Length) return;
            if (col < 0 || col >= floor.RoomGrid[row].Length) return;
            int ri = floor.RoomGrid[row][col];
            if (ri == 0) return;
            if (!result.ContainsKey(ri)) result[ri] = [];
            result[ri].Add((col, row));
        }

        foreach (var edge in floor.Edges)
        {
            if (edge.Type != FloorObjectType.Door) continue;
            TryAdd(edge.Cell1Col, edge.Cell1Row);
            TryAdd(edge.Cell2Col, edge.Cell2Row);
        }
        return result;
    }

    // ── Core path computation ─────────────────────────────────────────────────

    private List<int[]> ComputeForRoom(
        Floor floor, int roomIndex1Based,
        Dictionary<int, List<(int col, int row)>> doorWps,
        HashSet<(int, int)> stairBlocked,
        int? seed,
        string pathStyle = "wall")
    {
        var grid = floor.RoomGrid;
        int rows = grid.Length;

        // Exclude all stair span cells – only the waypoint cell is re-added below
        var roomCells = new HashSet<(int col, int row)>();
        for (int r = 0; r < rows; r++)
            for (int c = 0; c < grid[r].Length; c++)
                if (grid[r][c] == roomIndex1Based && !stairBlocked.Contains((c, r)))
                    roomCells.Add((c, r));

        if (roomCells.Count == 0) return [];

        // Sealed inner-wall edges within this room — movement must route around them just like
        // FurnishingGeneratorService's ComputeReachableCells does, instead of A* cutting straight
        // through a wall segment that happens to separate two sub-areas of the same room index.
        var innerWallKeys = floor.Edges
            .Where(e => e.Type == FloorObjectType.InnerWall
                && (roomCells.Contains((e.Cell1Col, e.Cell1Row)) || roomCells.Contains((e.Cell2Col, e.Cell2Row))))
            .Select(e => e.EdgeKey)
            .ToHashSet();

        var costMap = BuildCostMap(roomCells, pathStyle);

        // Jitter-Stärke je nach PathStyle
        float jitterMax = pathStyle switch
        {
            "center" => Jitter_Center,
            "random" => Jitter_Random,
            _        => Jitter_Wall,
        };

        // Collect waypoints: doors
        var waypointSet = new HashSet<(int, int)>();
        if (doorWps.TryGetValue(roomIndex1Based, out var dWps))
            foreach (var w in dWps) waypointSet.Add(w);

        // Collect waypoints: stair entries from pre-computed floor data
        foreach (var sw in floor.StairWaypoints)
        {
            if (sw.Row < 0 || sw.Row >= grid.Length) continue;
            if (sw.Col < 0 || sw.Col >= grid[sw.Row].Length) continue;
            if (grid[sw.Row][sw.Col] != roomIndex1Based) continue;
            var wp = (sw.Col, sw.Row);
            waypointSet.Add(wp);
            roomCells.Add(wp); // only this X-cell of the staircase is passable
        }

        // pathStyle "doorOnly": Nur Tür-/Waypoint-Zellen reservieren,
        // kein A*-Pfad zwischen den Punkten.
        if (pathStyle.Equals("doorOnly", StringComparison.OrdinalIgnoreCase))
        {
            return waypointSet
                .Where(roomCells.Contains)
                .Select(c => new int[] { c.Item1, c.Item2 })
                .ToList();
        }

        // Archways (Opening edges) are entrances too — a room reached only through one would
        // otherwise get no waypoint there. One waypoint per contiguous archway (its middle cell).
        var openingCells = new HashSet<(int, int)>();
        foreach (var edge in floor.Edges)
        {
            if (edge.Type != FloorObjectType.Opening) continue;
            foreach (var cell in new[] { (edge.Cell1Col, edge.Cell1Row), (edge.Cell2Col, edge.Cell2Row) })
                if (roomCells.Contains(cell)) openingCells.Add(cell);
        }
        foreach (var run in ConnectedComponents(openingCells))
        {
            var sorted = run.OrderBy(c => c.Item1).ThenBy(c => c.Item2).ToList();
            waypointSet.Add(sorted[sorted.Count / 2]);
        }

        // Jitter for path variation
        var rng    = new Random(seed ?? Environment.TickCount);
        var jitter = new Dictionary<(int, int), float>();
        foreach (var cell in roomCells)
            jitter[cell] = (float)(rng.NextDouble() * jitterMax);

        // One room index can be painted as several disconnected areas (e.g. the same "Living
        // Room" in every apartment of a block). Route each area on its own — chaining waypoints
        // across areas made A* fail between them, leaving some areas with no path at all.
        var pathSet = new HashSet<(int, int)>();
        foreach (var area in ConnectedComponents(roomCells))
        {
            var waypoints = waypointSet.Where(area.Contains).ToList();

            // Fewer than 2 waypoints → extend with farthest cell of this area
            if (waypoints.Count < 2)
            {
                var anchor = waypoints.Count > 0 ? waypoints[0] : area.First();
                int ac = anchor.Item1, ar = anchor.Item2;
                var farthest = area
                    .Where(c => c != anchor)
                    .OrderByDescending(c => Math.Abs(c.Item1 - ac) + Math.Abs(c.Item2 - ar))
                    .Cast<(int, int)?>()
                    .FirstOrDefault();
                if (farthest is null) { pathSet.Add(anchor); continue; }
                if (waypoints.Count == 0) waypoints.Add(anchor);
                waypoints.Add(farthest.Value);
            }

            // Chain: [0→1], [1→2], …
            for (int i = 0; i < waypoints.Count - 1; i++)
            {
                var segment = AStar(waypoints[i], waypoints[i + 1], area, costMap, jitter, innerWallKeys);
                foreach (var cell in segment) pathSet.Add(cell);
            }
        }

        return pathSet.Select(c => new int[] { c.Item1, c.Item2 }).ToList();
    }

    /// <summary>4-neighbour connected components of <paramref name="cells"/>, in discovery order.</summary>
    private static List<HashSet<(int, int)>> ConnectedComponents(HashSet<(int col, int row)> cells)
    {
        var result    = new List<HashSet<(int, int)>>();
        var remaining = new HashSet<(int, int)>(cells);
        foreach (var start in cells)
        {
            if (!remaining.Remove(start)) continue;
            var component = new HashSet<(int, int)> { start };
            var queue     = new Queue<(int, int)>([start]);
            while (queue.Count > 0)
            {
                var (c, r) = queue.Dequeue();
                foreach (var nb in new[] { (c + 1, r), (c - 1, r), (c, r + 1), (c, r - 1) })
                    if (remaining.Remove(nb)) { component.Add(nb); queue.Enqueue(nb); }
            }
            result.Add(component);
        }
        return result;
    }

    private static Dictionary<(int, int), float> BuildCostMap(HashSet<(int col, int row)> roomCells, string pathStyle = "wall")
    {
        // Kosten je nach PathStyle wählen
        float costOpen    = pathStyle switch { "center" => CostOpen_Center,    "random" => CostOpen_Random,    _ => CostOpen_Wall    };
        float costWallAdj = pathStyle switch { "center" => CostWallAdj_Center, "random" => CostWallAdj_Random, _ => CostWallAdj_Wall };
        float costCorner  = pathStyle switch { "center" => CostCorner_Center,  "random" => CostCorner_Random,  _ => CostCorner_Wall  };

        var map = new Dictionary<(int, int), float>();
        int[] dx = [-1, 1, 0, 0];
        int[] dy = [0, 0, -1, 1];

        foreach (var (c, r) in roomCells)
        {
            int open = 0;
            for (int d = 0; d < 4; d++)
                if (roomCells.Contains((c + dx[d], r + dy[d]))) open++;

            map[(c, r)] = open switch { 0 or 1 => costCorner, 2 => costWallAdj, _ => costOpen };
        }
        return map;
    }

    private static List<(int, int)> AStar(
        (int col, int row) start, (int col, int row) goal,
        HashSet<(int, int)> passable,
        Dictionary<(int, int), float> costMap,
        Dictionary<(int, int), float> jitter,
        HashSet<string>? innerWallKeys = null)
    {
        var open     = new PriorityQueue<(int, int), float>();
        var gScore   = new Dictionary<(int, int), float> { [start] = 0 };
        var cameFrom = new Dictionary<(int, int), (int, int)>();

        float H((int c, int r) a, (int c, int r) b) =>
            MathF.Abs(a.c - b.c) + MathF.Abs(a.r - b.r);

        open.Enqueue(start, H(start, goal));
        int[] dx = [-1, 1, 0, 0];
        int[] dy = [0, 0, -1, 1];

        while (open.Count > 0)
        {
            var cur = open.Dequeue();
            if (cur == goal)
            {
                var path = new List<(int, int)>();
                var node = goal;
                while (node != start) { path.Add(node); node = cameFrom[node]; }
                path.Add(start);
                path.Reverse();
                return path;
            }

            for (int d = 0; d < 4; d++)
            {
                var nb = (cur.Item1 + dx[d], cur.Item2 + dy[d]);
                if (!passable.Contains(nb)) continue;

                // Skip the step if a sealed inner wall covers the shared edge between cur and nb
                // (same edge-key convention as FurnishingGeneratorService.ComputeReachableCells).
                if (innerWallKeys is { Count: > 0 })
                {
                    string edgeKey = nb.Item1 == cur.Item1
                        ? $"H:{cur.Item1},{Math.Max(cur.Item2, nb.Item2)}"
                        : $"V:{Math.Max(cur.Item1, nb.Item1)},{cur.Item2}";
                    if (innerWallKeys.Contains(edgeKey)) continue;
                }

                float tentG = gScore[cur]
                    + costMap.GetValueOrDefault(nb, CostOpen_Wall)
                    + jitter.GetValueOrDefault(nb, 0);

                if (!gScore.TryGetValue(nb, out float ex) || tentG < ex)
                {
                    gScore[nb]   = tentG;
                    cameFrom[nb] = cur;
                    open.Enqueue(nb, tentG + H(nb, goal));
                }
            }
        }
        return [];
    }
}



