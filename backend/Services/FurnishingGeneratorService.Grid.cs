using backend.Models;

namespace backend.Services;

// =========================================================================
// Grid layouts (RoomTypeConfig.Grids)
//
// A grid is a fixed W×H arrangement of furniture placed as ONE unit before the room's normal
// slots. Each candidate is (rotation × mirror × origin); the anchor and all required cells must
// validate, optional cells are dropped when blocked, and the candidate with the most optional
// cells wins. The result is a LayoutPlacementState that seeds both the composite solver and the
// greedy slot-by-slot pass, so everything downstream treats grid pieces like any placed slot.
// =========================================================================

public partial class FurnishingGeneratorService
{
    /// <summary>Upper bound on evaluated (transform, origin) candidates per grid.</summary>
    private const int GridSearchCandidateLimit = 6000;

    /// <summary>Back-edge wall direction per rotation index: 0 = N, 1 = E, 2 = S, 3 = W.</summary>
    private static readonly Direction[] GridRotationBackWall = [Direction.N, Direction.E, Direction.S, Direction.W];

    private static readonly string[] GridRotationNames = ["N", "E", "S", "W"];

    /// <summary>Slot id a grid cell is placed under (anchorMap key, PlacedFurnitureItem.SlotId).</summary>
    private static string GridCellSlotId(GridLayout grid, GridCell cell) => $"{grid.Id}_{cell.Id}";

    /// <summary>
    /// Grid-local rect → rotated/mirrored rect inside the transformed grid's own bounds.
    /// Mirror flips left↔right first, then the grid is turned clockwise <paramref name="rot"/>
    /// quarter turns, which moves its back edge (row 0) from N to E/S/W. Mirrored verbatim in
    /// frontend/src/utils/gridLayoutMath.ts — keep both in sync.
    /// </summary>
    private static (int x, int y, int w, int h) TransformGridRect(
        int x, int y, int w, int h, int gridW, int gridH, int rot, bool mirror)
    {
        if (mirror) x = gridW - x - w;
        return (rot & 3) switch
        {
            1 => (gridH - y - h, x, h, w),
            2 => (gridW - x - w, gridH - y - h, w, h),
            3 => (y, gridW - x - w, h, w),
            _ => (x, y, w, h),
        };
    }

    /// <summary>Grid-local facing → world facing for the same transform as TransformGridRect.</summary>
    private static string TransformGridOrient(string orient, int rot, bool mirror)
    {
        int idx = Array.IndexOf(GridRotationNames, orient.ToUpperInvariant());
        if (idx < 0) return orient;
        if (mirror && (idx == 1 || idx == 3)) idx = 4 - idx; // E ↔ W
        return GridRotationNames[(idx + rot) & 3];
    }

    private static Direction TransformGridDir(Direction local, int rot, bool mirror) =>
        Enum.Parse<Direction>(TransformGridOrient(local.ToString(), rot, mirror));

    private static RoomTypeSlot BuildGridCellSlot(GridLayout grid, GridCell cell) => new()
    {
        Id                    = GridCellSlotId(grid, cell),
        Label                 = string.IsNullOrWhiteSpace(cell.Label) ? cell.Id : cell.Label,
        // CanRotate so FilterTiles keeps variant groups whose authored variant is the rotated
        // shape — the exact rotated footprint is enforced per candidate in TryResolveGridCell.
        Footprint             = new SlotFootprint { Width = cell.Footprint.Width, Height = cell.Footprint.Height, CanRotate = true },
        Required              = cell.IsAnchor || cell.Required,
        AllowedCategories     = cell.AllowedCategories,
        RequiredLayer         = cell.RequiredLayer,
        RequiredProperties    = cell.RequiredProperties,
        PlacementRules        = new PlacementRules { AllowOnPath = grid.AllowOnPath },
        BlocksPlacement       = !cell.AllowStacking,
        SoftBlocks            = cell.AllowStacking,
        // The anchor is also registered under the grid id (CommitLayoutPlacement's SlotGroupId
        // TryAdd), so normal slots can anchor to / require the grid as a whole.
        SlotGroupId           = cell.IsAnchor ? grid.Id : string.Empty,
        ColorGroupId          = cell.ColorGroupId,
        TileGroupId           = cell.TileGroupId,
        RequireTileGroupMatch = cell.RequireTileGroupMatch,
        MaterialGroupId       = cell.MaterialGroupId,
    };

