using backend.Models;

namespace backend.Services;

// ── Request / Response ────────────────────────────────────────────────────────

/// <summary>One room the user wants to furnish.</summary>
public record RoomSelection(
    int    FloorIndex,
    int    RoomIndex1Based,
    /// <summary>If non-empty, overrides room.Name for type lookup.</summary>
    string RoomTypeOverride = "");

public record FurnishRequest(
    Building            Building,
    List<RoomSelection> RoomSelections,
    int?                Seed = null);

/// <summary>A single tile placed on the grid.</summary>
public record PlacedFurnitureItem(
    int    FloorIndex,
    int    Col,
    int    Row,
    string TileId,
    string Layer,
    string Orient,
    string SlotId = "");

public record FurnishResult(
    List<PlacedFurnitureItem> Placements,
    List<string>              Log);

// ── Interface ─────────────────────────────────────────────────────────────────

public interface IFurnishingGeneratorService
{
    FurnishResult Generate(FurnishRequest request);
}

// ── Implementation ────────────────────────────────────────────────────────────

public class FurnishingGeneratorService : IFurnishingGeneratorService
{
    private readonly IRoomTypeConfigService _roomTypeSvc;
    private readonly ITileConfigService     _tileSvc;

    public FurnishingGeneratorService(IRoomTypeConfigService roomTypeSvc, ITileConfigService tileSvc)
    {
        _roomTypeSvc = roomTypeSvc;
        _tileSvc     = tileSvc;
    }

    // =========================================================================
    // Main entry point
    // =========================================================================

    public FurnishResult Generate(FurnishRequest req)
    {
        var rng        = new Random(req.Seed ?? Environment.TickCount);
        var placements = new List<PlacedFurnitureItem>();
        var log        = new List<string>();
        var allTiles   = _tileSvc.GetAll();
        var roomTypes  = _roomTypeSvc.GetAll();

        foreach (var sel in req.RoomSelections)
        {
            var floor = req.Building.Floors.FirstOrDefault(f => f.Index == sel.FloorIndex);
            if (floor is null) { log.Add($"[SKIP] Floor {sel.FloorIndex} not found."); continue; }

            if (sel.RoomIndex1Based < 1 || sel.RoomIndex1Based > req.Building.Rooms.Count)
            { log.Add($"[SKIP] Room index {sel.RoomIndex1Based} out of range."); continue; }

            var room = req.Building.Rooms[sel.RoomIndex1Based - 1];

            // 1. Room-type matching via InternalName (case-insensitive)
            var typeName  = !string.IsNullOrWhiteSpace(sel.RoomTypeOverride) ? sel.RoomTypeOverride : room.InternalName;
            var configKey = roomTypes.Keys.FirstOrDefault(k => k.Equals(typeName, StringComparison.OrdinalIgnoreCase));
            if (configKey is null)
            { log.Add($"[SKIP] '{room.Name}' / InternalName='{room.InternalName}' (floor {sel.FloorIndex}): no RoomTypeConfig for '{typeName}'."); continue; }

            var config = roomTypes[configKey];

            // 2. Room analysis
            var roomCells   = GetRoomCells(floor, sel.RoomIndex1Based);
            var roomSize    = RoomSize.Classify(roomCells.Count);
            var cellWalls   = ComputeWallDirections(roomCells);
            var doorCells   = GetEdgeCells(floor, roomCells, FloorObjectType.Door);
            var windowCells = GetEdgeCells(floor, roomCells, FloorObjectType.Window);
            var occupied    = new HashSet<(int, int)>();

            // Pfad-Zellen des Raums (aus PathsByRoom, falls vorhanden)
            var pathCells = floor.PathsByRoom.TryGetValue(sel.RoomIndex1Based, out var path)
                ? path.Select(p => (p[0], p[1])).ToHashSet()
                : new HashSet<(int, int)>();

            log.Add($"[ROOM] '{room.Name}' → config '{configKey}', {roomCells.Count} cells, size {roomSize}, {pathCells.Count} path cells");

            // 3. Slot selection
            var slotsToPlace = SelectSlots(config, roomSize, rng, log);

            // 4. Place each slot
            var anchorMap = new Dictionary<string, (int col, int row, int fpW, int fpH)>(StringComparer.OrdinalIgnoreCase);
            foreach (var (slot, count) in slotsToPlace)
                for (int n = 0; n < count; n++)
                    PlaceSlot(slot, sel.FloorIndex, roomCells, cellWalls, doorCells, windowCells,
                        pathCells, occupied, allTiles, anchorMap, placements, log, rng, configKey);
        }

        return new FurnishResult(placements, log);
    }

