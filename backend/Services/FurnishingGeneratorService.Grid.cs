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

    /// <summary>
    /// Grid-local corner ("NW"…) → world corner for the same transform: both wall sides are
    /// transformed separately and recombined N/S-first (tile-definitions spelling). Null for an
    /// empty or malformed value.
    /// </summary>
    private static string? TransformGridCorner(string corner, int rot, bool mirror)
    {
        if (string.IsNullOrWhiteSpace(corner) || corner.Length != 2) return null;
        var dirs = new HashSet<Direction>();
        foreach (var ch in corner.ToUpperInvariant())
        {
            if (!Enum.TryParse<Direction>(ch.ToString(), out var d)) return null;
            dirs.Add(TransformGridDir(d, rot, mirror));
        }
        return ComputeCornerOrient(dirs);
    }

    /// <summary>
    /// The corner variant (Orientation or AllowedOrients = <paramref name="corner"/>) of a pool
    /// tile: the tile itself, else a sibling (IsOrientSibling). Null if it has none —
    /// a straight counter group without a corner piece can't fill a corner cell.
    /// </summary>
    private static TileDefinition? ResolveCornerVariant(
        TileDefinition baseTile, string corner, IReadOnlyDictionary<string, TileDefinition> allTiles)
    {
        bool IsCorner(TileDefinition t) => t.Orientation.Equals(corner, StringComparison.OrdinalIgnoreCase)
            || t.AllowedOrients.Any(o => o.Equals(corner, StringComparison.OrdinalIgnoreCase));
        if (IsCorner(baseTile)) return baseTile;
        if (string.IsNullOrEmpty(baseTile.VariantGroup)) return null;
        return allTiles.Values.FirstOrDefault(t =>
            IsOrientSibling(t, baseTile) &&
            IsCorner(t));
    }

    /// <summary>Some footprint cell is a true room corner with walls on both sides of <paramref name="corner"/>.</summary>
    private static bool FootprintHasCornerCell(int col, int row, int fpW, int fpH, string corner,
        Dictionary<(int, int), HashSet<Direction>> cellWalls)
    {
        var a = Enum.Parse<Direction>(corner[..1]);
        var b = Enum.Parse<Direction>(corner[1..]);
        for (int r = 0; r < fpH; r++)
            for (int c = 0; c < fpW; c++)
                if (cellWalls.TryGetValue((col + c, row + r), out var dirs) && dirs.Contains(a) && dirs.Contains(b))
                    return true;
        return false;
    }

    /// <summary>Wall-mounted piece (hanging counter, hood, shelf): never hard-blocks the floor cell below.</summary>
    private static bool IsWallLayerCell(GridCell cell) =>
        cell.RequiredLayer.StartsWith("Wall", StringComparison.OrdinalIgnoreCase);

    internal static RoomTypeSlot BuildGridCellSlot(GridLayout grid, GridCell cell) => new()
    {
        Id                    = GridCellSlotId(grid, cell),
        Label                 = string.IsNullOrWhiteSpace(cell.Label) ? cell.Id : cell.Label,
        // CanRotate so FilterTiles keeps variant groups whose authored variant is the rotated
        // shape — the exact rotated footprint is enforced per candidate in TryResolveGridCell.
        Footprint             = new SlotFootprint { Width = cell.Footprint.Width, Height = cell.Footprint.Height, CanRotate = true },
        Required              = cell.IsAnchor || cell.Required,
        AllowedCategories     = cell.AllowedCategories,
        AllowedThemes         = cell.AllowedThemes,
        RequiredLayer         = cell.RequiredLayer,
        RequiredProperties    = cell.RequiredProperties,
        PlacementRules        = new PlacementRules { AllowOnPath = grid.AllowOnPath },
        // Wall-layer pieces only soft-block like stacking hosts (same as the hanging-counter slots'
        // blocksPlacement:false), so a sink anchored to the counter below can still stand there.
        BlocksPlacement       = !cell.EdgePiece && !cell.AllowStacking && !IsWallLayerCell(cell),
        SoftBlocks            = !cell.EdgePiece && (cell.AllowStacking || IsWallLayerCell(cell)),
        BlocksFrontCell       = cell.BlocksFrontCell && !cell.EdgePiece && string.IsNullOrWhiteSpace(cell.CornerOrient),
        // The anchor is also registered under the grid id (CommitLayoutPlacement's SlotGroupId
        // TryAdd), so normal slots can anchor to / require the grid as a whole.
        SlotGroupId           = cell.IsAnchor ? grid.Id : string.Empty,
        ColorGroupId          = cell.ColorGroupId,
        UseColorHarmony       = grid.UseColorHarmony,
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

    /// <summary>
    /// Active grids as placement entries: an ungrouped grid is a one-element entry; a one-of group
    /// (shared SlotGroupId) is one entry holding all its members in weighted-random order — the
    /// first is the rolled winner, the rest are fallbacks tried in order if it finds no spot.
    /// </summary>
    private static List<List<GridLayout>> SelectActiveGrids(
        RoomTypeConfig config, LayoutVariant? variant, string roomSize, Random rng, List<string> log)
    {
        var filter = BuildLayoutGridFilter(config, variant);
        var eligible = config.Grids
            .Where(g => !string.IsNullOrWhiteSpace(g.Id) && g.Cells.Count > 0)
            .Where(g => g.AllowedSizes.Count == 0 || g.AllowedSizes.Any(s => s.Equals(roomSize, StringComparison.OrdinalIgnoreCase)))
            .Where(g => filter is null || filter.Contains(g.Id))
            .ToList();

        // GroupWeightBySize for this room size, else GroupWeight.
        int WeightFor(GridLayout g)
        {
            foreach (var (size, w) in g.GroupWeightBySize ?? [])
                if (size.Equals(roomSize, StringComparison.OrdinalIgnoreCase)) return Math.Max(1, w);
            return Math.Max(1, g.GroupWeight);
        }

        var result = new List<List<GridLayout>>();
        foreach (var group in eligible.GroupBy(g => g.SlotGroupId, StringComparer.OrdinalIgnoreCase))
        {
            if (string.IsNullOrEmpty(group.Key)) { result.AddRange(group.Select(g => new List<GridLayout> { g })); continue; }

            // Weighted order without replacement: roll among the remaining members repeatedly.
            var remaining = group.ToList();
            var ordered = new List<GridLayout>(remaining.Count);
            while (remaining.Count > 0)
            {
                int total = remaining.Sum(WeightFor);
                int roll = rng.Next(total), acc = 0, pick = 0;
                for (int i = 0; i < remaining.Count; i++)
                {
                    acc += WeightFor(remaining[i]);
                    if (roll < acc) { pick = i; break; }
                }
                ordered.Add(remaining[pick]);
                remaining.RemoveAt(pick);
            }
            log.Add($"  [GRID] group '{group.Key}': chose '{ordered[0].Id}' of {ordered.Count}" +
                    (ordered.Count > 1 ? $" (fallback order: {string.Join(", ", ordered.Skip(1).Select(g => g.Id))})" : "") +
                    $" (weights {roomSize}: {string.Join(", ", group.Select(g => $"{g.Id}={WeightFor(g)}"))})");
            result.Add(ordered);
        }

        // An entry sorts by its rolled winner; Required if any member is required.
        return result
            .Select((e, i) => (e, i))
            .OrderBy(x => x.e.Any(g => !string.IsNullOrWhiteSpace(g.OppositeAnchor?.AnchorTarget))) // target first
            .ThenByDescending(x => x.e.Any(g => g.Required))
            .ThenBy(x => x.e[0].Priority)
            .ThenBy(x => x.i)
            .Select(x => x.e)
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
        HashSet<(int, int)>? mainSubRoomCells,
        HashSet<(int, int)>? narrowCells,
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
            new List<(string SlotId, string TileId, string Orient, int Col, int Row)>())
        {
            NarrowCells = narrowCells,
        };

        foreach (var entry in grids)
        {
            for (int i = 0; i < entry.Count; i++)
            {
                var grid = entry[i];
                if (i > 0) log.Add($"  [GRID] group '{grid.SlotGroupId}': '{entry[i - 1].Id}' did not fit, trying fallback '{grid.Id}'");
                var placed = TryPlaceGrid(grid, state, floorIndex, roomCells, cellWalls, doorCells, windowCells, pathCells,
                    allTiles, config, rng, roomTypeName, roomIndex1Based, selectionAnchorCol, selectionAnchorRow,
                    innerWallKeys, openingGroups, gapCells, stairEndCells, mainSubRoomCells, log);
                if (placed is null) continue;
                state = placed;
                break;
            }
        }

        return state;
    }

    private sealed record GridCellPlan(GridCell Cell, RoomTypeSlot Slot, List<TileDefinition> BasePool, bool Mandatory)
    {
        /// <summary>(base tile id, orient) → ResolveFinalTileForOrient result; that call scans every
        /// tile definition, and the same pairs recur for every candidate position.</summary>
        public Dictionary<(string, string), TileDefinition> OrientCache { get; } = new();

        /// <summary>(base tile id, world corner) → ResolveCornerVariant result (null = no corner variant).</summary>
        public Dictionary<(string, string), TileDefinition?> CornerCache { get; } = new();

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
        HashSet<(int, int)>? mainSubRoomCells,
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
            .Where(c => !RollGridCellEmpty(grid, c, rng, log))
            .Select(c => { var slot = BuildGridCellSlot(grid, c); return new GridCellPlan(c, slot, FilterTiles(allTiles, slot, roomTypeName), c.IsAnchor || c.Required); })
            .OrderByDescending(p => p.Cell.IsAnchor)
            .ThenByDescending(p => p.Mandatory)
            .ToList();

        var noTiles = plans.FirstOrDefault(p => p.Mandatory && p.BasePool.Count == 0);
        if (noTiles is not null) { Fail($"no matching tiles for mandatory cell '{noTiles.Cell.Id}'"); return null; }

        // MainSubRoom: pieces and keep-clear cells may only use the main sub-room's cells; walls,
        // validation and the connectivity check still see the whole room.
        var placeCells = grid.MainSubRoom && mainSubRoomCells is { Count: > 0 } ? mainSubRoomCells : roomCells;

        int optionalTotal = plans.Count(p => !p.Mandatory);
        var bounds = ComputeRoomBounds(placeCells);
        double centreCol = placeCells.Average(c => c.Item1), centreRow = placeCells.Average(c => c.Item2);
        bool isFree = grid.Mode.Equals("free", StringComparison.OrdinalIgnoreCase);
        bool isCorner = grid.Mode.Equals("corner", StringComparison.OrdinalIgnoreCase);

        var oppositeRule = string.IsNullOrWhiteSpace(grid.OppositeAnchor?.AnchorTarget) ? null : grid.OppositeAnchor;
        (int col, int row, int fpW, int fpH, string orient) oppositeTarget = default;
        if (oppositeRule is not null && !baseState.AnchorMap.TryGetValue(oppositeRule.AnchorTarget.Trim(), out oppositeTarget))
        {
            Fail($"opposite anchor '{oppositeRule.AnchorTarget}' was not placed");
            return null;
        }

        var candidates = new List<(int rot, bool mirror, int ox, int oy, double dist)>();
        if (oppositeRule is not null)
        {
            candidates = OppositeGridCandidates(grid, plans[0].Cell, oppositeRule, oppositeTarget, roomCells, innerWallKeys, rng);
        }
        else
        {
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
        }

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
                || !RectInRoom(ox + ax, oy + ay, aw, ah, placeCells))
                continue;
            // Inside spots don't touch a wall, same as the slot rule dropping NearWall.
            if (!isFree && oppositeRule?.OppositeWallAllowInside != true
                && !SatisfiesGridWallMode(grid, plans, rot, mirror, ox, oy, isCorner, roomCells, cellWalls))
                continue;

            if (++evaluated > GridSearchCandidateLimit) break;

            var result = EvaluateGridCandidate(grid, plans, rot, mirror, ox, oy, baseState, floorIndex, roomCells, placeCells, cellWalls,
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

        // The composite solver's AnchorMap holds one entry per key: register a random member of
        // each anchor group. The greedy pass gets every member via GridAnchorGroupMembers.
        foreach (var group in grid.Cells.Where(c => !string.IsNullOrWhiteSpace(c.AnchorGroup)).GroupBy(c => c.AnchorGroup.Trim(), StringComparer.OrdinalIgnoreCase))
        {
            var placedMembers = group
                .Select(c => best.AnchorMap.TryGetValue(GridCellSlotId(grid, c), out var e) ? e : ((int, int, int, int, string)?)null)
                .Where(e => e.HasValue).Select(e => e!.Value).ToList();
            if (placedMembers.Count > 0)
                best.AnchorMap.TryAdd(group.Key, placedMembers[rng.Next(placedMembers.Count)]);
        }

        var (bRot, bMirror, bOx, bOy) = bestTransform;
        if (oppositeRule?.KeepSightClear == true)
        {
            // No clear-check: only grid pieces exist so far, and the lane may cross those (coffee table).
            var a = plans[0].Cell;
            var (ax, ay, aw, ah) = TransformGridRect(a.X, a.Y, a.Footprint.Width, a.Footprint.Height, grid.Width, grid.Height, bRot, bMirror);
            best.BlockedFrontCells.UnionWith(SightLane(oppositeTarget.col, oppositeTarget.row, oppositeTarget.fpW, oppositeTarget.fpH,
                oppositeTarget.orient, bOx + ax, bOy + ay, aw, ah));
        }
        log.Add($"  [GRID] '{grid.Id}' placed {grid.Width}x{grid.Height} mode={grid.Mode} back={GridRotationNames[bRot]}{(bMirror ? " mirrored" : "")} " +
                $"origin=({bOx},{bOy}), optional {bestScore}/{optionalTotal} ({evaluated} candidates checked)");
        foreach (var p in best.SlotPlacements.Skip(baseState.SlotPlacements.Count))
            log.Add($"  [PLACED] '{p.SlotId}': '{p.TileId}' orient '{p.Orient}' at ({p.Col},{p.Row})");
        return best;
    }

    /// <summary>
    /// Transforms that put the grid's anchor piece opposite the target, its back edge on the side
    /// away from the target. Positions and their order come from the slot rule's candidates
    /// (centre of the target first, farthest first), so a 1-deep grid lands where a slot would.
    /// </summary>
    private static List<(int rot, bool mirror, int ox, int oy, double dist)> OppositeGridCandidates(
        GridLayout grid,
        GridCell anchor,
        AnchorRule rule,
        (int col, int row, int fpW, int fpH, string orient) target,
        HashSet<(int, int)> roomCells,
        HashSet<string>? innerWallKeys,
        Random rng)
    {
        var result = new List<(int rot, bool mirror, int ox, int oy, double dist)>();
        if (!Enum.TryParse<Direction>(target.orient, out var facing)) return result;

        int minDist = Math.Max(1, rule.MinOppositeWallDistance ?? 1);
        int maxDist = rule.MaxOppositeWallDistance is int maxCfg && maxCfg > 0 ? Math.Max(minDist, maxCfg) : int.MaxValue;
        var mirrors = !grid.AllowMirror ? new[] { false } : rng.Next(2) == 0 ? new[] { false, true } : new[] { true, false };
        foreach (var mirror in mirrors)
        for (int rot = 0; rot < 4; rot++)
        {
            if (TransformGridDir(Direction.N, rot, mirror) != facing) continue;
            var (ax, ay, aw, ah) = TransformGridRect(anchor.X, anchor.Y, anchor.Footprint.Width, anchor.Footprint.Height, grid.Width, grid.Height, rot, mirror);
            foreach (var pos in ComputeOppositeWallCandidates(target.col, target.row, target.fpW, target.fpH, target.orient,
                         aw, ah, minDist, maxDist, roomCells, innerWallKeys, rule.OppositeWallAllowInside))
                result.Add((rot, mirror, pos.col - ax, pos.row - ay, 0));
        }
        return result;
    }

    /// <summary>
    /// EmptyCategory on an optional grid piece: rolled once per grid placement against the real
    /// categories' combined weight (same odds as SelectSlots); an "empty" roll drops the piece.
    /// The anchor and required pieces never roll.
    /// </summary>
    private static bool RollGridCellEmpty(GridLayout grid, GridCell cell, Random rng, List<string> log)
    {
        if (cell.IsAnchor || cell.Required) return false;
        if (!cell.AllowedCategories.TryGetValue(EmptyCategory, out var emptyW) || emptyW <= 0) return false;
        int realW = cell.AllowedCategories.Where(kv => kv.Key != EmptyCategory).Sum(kv => Math.Max(0, kv.Value));
        if (realW <= 0) realW = 5;
        if (rng.Next(emptyW + realW) >= emptyW) return false;
        log.Add($"  [EMPTY] grid '{grid.Id}' piece '{cell.Id}' rolled empty ({emptyW}/{emptyW + realW})");
        return true;
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
        HashSet<(int, int)> placeCells,
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
        var hosts = new List<(int col, int row, TileDefinition tile)>(); // placed AllowStacking pieces
        var seatCells = new HashSet<(int, int)>(); // walk-up pieces (chairs) that need a reachable neighbour

        foreach (var plan in plans)
        {
            var c = plan.Cell;
            var (lx, ly, w, h) = TransformGridRect(c.X, c.Y, c.Footprint.Width, c.Footprint.Height, grid.Width, grid.Height, rot, mirror);
            var orient = TransformGridOrient(c.Orient, rot, mirror);
            var corner = TransformGridCorner(c.CornerOrient, rot, mirror);
            int pieceCol = ox + lx, pieceRow = oy + ly;
            if (c.EdgePiece)
            {
                if (ResolveEdgePiece(pieceCol, pieceRow, w, h, orient, roomCells, cellWalls) is not { } edge)
                {
                    if (plan.Mandatory) return null;
                    continue;
                }
                (pieceCol, pieceRow, orient) = edge;
            }
            var candidate = TryResolveGridCell(plan, pieceCol, pieceRow, w, h, orient, corner, state, baseState, roomCells, placeCells, cellWalls,
                doorCells, windowCells, pathCells, allTiles, config, rng, innerWallKeys, openingGroups, gapCells, stairEndCells, hosts);
            if (candidate is null)
            {
                if (plan.Mandatory) return null;
                continue;
            }

            CommitLayoutPlacement(floorIndex, plan.Slot, candidate, roomIndex1Based, selectionAnchorCol, selectionAnchorRow, state);
            if (c.AllowStacking) hosts.Add((candidate.Col, candidate.Row, candidate.Tile));
            var t = candidate.Tile;
            // Base-layer only: stacked Furniture2/3 pieces (sink, microwave) sit on a counter, not on the floor.
            if (!t.HasCollision && t.Layer.Equals("Furniture", StringComparison.OrdinalIgnoreCase))
                for (int r = 0; r < h; r++)
                    for (int x = 0; x < w; x++)
                        seatCells.Add((candidate.Col + x, candidate.Row + r));
            if (!plan.Mandatory) optionalPlaced++;
        }

        // Keep-clear cells must be free walkable room cells; afterwards they block every later
        // piece except collision-free floor decor (rugs), exactly like a BlocksFrontCell cell.
        foreach (var kc in grid.KeepClear)
        {
            if (kc.X < 0 || kc.Y < 0 || kc.X >= grid.Width || kc.Y >= grid.Height) continue;
            var (x, y, _, _) = TransformGridRect(kc.X, kc.Y, 1, 1, grid.Width, grid.Height, rot, mirror);
            var cell = (ox + x, oy + y);
            if (!placeCells.Contains(cell) || state.Occupied.Contains(cell) || state.PhysicalOccupied.Contains(cell))
                return null;
            state.BlockedFrontCells.Add(cell);
        }

        // The whole grid must not split the room or wall off a door or opening. Every grid piece
        // counts here, including non-colliding ones (chairs) that the per-piece opening check
        // ignores — a table group filling a 2-wide opening would otherwise seal the room off.
        var blocked = new HashSet<(int, int)>(state.Occupied);
        blocked.UnionWith(state.PhysicalOccupied);
        var entryCells = doorCells;
        if (openingGroups is { Count: > 0 })
        {
            if (openingGroups.Any(g => g.All(blocked.Contains)))
                return null;
            entryCells = new HashSet<(int, int)>(doorCells.Concat(openingGroups.SelectMany(g => g)));
        }
        // Seats must be reachable too — a back-row chair boxed in by wall, table and its
        // neighbour chair passes the free-cell connectivity check but is unusable.
        if (!RoomRemainsConnected(0, 0, 0, 0, roomCells, blocked, entryCells, innerWallKeys, seatCells))
            return null;

        return (state, optionalPlaced);
    }

    /// <summary>
    /// EdgePiece: where a piece on the given world edge really goes. N/W edges stay on the cell;
    /// E/S edges are the W/N edge of the next cell (as ComputeOpenSidePosition does for slots).
    /// Null when a wall already runs along that edge or the far side of it isn't this room.
    /// </summary>
    private static (int col, int row, string orient)? ResolveEdgePiece(
        int col, int row, int fpW, int fpH, string orient,
        HashSet<(int, int)> roomCells, Dictionary<(int, int), HashSet<Direction>> cellWalls)
    {
        if (!Enum.TryParse<Direction>(orient, out var edge) || FootprintTouchesWallDir(col, row, fpW, fpH, cellWalls, edge))
            return null;
        var across = edge switch
        {
            Direction.N => (col, row - 1),
            Direction.S => (col, row + fpH),
            Direction.W => (col - 1, row),
            _           => (col + fpW, row),
        };
        if (!roomCells.Contains(across)) return null;
        return edge switch
        {
            Direction.E => (col + fpW, row, "W"),
            Direction.S => (col, row + fpH, "N"),
            _           => (col, row, orient),
        };
    }

    private static LayoutPlacementCandidate? TryResolveGridCell(
        GridCellPlan plan,
        int col,
        int row,
        int fpW,
        int fpH,
        string orient,
        string? corner,
        LayoutPlacementState state,
        LayoutPlacementState baseState,
        HashSet<(int, int)> roomCells,
        HashSet<(int, int)> placeCells,
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
        HashSet<(int, int)>? stairEndCells,
        List<(int col, int row, TileDefinition tile)> hosts)
    {
        if (plan.BasePool.Count == 0 || !RectInRoom(col, row, fpW, fpH, placeCells))
            return null;
        var occupied = plan.Cell.EdgePiece ? baseState.Occupied : state.Occupied;
        if (plan.CanPrecheckOccupancy && !FitsFootprintLoose(col, row, fpW, fpH, occupied))
            return null;

        // AgainstWall: the back edge must touch a wall here (cheap, tile-independent pre-check);
        // the per-tile FootprintFullyBacked check below catches a piece half past a wall's end.
        Direction? againstWallDir = null;
        if (plan.Cell.AgainstWall && corner is null) // a corner piece checks both its walls below
        {
            againstWallDir = BackWall(orient);
            if (againstWallDir is not { } back || !FootprintTouchesWallDir(col, row, fpW, fpH, cellWalls, back))
                return null;
        }

        // Corner piece: needs a true room corner here and the pool tiles' corner variants; the
        // corner string doubles as the placed orient (same as the slot path's corner variants).
        if (corner is not null && !FootprintHasCornerCell(col, row, fpW, fpH, corner, cellWalls))
            return null;

        var (pool, colorGroup) = ApplyLayoutGroupFilters(plan.BasePool, plan.Slot, state, config);
        if (pool.Count == 0) return null;

        if (corner is not null)
        {
            foreach (var baseTile in OrderTileCandidatesForLayout(pool, plan.Slot, rng))
            {
                if (!plan.CornerCache.TryGetValue((baseTile.Id, corner), out var tile))
                    plan.CornerCache[(baseTile.Id, corner)] = tile = ResolveCornerVariant(baseTile, corner, allTiles);
                if (tile is null) continue;

                int tW = tile.TileLayout.Count > 0 ? (tile.TileLayout[0]?.Count ?? 1) : 1;
                if (tW != fpW || tile.TileLayout.Count != fpH) continue;
                if (!FitsStackingHosts(col, row, tile, hosts)) continue;
                if (IsValidAnchoredPlacement(plan.Slot, col, row, fpW, fpH, corner, tile, roomCells, cellWalls, doorCells,
                        windowCells, pathCells, occupied, state.PhysicalOccupied, state.BlockedFrontCells, innerWallKeys,
                        openingGroups, state.CellPropertyGates, state.ReservedZoneCells, state.FrontExemptCells, gapCells,
                        effectiveSoftOccupied: baseState.SoftOccupied, stairEndCells: stairEndCells, narrowCells: state.NarrowCells, wallFaces: state.WallFaces, highOccupied: baseState.HighCells))
                    return new LayoutPlacementCandidate(col, row, corner, tile, colorGroup);
            }
            return null;
        }

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
            if (!FitsStackingHosts(col, row, tile, hosts)) continue;
            if (againstWallDir is { } backDir && !FootprintFullyBacked(col, row, fpW, fpH, backDir, tile, cellWalls, roomCells)) continue;

            // Soft blocks created by this grid's own pieces (e.g. the loot-container front cell of
            // a desk) must not veto another piece of the same grid (the chair in front of it) —
            // the grid author placed them deliberately (same for high cells: shower + its wall).
            // Hard occupancy still applies.
            if (IsValidAnchoredPlacement(plan.Slot, col, row, fpW, fpH, orient, tile, roomCells, cellWalls, doorCells,
                    windowCells, pathCells, occupied, state.PhysicalOccupied, state.BlockedFrontCells, innerWallKeys,
                    openingGroups, state.CellPropertyGates, state.ReservedZoneCells, state.FrontExemptCells, gapCells,
                    effectiveSoftOccupied: baseState.SoftOccupied, stairEndCells: stairEndCells, narrowCells: state.NarrowCells, wallFaces: state.WallFaces, highOccupied: baseState.HighCells))
                return new LayoutPlacementCandidate(col, row, orient, tile, colorGroup);
        }

        return null;
    }

    /// <summary>
    /// A grid piece overlapping a stacking host of the same grid (GridCell.AllowStacking, e.g. an
    /// L-desk) must match the host's real tile shape, not its bounding box: a piece on another
    /// layer (PC on Furniture2) must stand on host tiles, a piece on the same layer (chair) only on
    /// the host's empty layout cells ("" entries, e.g. the L's inner corner). Wall and floor-layer
    /// pieces (pictures, rugs) are exempt. Because the host's shape doesn't rotate with the grid when the
    /// tile has a single orientation variant, this also rejects grid rotations/mirrors in which
    /// the pieces no longer line up with the sprite.
    /// </summary>
    private static bool FitsStackingHosts(int col, int row, TileDefinition tile, List<(int col, int row, TileDefinition tile)> hosts)
    {
        if (hosts.Count == 0 || IsNarrowExempt(tile)) // wall-mounted and floor-layer pieces don't stand on furniture
            return true;
        foreach (var (hc, hr, host) in hosts)
        {
            bool sameLayer = host.Layer.Equals(tile.Layer, StringComparison.OrdinalIgnoreCase);
            for (int r = 0; r < tile.TileLayout.Count; r++)
            {
                var rowTiles = tile.TileLayout[r];
                if (rowTiles is null) continue;
                for (int c = 0; c < rowTiles.Count; c++)
                {
                    if (string.IsNullOrEmpty(rowTiles[c])) continue;
                    int lr = row + r - hr, lc = col + c - hc;
                    if (lr < 0 || lr >= host.TileLayout.Count) continue;
                    var hostRow = host.TileLayout[lr];
                    if (hostRow is null || lc < 0 || lc >= hostRow.Count) continue; // outside the host's box
                    bool onHostTile = !string.IsNullOrEmpty(hostRow[lc]);
                    if (onHostTile == sameLayer) return false;
                }
            }
        }
        return true;
    }

    /// <summary>
    /// Copy of a grid state suitable as the composite solver's initial state: occupancy, anchors
    /// and colour/variant locks carry over, but Placements/SlotPlacements start empty because the
    /// grid's placements were already emitted.
    /// </summary>
    private static LayoutPlacementState SeedStateFromGrids(LayoutPlacementState gridState)
    {
        var seed = gridState.Clone();
        foreach (var p in gridState.Placements) seed.GridCells.Add((p.Col, p.Row));
        seed.Placements.Clear();
        seed.SlotPlacements.Clear();
        return seed;
    }

    /// <summary>
    /// GridCell.AnchorGroup → every placed member piece (across all grids), shuffled so the
    /// round-robin pick in PlaceSlot spreads dependent slots over random pieces.
    /// </summary>
    private static Dictionary<string, List<(int col, int row, int fpW, int fpH, string orient)>> GridAnchorGroupMembers(
        RoomTypeConfig config, LayoutPlacementState gridState, Random rng)
    {
        var result = new Dictionary<string, List<(int col, int row, int fpW, int fpH, string orient)>>(StringComparer.OrdinalIgnoreCase);
        foreach (var grid in config.Grids)
            foreach (var cell in grid.Cells)
            {
                if (string.IsNullOrWhiteSpace(cell.AnchorGroup)
                    || !gridState.AnchorMap.TryGetValue(GridCellSlotId(grid, cell), out var entry)) continue;
                var key = cell.AnchorGroup.Trim();
                if (!result.TryGetValue(key, out var list)) result[key] = list = [];
                list.Add(entry);
            }
        foreach (var key in result.Keys.ToList())
            result[key] = ShuffleCopy(result[key], rng);
        return result;
    }

    /// <summary>
    /// Anchor keys of every piece of the grid that `key` names: a grid id, or a grid group name —
    /// then the group member actually placed in this room (its anchor is registered under its id).
    /// Empty if `key` is no grid.
    /// </summary>
    private static List<string> GridClusterMemberIds(
        RoomTypeConfig config, string key,
        Dictionary<string, List<(int col, int row, int fpW, int fpH, string orient)>> anchorMap)
    {
        var grid = config.Grids.FirstOrDefault(g => g.Id.Equals(key, StringComparison.OrdinalIgnoreCase))
            ?? config.Grids.FirstOrDefault(g => !string.IsNullOrEmpty(g.SlotGroupId)
                && g.SlotGroupId.Equals(key, StringComparison.OrdinalIgnoreCase)
                && anchorMap.ContainsKey(g.Id));
        return grid is null ? [] : grid.Cells.Select(c => GridCellSlotId(grid, c)).ToList();
    }
}