    /// <summary>
    /// Grid ids a layout variant switches on, or null = every grid. Only grid ids listed in the
    /// variant's SlotIds / the room's CommonSlotIds count; a variant listing none keeps all grids.
    /// </summary>
    private static HashSet<string>? BuildLayoutGridFilter(RoomTypeConfig config, LayoutVariant? variant)
    {
        if (variant is null) return null;
        var gridIds = config.Grids.Select(g => g.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var active = (variant.SlotIds ?? []).Concat(config.CommonSlotIds ?? [])
            .Where(gridIds.Contains)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        return active.Count > 0 ? active : null;
    }

    private static List<GridLayout> SelectActiveGrids(
        RoomTypeConfig config, LayoutVariant? variant, string roomSize, Random rng, List<string> log)
    {
        var filter = BuildLayoutGridFilter(config, variant);
        var eligible = config.Grids
            .Where(g => !string.IsNullOrWhiteSpace(g.Id) && g.Cells.Count > 0)
            .Where(g => g.AllowedSizes.Count == 0 || g.AllowedSizes.Any(s => s.Equals(roomSize, StringComparison.OrdinalIgnoreCase)))
            .Where(g => filter is null || filter.Contains(g.Id))
            .ToList();

        // One-of groups: keep exactly one member per non-empty SlotGroupId, weighted.
        var result = new List<GridLayout>();
        foreach (var group in eligible.GroupBy(g => g.SlotGroupId, StringComparer.OrdinalIgnoreCase))
        {
            if (string.IsNullOrEmpty(group.Key)) { result.AddRange(group); continue; }
            var members = group.ToList();
            int total = members.Sum(g => Math.Max(1, g.GroupWeight));
            int roll = rng.Next(total), acc = 0;
            var chosen = members[0];
            foreach (var g in members)
            {
                acc += Math.Max(1, g.GroupWeight);
                if (roll < acc) { chosen = g; break; }
            }
            log.Add($"  [GRID] group '{group.Key}': chose '{chosen.Id}' of {members.Count}");
            result.Add(chosen);
        }

        return result
            .Select((g, i) => (g, i))
            .OrderByDescending(e => e.g.Required)
            .ThenBy(e => e.g.Priority)
            .ThenBy(e => e.i)
            .Select(e => e.g)
            .ToList();
    }

    /// <summary>
    /// Places every active grid of the room type. Returns null when the room type has no active
    /// grid; otherwise a state holding all grid placements, occupancy, anchors and colour/variant
    /// locks (empty if nothing fit).
    /// </summary>
    private static LayoutPlacementState? PlaceGrids(
        RoomTypeConfig config,
        LayoutVariant? variant,
        string roomSize,
        int floorIndex,
        HashSet<(int, int)> roomCells,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        HashSet<(int, int)> doorCells,
        HashSet<(int, int)> windowCells,
        HashSet<(int, int)> pathCells,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        Dictionary<string, string> seededColorMap,
        HashSet<(int, int)> reservedZoneCells,
        Random rng,
        string roomTypeName,
        int roomIndex1Based,
        int? selectionAnchorCol,
        int? selectionAnchorRow,
        HashSet<string>? innerWallKeys,
        List<HashSet<(int, int)>>? openingGroups,
        HashSet<(int, int)> gapCells,
        HashSet<(int, int)>? stairEndCells,
        List<string> log)
    {
        if (config.Grids is not { Count: > 0 }) return null;
        var grids = SelectActiveGrids(config, variant, roomSize, rng, log);
        if (grids.Count == 0) return null;

        var state = new LayoutPlacementState(
            new HashSet<(int, int)>(),
            new HashSet<(int, int)>(),
            new HashSet<(int, int)>(),
            new HashSet<(int, int)>(),
            new HashSet<(int, int)>(),
            new Dictionary<(int, int), HashSet<string>>(),
            reservedZoneCells,
            new Dictionary<string, (int col, int row, int fpW, int fpH, string orient)>(StringComparer.OrdinalIgnoreCase),
            new Dictionary<string, string>(seededColorMap, StringComparer.OrdinalIgnoreCase),
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase),
            new List<PlacedFurnitureItem>(),
            new List<(string SlotId, string TileId, string Orient, int Col, int Row)>());

        foreach (var grid in grids)
        {
            var placed = TryPlaceGrid(grid, state, floorIndex, roomCells, cellWalls, doorCells, windowCells, pathCells,
                allTiles, config, rng, roomTypeName, roomIndex1Based, selectionAnchorCol, selectionAnchorRow,
                innerWallKeys, openingGroups, gapCells, stairEndCells, log);
            if (placed is not null) state = placed;
        }

        return state;
    }