    // =========================================================================
    // Slot selection
    // =========================================================================

    private static List<(RoomTypeSlot slot, int count)> SelectSlots(
        RoomTypeConfig config, string roomSize, Random rng, List<string> log)
    {
        var result       = new List<(RoomTypeSlot, int)>();
        var groupWinners = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // Resolve group variants: one winner per SlotGroupId
        foreach (var grp in config.Slots
            .Where(s => !string.IsNullOrEmpty(s.SlotGroupId))
            .GroupBy(s => s.SlotGroupId!, StringComparer.OrdinalIgnoreCase))
        {
            var variants = grp.ToList();
            var totalW   = variants.Sum(s => s.GroupWeight);
            if (totalW <= 0) totalW = variants.Count; // fallback: equal weight
            int acc = 0, roll = rng.Next(totalW);
            var winner = variants[0];
            foreach (var v in variants) { acc += v.GroupWeight; if (roll < acc) { winner = v; break; } }
            groupWinners.Add(winner.Id);
            log.Add($"  [GROUP] '{grp.Key}': chose '{winner.Id}' ({winner.GroupWeight}/{totalW})");
        }

        // Eligible = ungrouped + group winners; required first, then by priority
        foreach (var slot in config.Slots
            .Where(s => string.IsNullOrEmpty(s.SlotGroupId) || groupWinners.Contains(s.Id))
            .OrderByDescending(s => s.Required).ThenBy(s => s.Priority))
        {
            if (!slot.CountBySize.TryGetValue(roomSize, out var cnt))
                cnt = new SlotCount { Min = 0, Max = 0 };

            int max   = cnt.Max == -1 ? 99 : cnt.Max;
            int count = max <= 0 ? 0 : slot.Required ? Math.Max(cnt.Min, 1) : rng.Next(cnt.Min, max + 1);
            if (count <= 0) continue;

            result.Add((slot, count));
            log.Add($"  [SLOT] '{slot.Id}' ({slot.Label}): {count}× (min {cnt.Min}, max {cnt.Max})");
        }

        return result;
    }

    // =========================================================================
    // Place a single slot instance
    // =========================================================================