    private sealed record GridCellPlan(GridCell Cell, RoomTypeSlot Slot, List<TileDefinition> BasePool, bool Mandatory)
    {
        /// <summary>(base tile id, orient) → ResolveFinalTileForOrient result; that call scans every
        /// tile definition, and the same pairs recur for every candidate position.</summary>
        public Dictionary<(string, string), TileDefinition> OrientCache { get; } = new();

        /// <summary>Hard-occupancy pre-check is only safe when the piece can't be a floor-layer
        /// tile (rugs may legitimately overlap occupied cells).</summary>
        public bool CanPrecheckOccupancy { get; } = Slot.RequiredLayer.Length > 0
            && !Slot.RequiredLayer.Equals("FloorFurniture", StringComparison.OrdinalIgnoreCase)
            && !Slot.RequiredLayer.Equals("FloorOverlay", StringComparison.OrdinalIgnoreCase);
    }

    private static LayoutPlacementState? TryPlaceGrid(
        GridLayout grid,
        LayoutPlacementState baseState,
        int floorIndex,
        HashSet<(int, int)> roomCells,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        HashSet<(int, int)> doorCells,
        HashSet<(int, int)> windowCells,
        HashSet<(int, int)> pathCells,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        RoomTypeConfig config,
        Random rng,
        string roomTypeName,
        int roomIndex1Based,
        int? selectionAnchorCol,
        int? selectionAnchorRow,
        HashSet<string>? innerWallKeys,
        List<HashSet<(int, int)>>? openingGroups,
        HashSet<(int, int)> gapCells,
        HashSet<(int, int)>? stairEndCells,
        List<string> log)
    {
        string Fail(string reason)
        {
            var line = grid.Required ? $"  [WARN] grid '{grid.Id}': {reason}" : $"  [GRID] '{grid.Id}' skipped: {reason}";
            log.Add(line);
            return line;
        }

        int anchorCount = grid.Cells.Count(c => c.IsAnchor);
        if (anchorCount != 1) { Fail($"needs exactly one anchor cell, has {anchorCount}"); return null; }
        if (grid.Width < 1 || grid.Height < 1) { Fail("invalid size"); return null; }

        // Anchor first, then required, then optional — so a mandatory piece is never crowded out
        // by an optional one. Tile pools are footprint/category-filtered once per cell here; only
        // the cheap colour/variant/material narrowing runs per candidate.
        var plans = grid.Cells
            .Select(c => { var slot = BuildGridCellSlot(grid, c); return new GridCellPlan(c, slot, FilterTiles(allTiles, slot, roomTypeName), c.IsAnchor || c.Required); })
            .OrderByDescending(p => p.Cell.IsAnchor)
            .ThenByDescending(p => p.Mandatory)
            .ToList();

        var noTiles = plans.FirstOrDefault(p => p.Mandatory && p.BasePool.Count == 0);
        if (noTiles is not null) { Fail($"no matching tiles for mandatory cell '{noTiles.Cell.Id}'"); return null; }

        int optionalTotal = plans.Count(p => !p.Mandatory);
        var bounds = ComputeRoomBounds(roomCells);
        double centreCol = roomCells.Average(c => c.Item1), centreRow = roomCells.Average(c => c.Item2);
        bool isFree = grid.Mode.Equals("free", StringComparison.OrdinalIgnoreCase);
        bool isCorner = grid.Mode.Equals("corner", StringComparison.OrdinalIgnoreCase);

        var candidates = new List<(int rot, bool mirror, int ox, int oy, double dist)>();
        foreach (var mirror in grid.AllowMirror ? new[] { false, true } : new[] { false })
        for (int rot = 0; rot < 4; rot++)
        {
            var (tw, th) = rot % 2 == 0 ? (grid.Width, grid.Height) : (grid.Height, grid.Width);
            for (int oy = bounds.MinRow - th + 1; oy <= bounds.MaxRow; oy++)
            for (int ox = bounds.MinCol - tw + 1; ox <= bounds.MaxCol; ox++)
            {
                double dx = ox + tw / 2.0 - 0.5 - centreCol, dy = oy + th / 2.0 - 0.5 - centreRow;
                candidates.Add((rot, mirror, ox, oy, dx * dx + dy * dy));
            }
        }
        candidates = ShuffleCopy(candidates, rng);
        if (isFree) candidates = candidates.OrderBy(c => c.dist).ToList(); // stable: shuffle breaks ties

        var anchorPlan = plans[0];
        LayoutPlacementState? best = null;
        int bestScore = -1, evaluated = 0;
        (int rot, bool mirror, int ox, int oy) bestTransform = default;

        foreach (var (rot, mirror, ox, oy, _) in candidates)
        {
            // Cheap geometric pre-filter: the anchor's rotated footprint must lie on free room cells.
            var a = anchorPlan.Cell;
            var (ax, ay, aw, ah) = TransformGridRect(a.X, a.Y, a.Footprint.Width, a.Footprint.Height, grid.Width, grid.Height, rot, mirror);
            if (!FitsFootprintLoose(ox + ax, oy + ay, aw, ah, baseState.Occupied)
                || !RectInRoom(ox + ax, oy + ay, aw, ah, roomCells))
                continue;
            if (!isFree && !SatisfiesGridWallMode(grid, plans, rot, mirror, ox, oy, isCorner, roomCells, cellWalls))
                continue;

            if (++evaluated > GridSearchCandidateLimit) break;

            var result = EvaluateGridCandidate(grid, plans, rot, mirror, ox, oy, baseState, floorIndex, roomCells, cellWalls,
                doorCells, windowCells, pathCells, allTiles, config, rng, roomIndex1Based, selectionAnchorCol,
                selectionAnchorRow, innerWallKeys, openingGroups, gapCells, stairEndCells);
            if (result is null) continue;

            var (state, score) = result.Value;
            if (score > bestScore)
            {
                best = state; bestScore = score; bestTransform = (rot, mirror, ox, oy);
                if (score == optionalTotal) break;
            }
        }

        if (best is null) { Fail($"no valid position found ({evaluated} candidates checked)"); return null; }

        if (!string.IsNullOrEmpty(grid.SlotGroupId) && best.AnchorMap.TryGetValue(grid.Id, out var anchorEntry))
            best.AnchorMap.TryAdd(grid.SlotGroupId, anchorEntry);

        var (bRot, bMirror, bOx, bOy) = bestTransform;
        log.Add($"  [GRID] '{grid.Id}' placed {grid.Width}x{grid.Height} mode={grid.Mode} back={GridRotationNames[bRot]}{(bMirror ? " mirrored" : "")} " +
                $"origin=({bOx},{bOy}), optional {bestScore}/{optionalTotal} ({evaluated} candidates checked)");
        foreach (var p in best.SlotPlacements.Skip(baseState.SlotPlacements.Count))
            log.Add($"  [PLACED] '{p.SlotId}': '{p.TileId}' orient '{p.Orient}' at ({p.Col},{p.Row})");
        return best;
    }

    private static bool RectInRoom(int col, int row, int w, int h, HashSet<(int, int)> roomCells)
    {
        for (int r = 0; r < h; r++)
            for (int c = 0; c < w; c++)
                if (!roomCells.Contains((col + c, row + r))) return false;
        return true;
    }

    /// <summary>
    /// wall/corner mode: the grid's back edge (and, in corner mode, its left edge — right edge
    /// when mirrored) must sit against a wall. Only edge cells covered by a mandatory piece are
    /// checked, so an optional piece or empty cell hanging past a short wall doesn't veto the
    /// spot; if no mandatory piece touches that edge at all, the whole edge must be wall.
    /// </summary>
    private static bool SatisfiesGridWallMode(
        GridLayout grid, List<GridCellPlan> plans, int rot, bool mirror, int ox, int oy, bool isCorner,
        HashSet<(int, int)> roomCells, Dictionary<(int, int), HashSet<Direction>> cellWalls)
    {
        bool CoveredByMandatory(int lx, int ly) => plans.Any(p => p.Mandatory
            && lx >= p.Cell.X && lx < p.Cell.X + p.Cell.Footprint.Width
            && ly >= p.Cell.Y && ly < p.Cell.Y + p.Cell.Footprint.Height);

        bool EdgeOk(IEnumerable<(int lx, int ly)> edge, Direction localDir)
        {
            var wallDir = TransformGridDir(localDir, rot, mirror);
            var cells = edge.ToList();
            var covered = cells.Where(p => CoveredByMandatory(p.lx, p.ly)).ToList();
            var toCheck = covered.Count > 0 ? covered : cells;
            foreach (var (lx, ly) in toCheck)
            {
                var (x, y, _, _) = TransformGridRect(lx, ly, 1, 1, grid.Width, grid.Height, rot, mirror);
                var world = (ox + x, oy + y);
                if (!roomCells.Contains(world)) return false;
                if (!cellWalls.TryGetValue(world, out var dirs) || !dirs.Contains(wallDir)) return false;
            }
            return true;
        }

        if (!EdgeOk(Enumerable.Range(0, grid.Width).Select(x => (x, 0)), Direction.N))
            return false;
        if (isCorner && !EdgeOk(Enumerable.Range(0, grid.Height).Select(y => (0, y)), Direction.W))
            return false;
        return true;
    }