    private static void PlaceSlot(
        RoomTypeSlot slot, int floorIndex,
        HashSet<(int, int)> roomCells,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        HashSet<(int, int)> doorCells, HashSet<(int, int)> windowCells,
        HashSet<(int, int)> pathCells,
        HashSet<(int, int)> occupied,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        Dictionary<string, (int col, int row, int fpW, int fpH)> anchorMap,
        List<PlacedFurnitureItem> placements, List<string> log, Random rng,
        string roomTypeName = "")
    {
        var candidates = FilterTiles(allTiles, slot, roomTypeName);
        if (candidates.Count == 0) { log.Add($"  [WARN] '{slot.Id}': no matching tiles."); return; }

        // Resolve anchor rule
        (int col, int row, int fpW, int fpH)? anchorInfo = null;
        string? anchorPos = null;
        if (slot.AnchorRules?.Count > 0)
        {
            foreach (var rule in slot.AnchorRules)
                if (!string.IsNullOrEmpty(rule.AnchorTarget) && anchorMap.TryGetValue(rule.AnchorTarget, out var ap))
                {
                    anchorInfo = ap;
                    anchorPos  = rule.Positions.Count > 0 ? rule.Positions[rng.Next(rule.Positions.Count)] : null;
                    break;
                }
        }

        var tile = SelectTile(candidates, slot, rng);
        if (tile is null) return;

        // fpW/fpH of baseTile (used for anchor offset calculation only)
        int fpW = tile.TileLayout.Count > 0 ? (tile.TileLayout[0]?.Count ?? 1) : 1;
        int fpH = tile.TileLayout.Count;

        (int col, int row, string orient, TileDefinition placedTile)? result;
        if (anchorInfo.HasValue && anchorPos != null)
        {
            var p = ComputeAnchoredPosition(anchorInfo.Value.col, anchorInfo.Value.row,
                anchorInfo.Value.fpW, anchorInfo.Value.fpH, fpW, fpH, anchorPos);
            result = (p.HasValue && FitsFootprintLoose(p.Value.col, p.Value.row, fpW, fpH, occupied))
                ? (p.Value.col, p.Value.row, tile.Orientation, tile)
                : null;
        }
        else
        {
            // Primary placement attempt
            result = FindFreeCell(slot, roomCells, cellWalls, doorCells, windowCells,
                pathCells, occupied, tile, allTiles, slot.PlacementRules, rng);

            // Fallback chain: iterate FallbackRules in order if primary failed
            if (result is null && slot.FallbackRules?.Count > 0)
            {
                for (int fb = 0; fb < slot.FallbackRules.Count && result is null; fb++)
                {
                    var fbRules = slot.FallbackRules[fb];
                    result = FindFreeCell(slot, roomCells, cellWalls, doorCells, windowCells,
                        pathCells, occupied, tile, allTiles, fbRules, rng);
                    if (result != null)
                        log.Add($"    [FALLBACK {fb + 1}] '{slot.Id}': used fallback rule #{fb + 1}");
                }
            }
        }

        if (result is null) { log.Add($"  [WARN] '{slot.Id}': no valid position for '{tile.TileId}'."); return; }

        var (col, row, orient, placedTile) = result.Value;
        int finalFpW = placedTile.TileLayout.Count > 0 ? (placedTile.TileLayout[0]?.Count ?? 1) : 1;
        int finalFpH = placedTile.TileLayout.Count;

        for (int r = 0; r < placedTile.TileLayout.Count; r++)
        {
            var rowTiles = placedTile.TileLayout[r];
            if (rowTiles is null) continue;
            for (int c = 0; c < rowTiles.Count; c++)
            {
                var tid = rowTiles[c];
                if (string.IsNullOrEmpty(tid)) continue;
                placements.Add(new PlacedFurnitureItem(floorIndex, col + c, row + r, tid, placedTile.Layer, orient, slot.Id));
                occupied.Add((col + c, row + r));
            }
        }

        if (!string.IsNullOrEmpty(slot.Id))          anchorMap[slot.Id]          = (col, row, finalFpW, finalFpH);
        if (!string.IsNullOrEmpty(slot.SlotGroupId))  anchorMap.TryAdd(slot.SlotGroupId, (col, row, finalFpW, finalFpH));

        log.Add($"  [PLACED] '{slot.Id}': '{placedTile.TileId}' orient '{orient}' at ({col},{row})");
    }

    // =========================================================================
    // Tile filtering & selection
    // =========================================================================

    private static List<TileDefinition> FilterTiles(
        IReadOnlyDictionary<string, TileDefinition> allTiles, RoomTypeSlot slot,
        string roomTypeName = "") =>
        allTiles.Values
            .Where(t => string.IsNullOrEmpty(slot.RequiredLayer)
                     || t.Layer.Equals(slot.RequiredLayer, StringComparison.OrdinalIgnoreCase))
            .Where(t => slot.AllowedCategories.Count == 0 || slot.AllowedCategories.ContainsKey(t.Group))
            .Where(t => slot.RequiredProperties.All(p => GetBoolProperty(t, p)))
            .Where(t => t.RoomTypes.Count == 0
                     || string.IsNullOrEmpty(roomTypeName)
                     || t.RoomTypes.Any(rt => rt.Equals(roomTypeName, StringComparison.OrdinalIgnoreCase)))
            .ToList();