    private static (LayoutPlacementState state, int optionalPlaced)? EvaluateGridCandidate(
        GridLayout grid,
        List<GridCellPlan> plans,
        int rot,
        bool mirror,
        int ox,
        int oy,
        LayoutPlacementState baseState,
        int floorIndex,
        HashSet<(int, int)> roomCells,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        HashSet<(int, int)> doorCells,
        HashSet<(int, int)> windowCells,
        HashSet<(int, int)> pathCells,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        RoomTypeConfig config,
        Random rng,
        int roomIndex1Based,
        int? selectionAnchorCol,
        int? selectionAnchorRow,
        HashSet<string>? innerWallKeys,
        List<HashSet<(int, int)>>? openingGroups,
        HashSet<(int, int)> gapCells,
        HashSet<(int, int)>? stairEndCells)
    {
        var state = baseState.Clone();
        int optionalPlaced = 0;

        foreach (var plan in plans)
        {
            var c = plan.Cell;
            var (lx, ly, w, h) = TransformGridRect(c.X, c.Y, c.Footprint.Width, c.Footprint.Height, grid.Width, grid.Height, rot, mirror);
            var orient = TransformGridOrient(c.Orient, rot, mirror);
            var candidate = TryResolveGridCell(plan, ox + lx, oy + ly, w, h, orient, state, baseState, roomCells, cellWalls,
                doorCells, windowCells, pathCells, allTiles, config, rng, innerWallKeys, openingGroups, gapCells, stairEndCells);
            if (candidate is null)
            {
                if (plan.Mandatory) return null;
                continue;
            }

            CommitLayoutPlacement(floorIndex, plan.Slot, candidate, roomIndex1Based, selectionAnchorCol, selectionAnchorRow, state);
            if (!plan.Mandatory) optionalPlaced++;
        }

        // Keep-clear cells must be free walkable room cells; afterwards they block every later
        // piece except collision-free floor decor (rugs), exactly like a BlocksFrontCell cell.
        foreach (var kc in grid.KeepClear)
        {
            if (kc.X < 0 || kc.Y < 0 || kc.X >= grid.Width || kc.Y >= grid.Height) continue;
            var (x, y, _, _) = TransformGridRect(kc.X, kc.Y, 1, 1, grid.Width, grid.Height, rot, mirror);
            var cell = (ox + x, oy + y);
            if (!roomCells.Contains(cell) || state.Occupied.Contains(cell) || state.PhysicalOccupied.Contains(cell))
                return null;
            state.BlockedFrontCells.Add(cell);
        }

        // The whole grid must not split the room or wall off a door.
        var blocked = new HashSet<(int, int)>(state.Occupied);
        blocked.UnionWith(state.PhysicalOccupied);
        if (!RoomRemainsConnected(0, 0, 0, 0, roomCells, blocked, doorCells, innerWallKeys))
            return null;

        return (state, optionalPlaced);
    }

    private static LayoutPlacementCandidate? TryResolveGridCell(
        GridCellPlan plan,
        int col,
        int row,
        int fpW,
        int fpH,
        string orient,
        LayoutPlacementState state,
        LayoutPlacementState baseState,
        HashSet<(int, int)> roomCells,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        HashSet<(int, int)> doorCells,
        HashSet<(int, int)> windowCells,
        HashSet<(int, int)> pathCells,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        RoomTypeConfig config,
        Random rng,
        HashSet<string>? innerWallKeys,
        List<HashSet<(int, int)>>? openingGroups,
        HashSet<(int, int)> gapCells,
        HashSet<(int, int)>? stairEndCells)
    {
        if (plan.BasePool.Count == 0 || !RectInRoom(col, row, fpW, fpH, roomCells))
            return null;
        if (plan.CanPrecheckOccupancy && !FitsFootprintLoose(col, row, fpW, fpH, state.Occupied))
            return null;

        var (pool, colorGroup) = ApplyLayoutGroupFilters(plan.BasePool, plan.Slot, state, config);
        if (pool.Count == 0) return null;

        // Two passes: tiles with a variant that really faces `orient` first, then whatever
        // ResolveFinalTileForOrient falls back to (symmetric pieces like tables often have a
        // single authored orientation).
        var ordered = OrderTileCandidatesForLayout(pool, plan.Slot, rng);
        foreach (var exactOnly in new[] { true, false })
        foreach (var baseTile in ordered)
        {
            if (!plan.OrientCache.TryGetValue((baseTile.Id, orient), out var tile))
                plan.OrientCache[(baseTile.Id, orient)] = tile = ResolveFinalTileForOrient(baseTile, orient, allTiles);
            bool exact = OrientMatches(tile, orient) || AllowedOrientsMatch(tile, orient);
            if (exact != exactOnly) continue;

            int tW = tile.TileLayout.Count > 0 ? (tile.TileLayout[0]?.Count ?? 1) : 1;
            int tH = tile.TileLayout.Count;
            if (tW != fpW || tH != fpH) continue;

            // Soft blocks created by this grid's own pieces (e.g. the loot-container front cell of
            // a desk) must not veto another piece of the same grid (the chair in front of it) —
            // the grid author placed them deliberately. Hard occupancy still applies.
            if (IsValidAnchoredPlacement(plan.Slot, col, row, fpW, fpH, orient, tile, roomCells, cellWalls, doorCells,
                    windowCells, pathCells, state.Occupied, state.PhysicalOccupied, state.BlockedFrontCells, innerWallKeys,
                    openingGroups, state.CellPropertyGates, state.ReservedZoneCells, state.FrontExemptCells, gapCells,
                    effectiveSoftOccupied: baseState.SoftOccupied, stairEndCells: stairEndCells))
                return new LayoutPlacementCandidate(col, row, orient, tile, colorGroup);
        }

        return null;
    }

    /// <summary>
    /// Copy of a grid state suitable as the composite solver's initial state: occupancy, anchors
    /// and colour/variant locks carry over, but Placements/SlotPlacements start empty because the
    /// grid's placements were already emitted.
    /// </summary>
    private static LayoutPlacementState SeedStateFromGrids(LayoutPlacementState gridState)
    {
        var seed = gridState.Clone();
        seed.Placements.Clear();
        seed.SlotPlacements.Clear();
        return seed;
    }

    /// <summary>Anchor-map member ids of a grid (all of its cells), for matchAnchorCluster rugs that require the grid.</summary>
    private static IEnumerable<string> GridClusterMemberIds(RoomTypeConfig config, string gridId) =>
        config.Grids.FirstOrDefault(g => g.Id.Equals(gridId, StringComparison.OrdinalIgnoreCase)) is { } grid
            ? grid.Cells.Select(c => GridCellSlotId(grid, c))
            : [];
}