    private static TileDefinition? SelectTile(List<TileDefinition> candidates, RoomTypeSlot slot, Random rng)
    {
        if (candidates.Count == 0) return null;
        if (slot.AllowedCategories.Count == 0) return candidates[rng.Next(candidates.Count)];

        var available = slot.AllowedCategories.Where(kv => candidates.Any(t => t.Group == kv.Key)).ToList();
        if (available.Count == 0) return candidates[rng.Next(candidates.Count)];

        int totalWeight = available.Sum(kv => kv.Value);
        if (totalWeight <= 0) return candidates[rng.Next(candidates.Count)]; // fallback
        int acc = 0, roll = rng.Next(totalWeight);
        string chosen = available[0].Key;
        foreach (var kv in available) { acc += kv.Value; if (roll < acc) { chosen = kv.Key; break; } }

        var inGroup = candidates.Where(t => t.Group == chosen).ToList();
        return inGroup.Count > 0 ? inGroup[rng.Next(inGroup.Count)] : candidates[rng.Next(candidates.Count)];
    }

    private static bool GetBoolProperty(TileDefinition t, string prop) => prop switch
    {
        "isHigh"        => t.IsHigh,
        "isLow"         => t.IsLow,
        "isWallMounted" => t.IsWallMounted,
        "hasSurface"    => t.HasSurface,
        "hasCollision"  => t.HasCollision,
        "canStack"      => t.CanStack,
        "isTableTop"    => t.IsTableTop,
        _               => false,
    };

    // =========================================================================
    // Placement cell search
    // =========================================================================

    private static (int col, int row, string orient, TileDefinition tile)? FindFreeCell(
        RoomTypeSlot slot,
        HashSet<(int, int)> roomCells,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        HashSet<(int, int)> doorCells, HashSet<(int, int)> windowCells,
        HashSet<(int, int)> pathCells,
        HashSet<(int, int)> occupied,
        TileDefinition baseTile,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        PlacementRules rules,
        Random rng)
    {
        IEnumerable<(int col, int row)> pool = roomCells;

        if (rules.NearWall)   pool = pool.Where(c => cellWalls.ContainsKey(c));
        if (rules.NearDoor)   pool = pool.Where(c => doorCells.Contains(c));
        if (rules.NearWindow) pool = pool.Where(c => windowCells.Contains(c));
        if (rules.CornerOnly) pool = pool.Where(c => cellWalls.TryGetValue(c, out var w) && w.Count >= 2);

        // Pfad-Schutz: Möbel mit Kollision dürfen nicht auf Laufwegen stehen,
        // außer der Slot erlaubt es explizit (AllowOnPath = true).
        if (!rules.AllowOnPath && baseTile.HasCollision && pathCells.Count > 0)
            pool = pool.Where(c => !pathCells.Contains(c));

        if (rules.CenterRoom)
        {
            float cx = roomCells.Average(c => (float)c.Item1);
            float cy = roomCells.Average(c => (float)c.Item2);
            pool = pool.OrderBy(c => Math.Abs(c.Item1 - cx) + Math.Abs(c.Item2 - cy));
        }

        var poolList = pool.Distinct().ToList();

        // Shuffle for randomness
        for (int i = poolList.Count - 1; i > 0; i--)
        { int j = rng.Next(i + 1); (poolList[i], poolList[j]) = (poolList[j], poolList[i]); }

        foreach (var cell in poolList)
        {
            var resolved = ResolveVariantForCell(
                baseTile, cell, cellWalls, allTiles, rules);

            // Keine passende Orientierungsvariante für diese Wandzelle → überspringen
            if (resolved is null) continue;

            var (resolvedTile, orient) = resolved.Value;

            int fpW = resolvedTile.TileLayout.Count > 0 ? (resolvedTile.TileLayout[0]?.Count ?? 1) : 1;
            int fpH = resolvedTile.TileLayout.Count;

            if (!FitsFootprint(cell.col, cell.row, fpW, fpH, roomCells, occupied)) continue;
            // Türbereich freilassen: kein Möbel-Footprint darf eine Türzelle überdecken,
            // außer der Slot ist explizit NearDoor (z.B. Garderobenhalter an der Tür).
            if (!rules.NearDoor && FootprintTouchesCells(cell.col, cell.row, fpW, fpH, doorCells)) continue;

            return (cell.col, cell.row, orient, resolvedTile);
        }

        return null;
    }

    /// <summary>
    /// Bestimmt für eine konkrete Wandzelle die korrekte Tile-Variante und Orientierung.
    /// Gibt null zurück wenn keine passende Orientierungsvariante gefunden wurde –
    /// die Zelle wird dann von FindFreeCell übersprungen.
    /// </summary>
    private static (TileDefinition tile, string orient)? ResolveVariantForCell(
        TileDefinition baseTile,
        (int col, int row) cell,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        PlacementRules rules)
    {
        // Ohne NearWall oder keine Wand an der Zelle: Tile unverändert
        if (!rules.NearWall || !cellWalls.TryGetValue(cell, out var wallDirs) || wallDirs.Count == 0)
            return (baseTile, baseTile.Orientation);

        // Wandrichtung bestimmen: bevorzugt die, die zum Rücken des BaseTile passt
        var backExpected = BackWall(baseTile.Orientation);
        Direction wallDir = (backExpected.HasValue && wallDirs.Contains(backExpected.Value))
            ? backExpected.Value
            : wallDirs.OrderByDescending(d => d).First();

        // Vorderseite zeigt in den Raum
        string neededOrient = WallToOrient(wallDir) ?? baseTile.Orientation;

        // Prüfe ob baseTile selbst schon passt (richtiger Orient + passendes Aspektverhältnis)
        if (baseTile.Orientation.Equals(neededOrient, StringComparison.OrdinalIgnoreCase)
            && MatchesAlignment(baseTile, wallDir, rules.WallAlignment))
            return (baseTile, neededOrient);

        // Suche in VariantGroup nach passender Variante
        if (!string.IsNullOrEmpty(baseTile.VariantGroup))
        {
            var variants = allTiles.Values
                .Where(t => t.VariantGroup == baseTile.VariantGroup
                         && t.Orientation.Equals(neededOrient, StringComparison.OrdinalIgnoreCase))
                .ToList();

            if (variants.Count > 0)
            {
                // Bevorzuge Variante die WallAlignment-Aspektverhältnis erfüllt
                var best = variants.FirstOrDefault(t => MatchesAlignment(t, wallDir, rules.WallAlignment))
                        ?? variants[0];
                return (best, neededOrient);
            }
        }

        // Keine passende Variante gefunden → Zelle ablehnen
        return null;
    }

    /// <summary>
    /// Prüft ob das Aspektverhältnis eines Tiles zum gewünschten WallAlignment passt.
    /// perpendicular (senkrecht): lange Achse geht IN den Raum (fpH &gt; fpW bei N/S-Wand).
    /// parallel: lange Achse läuft ENTLANG der Wand (fpW &gt; fpH bei N/S-Wand).
    /// any: immer true.
    /// </summary>
    private static bool MatchesAlignment(TileDefinition tile, Direction wallDir, string alignment)
    {
        if (string.IsNullOrEmpty(alignment) || alignment == "any") return true;
        int fpW = tile.TileLayout.Count > 0 ? (tile.TileLayout[0]?.Count ?? 1) : 1;
        int fpH = tile.TileLayout.Count;
        if (fpW == fpH) return true; // Quadrat – Ausrichtung irrelevant
        bool isNSwall = wallDir is Direction.N or Direction.S;
        bool isWide   = fpW > fpH;
        // N/S-Wand: senkrecht = hoch (fpH > fpW), parallel = breit (fpW > fpH)
        // O/W-Wand: senkrecht = breit (fpW > fpH), parallel = hoch (fpH > fpW)
        return alignment switch
        {
            "perpendicular" => isNSwall ? !isWide : isWide,
            "parallel"      => isNSwall ?  isWide : !isWide,
            _               => true,
        };
    }

    private static bool FitsFootprint(int col, int row, int fpW, int fpH,
        HashSet<(int, int)> roomCells, HashSet<(int, int)> occupied)
    {
        for (int r = 0; r < fpH; r++)
            for (int c = 0; c < fpW; c++)
                if (!roomCells.Contains((col + c, row + r)) || occupied.Contains((col + c, row + r)))
                    return false;
        return true;
    }

    private static bool FitsFootprintLoose(int col, int row, int fpW, int fpH, HashSet<(int, int)> occupied)
    {
        for (int r = 0; r < fpH; r++)
            for (int c = 0; c < fpW; c++)
                if (occupied.Contains((col + c, row + r))) return false;
        return true;
    }

    /// <summary>
    /// Prüft ob irgendeine Zelle des Footprints in der gegebenen Zellmenge liegt
    /// (z.B. Türzellen). Wird genutzt um Möbel-Footprints von Türbereichen fernzuhalten.
    /// </summary>
    private static bool FootprintTouchesCells(int col, int row, int fpW, int fpH,
        HashSet<(int, int)> cells)
    {
        if (cells.Count == 0) return false;
        for (int r = 0; r < fpH; r++)
            for (int c = 0; c < fpW; c++)
                if (cells.Contains((col + c, row + r))) return true;
        return false;
    }

    /// <summary>
    /// Wall at the BACK of furniture with this orientation.
    /// Convention: Orient = Vorderseite. "S" (zeigt Süden) → Rücken = Norden.
    /// </summary>
    private static Direction? BackWall(string orient) => orient switch
    {
        "S" => Direction.N,
        "N" => Direction.S,
        "W" => Direction.E,
        "E" => Direction.W,
        _   => null,
    };

    /// <summary>
    /// Converts a wall direction to the furniture orientation placed against it.
    /// Wall N (Nordwand im Rücken) → Orient "S" (Vorderseite zeigt nach Süden).
    /// </summary>
    private static string? WallToOrient(Direction wall) => wall switch
    {
        Direction.N => "S",
        Direction.S => "N",
        Direction.E => "W",
        Direction.W => "E",
        _           => null,
    };

    // =========================================================================
    // Anchor position offset calculation
    // =========================================================================

    private static (int col, int row)? ComputeAnchoredPosition(
        int ac, int ar, int aw, int ah, int depW, int depH, string position) => position switch
    {
        "HeadLeft"  => (ac - depW,               ar),
        "HeadRight" => (ac + aw,                 ar),
        "FootLeft"  => (ac - depW,               ar + ah - depH),
        "FootRight" => (ac + aw,                 ar + ah - depH),
        "Left"      => (ac - depW,               ar + (ah - depH) / 2),
        "Right"     => (ac + aw,                 ar + (ah - depH) / 2),
        "Above"     => (ac,                      ar - depH),
        "Below"     => (ac,                      ar + ah),
        "Center"    => (ac + (aw - depW) / 2,    ar + (ah - depH) / 2),
        _           => null,
    };

    // =========================================================================
    // Room analysis helpers
    // =========================================================================

    private static HashSet<(int col, int row)> GetRoomCells(Floor floor, int roomIndex1Based)
    {
        var cells = new HashSet<(int, int)>();
        for (int r = 0; r < floor.RoomGrid.Length; r++)
            for (int c = 0; c < floor.RoomGrid[r].Length; c++)
                if (floor.RoomGrid[r][c] == roomIndex1Based) cells.Add((c, r));
        return cells;
    }

    private static Dictionary<(int, int), HashSet<Direction>> ComputeWallDirections(
        HashSet<(int, int)> roomCells)
    {
        var result = new Dictionary<(int, int), HashSet<Direction>>();
        foreach (var (col, row) in roomCells)
        {
            var dirs = new HashSet<Direction>();
            if (!roomCells.Contains((col,     row - 1))) dirs.Add(Direction.N);
            if (!roomCells.Contains((col,     row + 1))) dirs.Add(Direction.S);
            if (!roomCells.Contains((col - 1, row    ))) dirs.Add(Direction.W);
            if (!roomCells.Contains((col + 1, row    ))) dirs.Add(Direction.E);
            if (dirs.Count > 0) result[(col, row)] = dirs;
        }
        return result;
    }

    private static HashSet<(int, int)> GetEdgeCells(
        Floor floor, HashSet<(int, int)> roomCells, FloorObjectType type)
    {
        var result = new HashSet<(int, int)>();
        foreach (var edge in floor.Edges.Where(e => e.Type == type))
        {
            if (roomCells.Contains((edge.Cell1Col, edge.Cell1Row))) result.Add((edge.Cell1Col, edge.Cell1Row));
            if (roomCells.Contains((edge.Cell2Col, edge.Cell2Row))) result.Add((edge.Cell2Col, edge.Cell2Row));
        }
        return result;
    }
}
























