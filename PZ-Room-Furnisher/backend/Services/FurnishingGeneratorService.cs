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
    int?                Seed       = null,
    /// <summary>
    /// Möblierungsdichte: ein zufälliger Wert aus [DensityMin, DensityMax] wird pro Aufruf gezogen.
    /// 0.0 = nur Pflicht-Slots auf Minimum · 1.0 = alle optionalen Slots auf Maximum.
    /// Beide Werte im Bereich 0–1, DensityMin ≤ DensityMax.
    /// </summary>
    float               DensityMin     = 0f,
    float               DensityMax     = 1f,
    /// <summary>
    /// true  = Jeder Raum bekommt einen eigenen Zufallswert aus [DensityMin, DensityMax].
    /// false = Ein einziger Wert wird pro Aufruf gezogen und für alle Räume verwendet (Standard).
    /// </summary>
    bool                DensityPerRoom = false);

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
    private readonly IPathfinderService     _pathfinder;

    public FurnishingGeneratorService(IRoomTypeConfigService roomTypeSvc, ITileConfigService tileSvc, IPathfinderService pathfinder)
    {
        _roomTypeSvc = roomTypeSvc;
        _tileSvc     = tileSvc;
        _pathfinder  = pathfinder;
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

        // Möblierungsdichte: zufälliger Wert aus [DensityMin, DensityMax].
        // DensityPerRoom=false: ein einziger Wert für alle Räume – einheitliches Bild.
        // DensityPerRoom=true:  jeder Raum bekommt seinen eigenen Zufallswert.
        float dMin    = Math.Clamp(req.DensityMin, 0f, 1f);
        float dMax    = Math.Clamp(req.DensityMax, 0f, 1f);
        double DrawDensity() => dMin >= dMax ? dMin : dMin + rng.NextDouble() * (dMax - dMin);
        // Wenn Min≠Max oder DensityPerRoom aktiv → jeder Raum bekommt einen eigenen Zufallswert.
        bool perRoom  = req.DensityPerRoom || dMin < dMax;
        double density = DrawDensity();
        log.Add($"[DENSITY] range=[{dMin:P0}–{dMax:P0}] perRoom={perRoom} (flag={req.DensityPerRoom}) → initial={density:P0}");

        foreach (var sel in req.RoomSelections)
        {
            // Neuen Density-Wert pro Raum ziehen wenn Range variabel oder Toggle aktiv.
            if (perRoom)
                density = DrawDensity();

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

            // PathStyle: Pfad neu berechnen wenn er vom Standard "wall" abweicht.
            // Beim Upload werden Pfade mit "wall" vorberechnet; für andere Stile
            // (center, random) wird hier der passende Pfad für diesen Raum generiert.
            if (!string.IsNullOrEmpty(config.PathStyle)
                && !config.PathStyle.Equals("wall", StringComparison.OrdinalIgnoreCase))
            {
                _pathfinder.ComputeRoomPath(req.Building, sel.FloorIndex, sel.RoomIndex1Based, rng.Next(), config.PathStyle);
            }

            // 2. Room analysis
            var roomCells   = GetRoomCells(floor, sel.RoomIndex1Based);
            var roomSize    = RoomSize.Classify(roomCells.Count);
            var cellWalls   = ComputeWallDirections(roomCells);
            var doorCells   = GetEdgeCells(floor, roomCells, FloorObjectType.Door);
            var windowCells = GetEdgeCells(floor, roomCells, FloorObjectType.Window);
            var occupied         = new HashSet<(int, int)>();
            var softOccupied     = new HashSet<(int, int)>();
            var physicalOccupied = new HashSet<(int, int)>(); // nur Tiles mit HasCollision=true

            // Pfad-Zellen des Raums (aus PathsByRoom, falls vorhanden)
            var pathCells = floor.PathsByRoom.TryGetValue(sel.RoomIndex1Based, out var path)
                ? path.Select(p => (p[0], p[1])).ToHashSet()
                : new HashSet<(int, int)>();

            log.Add($"[ROOM] Floor {sel.FloorIndex} · '{room.Name}' → config '{configKey}', {roomCells.Count} cells, size {roomSize}, {pathCells.Count} path cells, density {density:P0}");

            // 3. Slot selection
            var slotsToPlace = SelectSlots(config, roomSize, rng, log, density);

            // 4. Place each slot
            var anchorMap  = new Dictionary<string, (int col, int row, int fpW, int fpH, string orient)>(StringComparer.OrdinalIgnoreCase);
            var colorMap   = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var variantMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            // Farbpalette pre-seeden: für jede Gruppe mit definierter Palette
            // wird JETZT eine zufällige Farbe festgelegt – vor dem ersten Slot.
            foreach (var (groupId, palette) in config.ColorPalettes)
            {
                var valid = palette.Where(c => !string.IsNullOrEmpty(c)).ToList();
                if (valid.Count > 0)
                {
                    colorMap[groupId] = valid[rng.Next(valid.Count)];
                    log.Add($"    [COLOR] group='{groupId}' pre-seeded to '{colorMap[groupId]}' ({valid.Count} choices)");
                }
            }

            foreach (var (slot, count) in slotsToPlace)
                for (int n = 0; n < count; n++)
                {
                    // Abhängigkeitsprüfung: requiresSlot = Slot oder SlotGroupId muss zuvor
                    // erfolgreich platziert worden sein (Eintrag in anchorMap).
                    if (!string.IsNullOrEmpty(slot.RequiresSlot)
                        && !anchorMap.ContainsKey(slot.RequiresSlot))
                    {
                        log.Add($"  [SKIP] '{slot.Id}': requiresSlot='{slot.RequiresSlot}' wurde nicht platziert");
                        continue;
                    }
                    PlaceSlot(slot, sel.FloorIndex, roomCells, cellWalls, doorCells, windowCells,
                        pathCells, occupied, softOccupied, physicalOccupied, allTiles, anchorMap, colorMap, variantMap, config, placements, log, rng, configKey);
                }
        }

        return new FurnishResult(placements, log);
    }

    // =========================================================================
    // Slot selection
    // =========================================================================

    private static List<(RoomTypeSlot slot, int count)> SelectSlots(
        RoomTypeConfig config, string roomSize, Random rng, List<string> log, double density = 1.0)
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
            if (totalW <= 0) totalW = variants.Count;
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

            int max = cnt.Max == -1 ? 99 : cnt.Max;

            // Required: immer mindestens 1, unabhängig von Density.
            // Optional: linear interpoliert zwischen Min und Max anhand der Density.
            //   density=0.0 → count=Min  (minimal möbliert)
            //   density=1.0 → count=Max  (maximal möbliert)
            int count;
            if (max <= 0)
            {
                count = 0;
            }
            else if (slot.Required)
            {
                // Required: immer mindestens 1, unabhängig von Density
                count = Math.Max(cnt.Min, 1);
            }
            else if (cnt.Min == 0 && max == 1)
            {
                // Einzelner optionaler Slot (0–1): Würfelwurf mit density als Wahrscheinlichkeit
                count = rng.NextDouble() < density ? 1 : 0;
            }
            else
            {
                // Multi-Slot (0–N oder M–N): linear zwischen Min und Max interpolieren
                // Bei density=1.0 exakt Max zurückgeben (Float-Rounding vermeiden)
                count = density >= 1.0
                    ? max
                    : (int)Math.Round(cnt.Min + density * (max - cnt.Min));
            }

            if (count <= 0) continue;

            result.Add((slot, count));
            log.Add($"  [SLOT] '{slot.Id}' ({slot.Label}): {count}× (min {cnt.Min}, max {max}, density {density:P0})");
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
        HashSet<(int, int)> softOccupied,
        HashSet<(int, int)> physicalOccupied,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        Dictionary<string, (int col, int row, int fpW, int fpH, string orient)> anchorMap,
        Dictionary<string, string> colorMap,
        Dictionary<string, string> variantMap,
        RoomTypeConfig config,
        List<PlacedFurnitureItem> placements, List<string> log, Random rng,
        string roomTypeName = "")
    {
        var candidates = FilterTiles(allTiles, slot, roomTypeName);
        if (candidates.Count == 0)
        {
            log.Add($"  [WARN] '{slot.Id}': no matching tiles " +
                    $"(layer='{slot.RequiredLayer}', cats=[{string.Join(",", slot.AllowedCategories.Keys)}], " +
                    $"props=[{string.Join(",", slot.RequiredProperties)}], roomType='{roomTypeName}', " +
                    $"fp={slot.Footprint.Width}×{slot.Footprint.Height}, canRotate={slot.Footprint.CanRotate})");
            return;
        }

        // ── Farbfilter ─────────────────────────────────────────────────────────
        // Effektive Gruppe: Slot überschreibt Raum-Default; "none" deaktiviert.
        var effectiveColorGroup = slot.ColorGroupId switch
        {
            "none"               => string.Empty,
            { Length: > 0 } cg  => cg,
            _                   => config.ColorGroupId,
        };
        if (!string.IsNullOrEmpty(effectiveColorGroup)
            && colorMap.TryGetValue(effectiveColorGroup, out var requiredColor)
            && !string.IsNullOrEmpty(requiredColor))
        {
            var colored = candidates
                .Where(t => t.Colors.Any(c => c.Equals(requiredColor, StringComparison.OrdinalIgnoreCase)))
                .ToList();
            if (colored.Count > 0)
            {
                candidates = colored;
                log.Add($"    [COLOR] '{slot.Id}': group='{effectiveColorGroup}' → filter '{requiredColor}' ({colored.Count}/{candidates.Count + colored.Count - colored.Count} tiles)");
            }
            // else: kein Match → ungefilterten Pool behalten (Slot wird nicht verworfen)
        }

        // ── TileGroup-Filter ───────────────────────────────────────────────────
        // Erzwingt gleichen VariantGroup-Wert für alle Slots mit derselben TileGroupId.
        if (!string.IsNullOrEmpty(slot.TileGroupId)
            && variantMap.TryGetValue(slot.TileGroupId, out var requiredVariantGroup)
            && !string.IsNullOrEmpty(requiredVariantGroup))
        {
            var grouped = candidates
                .Where(t => t.VariantGroup.Equals(requiredVariantGroup, StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (grouped.Count > 0)
            {
                candidates = grouped;
                log.Add($"    [TILEGROUP] '{slot.Id}': group='{slot.TileGroupId}' → filter variantGroup='{requiredVariantGroup}' ({grouped.Count} tiles)");
            }
            // else: kein Match → ungefilterten Pool behalten
        }

        // Resolve anchor rule
        (int col, int row, int fpW, int fpH, string orient)? anchorInfo = null;
        string? anchorPos        = null;
        string? anchorOrientRule = null;   // "match" | "opposite" | "facingAnchor" | "N/S/E/W" | null
        int     anchorOffset     = 0;      // offsetAlongAnchor für LongSide/ShortSide
        // Kumulative Ablehnungszähler für [WARN]-Log (nur im else-Zweig gefüllt, sonst 0)
        int totalNoVariant = 0, totalNoFit = 0, totalNoWallDir = 0, totalFits = 0, totalPath = 0, totalLoot = 0;
        int totalDoor = 0, totalWindow = 0, totalConnectivity = 0;
        if (slot.AnchorRules?.Count > 0)
        {
            foreach (var rule in slot.AnchorRules)
                if (!string.IsNullOrEmpty(rule.AnchorTarget) && anchorMap.TryGetValue(rule.AnchorTarget, out var ap))
                {
                    anchorInfo       = ap;
                    anchorPos        = rule.Positions.Count > 0 ? rule.Positions[rng.Next(rule.Positions.Count)] : null;
                    anchorOrientRule = rule.Orient;
                    anchorOffset     = rule.OffsetAlongAnchor;
                    break;
                }
        }

        var tile = SelectTile(candidates, slot, rng);
        if (tile is null) return;

        (int col, int row, string orient, TileDefinition placedTile, int rejNoVariant, int rejNoFit, int rejDoor, int rejWindow, int rejConnectivity)? result;
        if (anchorInfo.HasValue && anchorPos != null)
        {
            // 1. Ziel-Orientierung berechnen. Bei openSideFacing wird die Orientierung
            //    aus der tatsaechlich gewaehlten openSidePlacement-Seite abgeleitet.
            string ResolveAnchoredOrient(char? chosenOpenSide = null) => anchorOrientRule switch
            {
                "match"            => anchorInfo.Value.orient,
                "opposite"         => anchorInfo.Value.orient switch
                                      { "N" => "S", "S" => "N", "E" => "W", "W" => "E", _ => tile.Orientation },
                // Im Uhrzeigersinn senkrecht: S→E, E→N, N→W, W→S
                // Nützlich für Wände in Ecken: Dusche an N-Wand (orient S) → Eckwand orient E
                "cwPerpendicular"  => anchorInfo.Value.orient switch
                                      { "S" => "E", "E" => "N", "N" => "W", "W" => "S", _ => tile.Orientation },
                // Gegen den Uhrzeigersinn senkrecht: S→W, W→N, N→E, E→S
                "ccwPerpendicular" => anchorInfo.Value.orient switch
                                      { "S" => "W", "W" => "N", "N" => "E", "E" => "S", _ => tile.Orientation },
                // Leitet die Orientierung aus der tatsächlich gewählten openSide ab.
                // Mapping Side->Orient:
                //   W->S, E->N, N->E, S->W
                "openSideFacing"   => chosenOpenSide switch
                                      {
                                          // Side = gewaehlte Wandkante, Orient = Blickrichtung vom Rand in den Raum.
                                          'N' => "S",
                                          'S' => "N",
                                          'E' => "W",
                                          'W' => "E",
                                          _   => tile.Orientation,
                                      },
                "facingAnchor"     => ResolveFacingAnchorOrient(anchorPos, anchorInfo.Value.fpW, anchorInfo.Value.fpH) ?? tile.Orientation,
                "N" or "S" or "E" or "W" => anchorOrientRule,
                _                  => tile.Orientation,
            };

            TileDefinition ResolveFinalTile(string desiredOrient)
            {
                if (string.IsNullOrEmpty(tile.VariantGroup)) return tile;
                var match = allTiles.Values.FirstOrDefault(t =>
                    t.VariantGroup.Equals(tile.VariantGroup, StringComparison.OrdinalIgnoreCase) &&
                    t.Orientation.Equals(desiredOrient, StringComparison.OrdinalIgnoreCase));
                return match ?? tile;
            }

            result = null;
            bool TryAnchorPosition(int ac, int ar, string anchoredOrient, TileDefinition finalTile, int fpW, int fpH, char? chosenOpenSide = null)
            {
                // requiresSlot-Slots ignorieren softOccupied bewusst:
                // Sie dürfen auf dem Ankermöbel (z.B. Nachttisch mit softBlocks=true) platziert werden.
                bool fitOk  = FitsFootprint(ac, ar, fpW, fpH, roomCells, occupied);  // kein softOccupied!
                bool doorOk = slot.PlacementRules.NearDoor
                              || !FootprintTouchesCells(ac, ar, fpW, fpH, doorCells);
                bool pathOk = slot.PlacementRules.AllowOnPath
                              || !finalTile.HasCollision
                              || pathCells.Count == 0
                              || !FootprintTouchesCells(ac, ar, fpW, fpH, pathCells);
                bool winOk  = slot.PlacementRules.NearWindow
                              || !ViolatesWindowPlacement(ac, ar, fpW, fpH, finalTile, anchoredOrient, windowCells);
                bool anchorValid = fitOk && doorOk && pathOk && winOk;

                if (anchorValid)
                {
                    result = (ac, ar, anchoredOrient, finalTile, 0, 0, 0, 0, 0);
                    return true;
                }

                var sideSuffix = chosenOpenSide.HasValue ? $" side='{chosenOpenSide.Value}'" : string.Empty;
                log.Add($"    [ANCHOR-FAIL] '{slot.Id}': pos=({ac},{ar}){sideSuffix} fit={fitOk} door={doorOk} path={pathOk} window={winOk}");
                return false;
            }

            if (anchorPos.Equals("openSidePlacement", StringComparison.OrdinalIgnoreCase))
            {
                foreach (var side in ComputeOpenSideOrder(anchorInfo.Value.orient))
                {
                    var anchoredOrient = ResolveAnchoredOrient(side);
                    var finalTile = ResolveFinalTile(anchoredOrient);
                    int fpW = finalTile.TileLayout.Count > 0 ? (finalTile.TileLayout[0]?.Count ?? 1) : 1;
                    int fpH = finalTile.TileLayout.Count;
                    var pos = ComputeOpenSidePosition(anchorInfo.Value.col, anchorInfo.Value.row,
                        anchorInfo.Value.fpW, anchorInfo.Value.fpH, fpW, fpH, side);

                    log.Add($"    [ANCHOR] '{slot.Id}': anchorOrientRule='{anchorOrientRule ?? "null"}' anchorPos='openSidePlacement' side='{side}' -> anchoredOrient='{anchoredOrient}'");
                    if (TryAnchorPosition(pos.col, pos.row, anchoredOrient, finalTile, fpW, fpH, side))
                        break;
                }
                if (result is null)
                    log.Add($"    [ANCHOR-FAIL] '{slot.Id}': openSidePlacement found no valid side for orient='{anchorInfo.Value.orient}'");
            }
            else
            {
                var anchoredOrient = ResolveAnchoredOrient();
                log.Add($"    [ANCHOR] '{slot.Id}': anchorOrientRule='{anchorOrientRule ?? "null"}' anchorFpW={anchorInfo.Value.fpW} anchorFpH={anchorInfo.Value.fpH} -> anchoredOrient='{anchoredOrient}'");
                var finalTile = ResolveFinalTile(anchoredOrient);
                int fpW = finalTile.TileLayout.Count > 0 ? (finalTile.TileLayout[0]?.Count ?? 1) : 1;
                int fpH = finalTile.TileLayout.Count;
                var p = ComputeAnchoredPosition(anchorInfo.Value.col, anchorInfo.Value.row,
                    anchorInfo.Value.fpW, anchorInfo.Value.fpH, fpW, fpH, anchorPos, anchorInfo.Value.orient, anchorOffset);

                if (p.HasValue)
                {
                    var (ac, ar) = p.Value;
                    TryAnchorPosition(ac, ar, anchoredOrient, finalTile, fpW, fpH);
                }
                else
                {
                    log.Add($"    [ANCHOR-FAIL] '{slot.Id}': ComputeAnchoredPosition returned null for anchorPos='{anchorPos}'");
                }
            }
        }
        else
        {
            // Primary placement attempt
            result = FindFreeCell(slot, roomCells, cellWalls, doorCells, windowCells,
                pathCells, occupied, softOccupied, physicalOccupied, tile, allTiles, slot.PlacementRules, rng, log,
                out var primaryRej);
            totalNoVariant = primaryRej.noVariant;
            totalNoWallDir = primaryRej.noWallDir; totalFits = primaryRej.noFits;
            totalPath = primaryRej.noPath; totalLoot = primaryRej.noLoot;
            totalNoFit = totalNoWallDir + totalFits + totalPath + totalLoot;
            totalDoor = primaryRej.door; totalWindow = primaryRej.window; totalConnectivity = primaryRej.connectivity;

            // Fallback chain: iterate FallbackRules in order if primary failed
            if (result is null && slot.FallbackRules?.Count > 0)
            {
                for (int fb = 0; fb < slot.FallbackRules.Count && result is null; fb++)
                {
                    var fbRules = slot.FallbackRules[fb];
                    result = FindFreeCell(slot, roomCells, cellWalls, doorCells, windowCells,
                        pathCells, occupied, softOccupied, physicalOccupied, tile, allTiles, fbRules, rng, log,
                        out var fbRej);
                    totalNoVariant += fbRej.noVariant;
                    totalNoWallDir += fbRej.noWallDir; totalFits += fbRej.noFits;
                    totalPath += fbRej.noPath; totalLoot += fbRej.noLoot;
                    totalNoFit = totalNoWallDir + totalFits + totalPath + totalLoot;
                    totalDoor += fbRej.door; totalWindow += fbRej.window; totalConnectivity += fbRej.connectivity;
                    if (result != null)
                        log.Add($"    [FALLBACK {fb + 1}] '{slot.Id}': used fallback rule #{fb + 1}");
                }
            }
        }

        if (result is null)
        {
            int tileFpW   = tile.TileLayout.Count > 0 ? (tile.TileLayout[0]?.Count ?? 1) : 1;
            int tileFpH   = tile.TileLayout.Count;
            int wallCells = cellWalls.Count;
            int freeWall  = roomCells.Count(c => cellWalls.ContainsKey(c) && !occupied.Contains(c));
            int freeCells = roomCells.Count(c => !occupied.Contains(c));
            log.Add($"  [WARN] '{slot.Id}': no valid position for '{tile.TileId}' " +
                    $"orient='{tile.Orientation}' fp={tileFpW}×{tileFpH} variantGroup='{tile.VariantGroup}' | " +
                    $"roomCells={roomCells.Count} free={freeCells} wallCells={wallCells} freeWall={freeWall} " +
                    $"nearWall={slot.PlacementRules.NearWall} wallAlignment='{slot.PlacementRules.WallAlignment}' " +
                    $"candidates={candidates.Count} | " +
                    $"rejNoVariant={totalNoVariant} rejNoFit={totalNoFit}" +
                    $"(wallDir={totalNoWallDir} fits={totalFits} path={totalPath} loot={totalLoot}) " +
                    $"rejDoor={totalDoor} rejWindow={totalWindow} rejConnectivity={totalConnectivity}");
            return;
        }

        var (col, row, orient, placedTile, rej1, rej2, rej3, rej4, rej5) = result.Value;
        log.Add($"    [DEBUG] '{slot.Id}': pool tried, rejNoVariant={rej1} rejNoFit={rej2} rejDoor={rej3} rejWindow={rej4} rejConnectivity={rej5}");
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
                if (slot.BlocksPlacement)
                    occupied.Add((col + c, row + r));
                else if (slot.SoftBlocks)
                    softOccupied.Add((col + c, row + r));
                // Physikalische Belegung: unabhängig von BlocksPlacement, nur nach HasCollision
                if (placedTile.HasCollision)
                    physicalOccupied.Add((col + c, row + r));
            }
        }

        if (!string.IsNullOrEmpty(slot.Id))          anchorMap[slot.Id]          = (col, row, finalFpW, finalFpH, orient);
        if (!string.IsNullOrEmpty(slot.SlotGroupId))  anchorMap.TryAdd(slot.SlotGroupId, (col, row, finalFpW, finalFpH, orient));

        // Farbe der Gruppe festlegen beim ersten Slot der Gruppe
        if (!string.IsNullOrEmpty(effectiveColorGroup) && !colorMap.ContainsKey(effectiveColorGroup))
        {
            var firstColor = placedTile.Colors.FirstOrDefault(c => !string.IsNullOrEmpty(c));
            if (!string.IsNullOrEmpty(firstColor))
            {
                colorMap[effectiveColorGroup] = firstColor;
                log.Add($"    [COLOR] '{slot.Id}': group='{effectiveColorGroup}' locked to '{firstColor}'");
            }
        }

        // VariantGroup der TileGroup beim ersten Slot einfrieren
        if (!string.IsNullOrEmpty(slot.TileGroupId) && !variantMap.ContainsKey(slot.TileGroupId))
        {
            if (!string.IsNullOrEmpty(placedTile.VariantGroup))
            {
                variantMap[slot.TileGroupId] = placedTile.VariantGroup;
                log.Add($"    [TILEGROUP] '{slot.Id}': group='{slot.TileGroupId}' locked to variantGroup='{placedTile.VariantGroup}'");
            }
        }

        log.Add($"  [PLACED] '{slot.Id}': '{placedTile.TileId}' orient '{orient}' at ({col},{row})");
    }

    // =========================================================================
    // Tile filtering & selection
    // =========================================================================

    private static List<TileDefinition> FilterTiles(
        IReadOnlyDictionary<string, TileDefinition> allTiles, RoomTypeSlot slot,
        string roomTypeName = "")
    {
        int fpW = slot.Footprint.Width;
        int fpH = slot.Footprint.Height;

        // Vorberechnen: Welche VariantGroups haben mind. eine Variante die zum Footprint passt?
        // Dadurch werden alle Orientierungsvarianten einer Gruppe in den Pool aufgenommen –
        // ResolveVariantForCell wählt danach die korrekte Orientierung.
        var validGroups = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var t in allTiles.Values)
        {
            if (string.IsNullOrEmpty(t.VariantGroup)) continue;
            int tW = t.TileLayout.Count > 0 ? (t.TileLayout[0]?.Count ?? 1) : 1;
            int tH = t.TileLayout.Count;
            if ((tW == fpW && tH == fpH) || (slot.Footprint.CanRotate && tW == fpH && tH == fpW))
                validGroups.Add(t.VariantGroup);
        }

        var all = allTiles.Values
            .Where(t => string.IsNullOrEmpty(slot.RequiredLayer)
                     || t.Layer.Equals(slot.RequiredLayer, StringComparison.OrdinalIgnoreCase))
            .Where(t => slot.AllowedCategories.Count == 0 || slot.AllowedCategories.ContainsKey(t.Group))
            .Where(t => slot.RequiredProperties.All(p => GetBoolProperty(t, p)))
            .Where(t => t.RoomTypes.Count == 0
                     || string.IsNullOrEmpty(roomTypeName)
                     || t.RoomTypes.Any(rt => rt.Equals(roomTypeName, StringComparison.OrdinalIgnoreCase)))
            // Footprint-Filter:
            //   Tiles ohne VariantGroup → exakter Größencheck (oder gedreht wenn CanRotate).
            //   Tiles mit VariantGroup → Gruppe erlaubt wenn mind. eine Variante passt.
            .Where(t =>
            {
                int tW = t.TileLayout.Count > 0 ? (t.TileLayout[0]?.Count ?? 1) : 1;
                int tH = t.TileLayout.Count;
                bool exact     = tW == fpW && tH == fpH;
                bool rotated   = slot.Footprint.CanRotate && tW == fpH && tH == fpW;
                bool groupFits = !string.IsNullOrEmpty(t.VariantGroup) && validGroups.Contains(t.VariantGroup);
                return exact || rotated || groupFits;
            });

        // Deduplizierung: Pro VariantGroup nur einen Vertreter behalten.
        var seen   = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<TileDefinition>();
        foreach (var t in all)
        {
            if (string.IsNullOrEmpty(t.VariantGroup))
                result.Add(t);
            else if (seen.Add(t.VariantGroup))
                result.Add(t);
        }
        return result;
    }

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

    private static (int col, int row, string orient, TileDefinition tile, int rejNoVariant, int rejNoFit, int rejDoor, int rejWindow, int rejConnectivity)? FindFreeCell(
        RoomTypeSlot slot,
        HashSet<(int, int)> roomCells,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        HashSet<(int, int)> doorCells, HashSet<(int, int)> windowCells,
        HashSet<(int, int)> pathCells,
        HashSet<(int, int)> occupied,
        HashSet<(int, int)> softOccupied,
        HashSet<(int, int)> physicalOccupied,
        TileDefinition baseTile,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        PlacementRules rules,
        Random rng,
        List<string>? debugLog,
        out (int noVariant, int noWallDir, int noFits, int noPath, int noLoot, int door, int window, int connectivity) rejCounters)
    {
        bool traceBathtub = slot.Id.Equals("slot_bathtub", StringComparison.OrdinalIgnoreCase);
        IEnumerable<(int col, int row)> pool = roomCells;

        if (rules.NearWall)
        {
            // NearWall: Nur echte Wandzellen (Zellen mit mindestens einer Wand-Richtung) in den Pool.
            // Hintergrund: ComputeWallAnchor erwartet die Wandzelle als Eingabe und verschiebt
            // den Footprint-Anker so, dass das Möbel in den Raum hinein expandiert.
            // Interior-Zellen (keine eigenen Wandeinträge) würden von ComputeWallAnchor falsch
            // versetzt, da sie nicht die Rückseite des Möbels repräsentieren.
            // Mehrzelliges Mobiliar (z.B. 2×2-Bett) wird korrekt abgedeckt: die aktuelle
            // Wandzelle (z.B. (3,11) S-Wand) liefert via ComputeWallAnchor(S,2,2) den Anker
            // (3,10), so dass der Footprint (3,10)–(4,11) die Wand berührt.
            pool = pool.Where(c => cellWalls.ContainsKey(c));
        }
        if (rules.NearDoor)   pool = pool.Where(c => doorCells.Contains(c));
        if (rules.NearWindow) pool = pool.Where(c => windowCells.Contains(c));
        if (rules.CornerOnly) pool = pool.Where(c => cellWalls.TryGetValue(c, out var w) && w.Count >= 2);

        // Pfad-Schutz: Möbel mit Kollision dürfen nicht auf Laufwegen stehen,
        // außer der Slot erlaubt es explizit (AllowOnPath = true).
        if (!rules.AllowOnPath && baseTile.HasCollision && pathCells.Count > 0)
            pool = pool.Where(c => !pathCells.Contains(c));

        var poolList = pool.Distinct().ToList();

        if (rules.CenterRoom)
        {
            // Abstand zur Raummitte aufsteigend sortieren + kleinen Jitter für Varianz.
            // KEIN vollständiger Shuffle – sonst wird die Sortierung zunichte gemacht.
            float cx = roomCells.Average(c => (float)c.Item1);
            float cy = roomCells.Average(c => (float)c.Item2);
            poolList = poolList
                .OrderBy(c => Math.Abs(c.Item1 - cx) + Math.Abs(c.Item2 - cy) + rng.NextDouble() * 0.9)
                .ToList();
        }
        else
        {
            // Shuffle for randomness
            for (int i = poolList.Count - 1; i > 0; i--)
            { int j = rng.Next(i + 1); (poolList[i], poolList[j]) = (poolList[j], poolList[i]); }
        }

        int rejNoVariant = 0, rejNoWallDir = 0, rejFits = 0, rejPath = 0, rejLoot = 0, rejDoor = 0, rejWindow = 0, rejConnectivity = 0;
        foreach (var cell in poolList)
        {
            var variants = ResolveVariantsForCell(baseTile, cell, cellWalls, allTiles, rules, slot.Required);
            if (variants.Count == 0) { rejNoVariant++; continue; }

            for (int variantIndex = 0; variantIndex < variants.Count; variantIndex++)
            {
                var (resolvedTile, orient, wallDir) = variants[variantIndex];
                int fpW = resolvedTile.TileLayout.Count > 0 ? (resolvedTile.TileLayout[0]?.Count ?? 1) : 1;
                int fpH = resolvedTile.TileLayout.Count;

                // Bei NearWall: Wandzelle = Rückseite des Möbels.
                // ComputeWallAnchor verschiebt den Footprint-Anker so dass das Möbel
                // in den Raum hinein expandiert (statt über die Wand hinaus).
                // Ohne NearWall: Ankerzelle = cell, kein Offset nötig.
                var (anchorCol, anchorRow) = rules.NearWall
                    ? ComputeWallAnchor(cell, wallDir, fpW, fpH)
                    : (cell.col, cell.row);

                // Wandnähe-Validierung nach Anchor-Verschiebung:
                // Der erweiterte Pool-Filter nimmt auch innenliegende Zellen auf, deren Footprint
                // (vom Slot-Footprint aus) eine Wand berührt. Nach Variantenauflösung und
                // ComputeWallAnchor kann der tatsächliche Footprint aber keinen Wandkontakt mehr haben
                // (andere Größe/Orientierung). Solche Positionen ablehnen.
                // Wichtig: Prüfung gegen die KONKRETE wallDir, nicht nur irgendeine Wand –
                // verhindert z.B. dass ein 2×1-Schrank bei einer Interior-Zelle nahe der S-Wand
                // durch die E-Wand fälschlicherweise validated wird (Bug: Schrank in Raummitte).
                if (rules.NearWall && !FootprintTouchesWallDir(anchorCol, anchorRow, fpW, fpH, cellWalls, wallDir))
                { rejNoWallDir++; continue; }

                if (!FitsFootprint(anchorCol, anchorRow, fpW, fpH, roomCells, occupied, softOccupied))
                {
                    rejFits++;
                    if (traceBathtub && debugLog is not null)
                        debugLog.Add($"    [TRACE] '{slot.Id}': reject FITS cell=({cell.col},{cell.row}) anchor=({anchorCol},{anchorRow}) orient='{orient}' fp={fpW}x{fpH}");
                    continue;
                }

                // Pfad-Schutz auf Footprint-Ebene: Der Pool-Filter oben prüft nur die Ankerzelle.
                // Nach ComputeWallAnchor kann der verschobene Anker Pfadzellen überdecken
                // (z.B. cell=(4,4), wallDir=S, anchor=(4,3) = Pfadzelle).
                if (!rules.AllowOnPath && resolvedTile.HasCollision && pathCells.Count > 0
                    && FootprintTouchesCells(anchorCol, anchorRow, fpW, fpH, pathCells)) { rejPath++; continue; }

                // Türbereich freilassen: kein Möbel-Footprint darf eine Türzelle überdecken,
                // außer der Slot ist explizit NearDoor (z.B. Garderobenhalter an der Tür).
                if (!rules.NearDoor && FootprintTouchesCells(anchorCol, anchorRow, fpW, fpH, doorCells)) { rejDoor++; continue; }

                // Fensterschutz:
                // - Standard: IsHigh darf keine Fensterzellen berühren.
                // - Mit WindowBlockedEdge: nur diese Kante ist gesperrt (z.B. Armaturseite).
                if (!rules.NearWindow
                    && ViolatesWindowPlacement(anchorCol, anchorRow, fpW, fpH, resolvedTile, orient, windowCells))
                { rejWindow++; continue; }

                // Loot-Erreichbarkeit: Jede Zelle des Footprints muss von mindestens einer
                // freien Nachbarzelle aus erreichbar sein (Moore-Nachbarschaft, Reichweite 1).
                // Verhindert dass Spieler nach Platzierung keinen Zugriff mehr auf den Container hat.
                if (resolvedTile.IsLootContainer
                    && !LootContainerReachable(anchorCol, anchorRow, fpW, fpH, roomCells, physicalOccupied))
                { rejLoot++; continue; }

                // Raumzusammenhang: Nach Platzierung müssen alle begehbaren Raumzellen noch
                // zusammenhängend erreichbar sein (8-Nachbarschaft, da PZ diagonales Gehen erlaubt).
                // Verhindert dass Möbel mit Kollision Raumbereiche von der Tür abschneiden –
                // z.B. ein Bett das eine Ecke in einem nicht-rechteckigen Raum isoliert.
                if (resolvedTile.HasCollision
                    && !RoomRemainsConnected(anchorCol, anchorRow, fpW, fpH, roomCells, physicalOccupied, doorCells))
                {
                    rejConnectivity++;
                    if (traceBathtub && debugLog is not null)
                        debugLog.Add($"    [TRACE] '{slot.Id}': reject CONNECTIVITY cell=({cell.col},{cell.row}) anchor=({anchorCol},{anchorRow}) orient='{orient}' fp={fpW}x{fpH}");
                    continue;
                }

                if (traceBathtub && debugLog is not null)
                    debugLog.Add($"    [TRACE] '{slot.Id}': accept cell=({cell.col},{cell.row}) anchor=({anchorCol},{anchorRow}) orient='{orient}' fp={fpW}x{fpH}");

                if (slot.Required && rules.NearWall && variantIndex > 0 && debugLog is not null)
                    debugLog.Add($"    [TRACE] '{slot.Id}': required-fallback orientation='{orient}' used at cell=({cell.col},{cell.row}) (variant {variantIndex + 1}/{variants.Count})");

                rejCounters = (rejNoVariant, rejNoWallDir, rejFits, rejPath, rejLoot, rejDoor, rejWindow, rejConnectivity);
                int noFitSum = rejNoWallDir + rejFits + rejPath + rejLoot;
                return (anchorCol, anchorRow, orient, resolvedTile, rejNoVariant, noFitSum, rejDoor, rejWindow, rejConnectivity);
            }
        }

        rejCounters = (rejNoVariant, rejNoWallDir, rejFits, rejPath, rejLoot, rejDoor, rejWindow, rejConnectivity);
        return null;
    }

    /// <summary>
    /// Bestimmt für eine konkrete Wandzelle die korrekte Tile-Variante, Orientierung und Wandrichtung.
    /// Gibt null zurück wenn keine passende Orientierungsvariante gefunden wurde –
    /// die Zelle wird dann von FindFreeCell übersprungen.
    /// </summary>
    private static Direction? ResolveWallDirForCell(
        TileDefinition baseTile,
        (int col, int row) cell,
        Dictionary<(int, int), HashSet<Direction>> cellWalls)
    {
        // Wandrichtung bestimmen: an der Ankerzelle selbst.
        // Mit dem bereinigten Pool-Filter kommen nur echte Wandzellen (cellWalls-Einträge)
        // in den Pool; die Fallback-Logik via FootprintWallDirs ist daher Schutzcode
        // für den Fall, dass ein nicht-Wandzellen-Eintrag doch hier ankommt.
        HashSet<Direction>? wallDirs;
        if (!cellWalls.TryGetValue(cell, out wallDirs) || wallDirs.Count == 0)
        {
            // Sicherheitsnetz: Footprint-Wände prüfen (sollte mit korrektem Pool nicht nötig sein)
            int fpW = baseTile.TileLayout.Count > 0 ? (baseTile.TileLayout[0]?.Count ?? 1) : 1;
            int fpH = baseTile.TileLayout.Count;
            wallDirs = FootprintWallDirs(cell.col, cell.row, fpW, fpH, cellWalls);
            if (wallDirs.Count == 0)
                return null; // Keine Wandrichtung bestimmbar
        }

        // Wandrichtung bestimmen: bevorzugt die, die zum Rücken des BaseTile passt
        var backExpected = BackWall(baseTile.Orientation);
        return (backExpected.HasValue && wallDirs.Contains(backExpected.Value))
            ? backExpected.Value
            : wallDirs.OrderByDescending(d => d).First();
    }

    private static (TileDefinition tile, string orient, Direction wallDir)? ResolveVariantForCell(
        TileDefinition baseTile,
        (int col, int row) cell,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        PlacementRules rules)
    {
        // Ohne NearWall: Tile unverändert zurückgeben (wallDir arbiträr, wird nicht verwendet)
        // aber AllowedOrients-Prüfung immer durchführen
        if (!rules.NearWall)
        {
            if (baseTile.AllowedOrients.Count > 0
                && !baseTile.AllowedOrients.Any(o => o.Equals(baseTile.Orientation, StringComparison.OrdinalIgnoreCase)))
                return null;
            return (baseTile, baseTile.Orientation, Direction.N);
        }

        var wallDirOpt = ResolveWallDirForCell(baseTile, cell, cellWalls);
        if (!wallDirOpt.HasValue) return null;
        var wallDir = wallDirOpt.Value;

        // Vorderseite zeigt in den Raum
        string neededOrient = WallToOrient(wallDir) ?? baseTile.Orientation;

        // Wenn das Tile erlaubte Orientierungen hat, prüfen ob neededOrient erlaubt ist
        if (baseTile.AllowedOrients.Count > 0
            && !baseTile.AllowedOrients.Any(o => o.Equals(neededOrient, StringComparison.OrdinalIgnoreCase)))
            return null; // neededOrient ist für dieses Tile nicht erlaubt → Zelle ablehnen

        // Prüfe ob baseTile selbst schon passt (richtiger Orient + passendes Aspektverhältnis)
        if (baseTile.Orientation.Equals(neededOrient, StringComparison.OrdinalIgnoreCase)
            && MatchesAlignment(baseTile, wallDir, rules.WallAlignment))
            return (baseTile, neededOrient, wallDir);

        // Suche in VariantGroup nach passender Variante
        if (!string.IsNullOrEmpty(baseTile.VariantGroup))
        {
            var variants = allTiles.Values
                .Where(t => t.VariantGroup == baseTile.VariantGroup
                         && t.Orientation.Equals(neededOrient, StringComparison.OrdinalIgnoreCase))
                .ToList();

            if (variants.Count > 0)
            {
                // Nur eine Variante zurückgeben, die WallAlignment erfüllt.
                // Kein Fallback auf variants[0] – das würde die Alignment-Prüfung aushebeln
                // (z.B. 1×2-Schrank an Nordwand trotz wallAlignment='parallel').
                var best = variants.FirstOrDefault(t => MatchesAlignment(t, wallDir, rules.WallAlignment));
                if (best is null) return null;
                return (best, neededOrient, wallDir);
            }
        }

        // Keine passende Variante gefunden → Zelle ablehnen
        return null;
    }

    private static List<(TileDefinition tile, string orient, Direction wallDir)> ResolveVariantsForCell(
        TileDefinition baseTile,
        (int col, int row) cell,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        PlacementRules rules,
        bool requiredSlot)
    {
        if (rules.NearWall)
        {
            var one = ResolveVariantForCell(baseTile, cell, cellWalls, allTiles, rules);
            if (!requiredSlot)
                return one.HasValue ? [one.Value] : [];

            var ordered = new List<(TileDefinition tile, string orient, Direction wallDir)>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            var wallDirOpt = ResolveWallDirForCell(baseTile, cell, cellWalls);
            if (!wallDirOpt.HasValue) return one.HasValue ? [one.Value] : [];
            var wallDir = wallDirOpt.Value;

            if (string.IsNullOrEmpty(baseTile.VariantGroup))
                return one.HasValue ? [one.Value] : [];

            var groupVariants = allTiles.Values
                .Where(t => t.VariantGroup.Equals(baseTile.VariantGroup, StringComparison.OrdinalIgnoreCase))
                .ToList();

            var cellWallDirs = cellWalls.TryGetValue(cell, out var dirsAtCell) ? dirsAtCell : new HashSet<Direction>();

            bool AllowedByOwnOrient(TileDefinition t) => t.AllowedOrients.Count == 0
                || t.AllowedOrients.Any(o => o.Equals(t.Orientation, StringComparison.OrdinalIgnoreCase));

            bool BackOnCellWall(TileDefinition t)
            {
                var back = BackWall(t.Orientation);
                return back.HasValue && cellWallDirs.Contains(back.Value);
            }

            Direction CandidateWallDir(TileDefinition t)
            {
                var back = BackWall(t.Orientation);
                // Immer die Rücken-Wandrichtung des Tiles verwenden.
                // Caller stellt sicher dass BackOnCellWall=true ist.
                return back.HasValue ? back.Value : wallDir;
            }

            // 1) Präferenz: Rücken liegt auf einer echten Wand der Kandidatenzelle + Alignment passt.
            var strict = groupVariants
                .Where(t => AllowedByOwnOrient(t)
                            && BackOnCellWall(t)
                            && MatchesAlignment(t, CandidateWallDir(t), rules.WallAlignment))
                .OrderBy(t => 0)
                .ThenBy(t => t.Orientation.Equals(baseTile.Orientation, StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                .ToList();

            foreach (var t in strict)
                if (seen.Add(t.TileId))
                    ordered.Add((t, t.Orientation, CandidateWallDir(t)));

            // 2) Last-resort: Rücken an echter Wand MUSS erhalten bleiben, nur WallAlignment relaxen.
            //    Varianten ohne Wandkontakt (z.B. Dusche in SE-Ecke ohne N/W-Wand) werden
            //    NICHT aufgenommen – physisch falsches Möbel vermeiden.
            var relaxed = groupVariants
                .Where(t => AllowedByOwnOrient(t) && BackOnCellWall(t))
                .OrderBy(t => 0)
                .ThenBy(t => t.Orientation.Equals(baseTile.Orientation, StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                .ToList();

            foreach (var t in relaxed)
                if (seen.Add(t.TileId))
                    ordered.Add((t, t.Orientation, CandidateWallDir(t)));

            return ordered;
        }

        // Ohne NearWall: Für rotierbare VariantGroups alle Orientierungsvarianten prüfen,
        // damit 1×2/2×1-Slots (z.B. Badewanne in Ecken) nicht an einer Zufallsvariante hängen.
        if (string.IsNullOrEmpty(baseTile.VariantGroup))
            return [(baseTile, baseTile.Orientation, Direction.N)];

        var variants = allTiles.Values
            .Where(t => t.VariantGroup.Equals(baseTile.VariantGroup, StringComparison.OrdinalIgnoreCase))
            .Where(t => t.AllowedOrients.Count == 0
                     || t.AllowedOrients.Any(o => o.Equals(t.Orientation, StringComparison.OrdinalIgnoreCase)))
            .OrderBy(t => t.Orientation.Equals(baseTile.Orientation, StringComparison.OrdinalIgnoreCase) ? 0 : 1)
            .Select(t => (t, t.Orientation, Direction.N))
            .ToList();

        if (variants.Count > 0) return variants;

        // Fallback: Alle Varianten der Gruppe durch AllowedOrients rausgefiltert
        // (z.B. orientation="E" aber allowedOrients=["W"]).
        // baseTile nur zurückgeben wenn seine eigene Orientation durch AllowedOrients erlaubt ist –
        // verhindert dass ein widersprüchlich konfiguriertes Tile ungefiltert landet.
        if (baseTile.AllowedOrients.Count == 0
            || baseTile.AllowedOrients.Any(o => o.Equals(baseTile.Orientation, StringComparison.OrdinalIgnoreCase)))
            return [(baseTile, baseTile.Orientation, Direction.N)];

        return [];
    }

    /// <summary>
    /// Berechnet die linke obere Ecke des Footprints aus einer Wandzelle und der Wandrichtung.
    /// Die Wandzelle ist die Rückseite des Möbels; der Footprint expandiert in den Raum hinein.
    ///   N-Wand (oben):  Möbel expandiert nach unten  → Anker = Wandzelle
    ///   S-Wand (unten): Möbel expandiert nach oben   → Anker.row = wallCell.row - fpH + 1
    ///   W-Wand (links): Möbel expandiert nach rechts → Anker = Wandzelle
    ///   E-Wand (rechts):Möbel expandiert nach links  → Anker.col = wallCell.col - fpW + 1
    /// </summary>
    private static (int col, int row) ComputeWallAnchor(
        (int col, int row) wallCell, Direction wallDir, int fpW, int fpH) => wallDir switch
    {
        Direction.N => (wallCell.col,           wallCell.row),
        Direction.S => (wallCell.col,           wallCell.row - fpH + 1),
        Direction.W => (wallCell.col,           wallCell.row),
        Direction.E => (wallCell.col - fpW + 1, wallCell.row),
        _           => wallCell,
    };

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

    /// <param name="softOccupied">
    /// Optionale soft-belegte Zellen (blocksPlacement:false, softBlocks:true).
    /// Normale Slots respektieren diese Zellen und landen nicht darauf.
    /// requiresSlot-Slots übergeben hier null – sie dürfen bewusst auf softOccupied-Zellen landen.
    /// </param>
    private static bool FitsFootprint(int col, int row, int fpW, int fpH,
        HashSet<(int, int)> roomCells, HashSet<(int, int)> occupied,
        HashSet<(int, int)>? softOccupied = null)
    {
        for (int r = 0; r < fpH; r++)
            for (int c = 0; c < fpW; c++)
            {
                var cell = (col + c, row + r);
                if (!roomCells.Contains(cell)) return false;
                if (occupied.Contains(cell))   return false;
                if (softOccupied?.Contains(cell) == true) return false;
            }
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

    private static bool ViolatesWindowPlacement(
        int col, int row, int fpW, int fpH,
        TileDefinition tile, string placedOrient,
        HashSet<(int, int)> windowCells)
    {
        if (windowCells.Count == 0) return false;

        var localEdge = NormalizeEdge(tile.WindowBlockedEdge);
        if (localEdge is not null)
        {
            var worldEdge = RotateEdge(localEdge, tile.Orientation, placedOrient);
            return FootprintTouchesEdge(col, row, fpW, fpH, windowCells, worldEdge);
        }

        return tile.IsHigh && FootprintTouchesCells(col, row, fpW, fpH, windowCells);
    }

    private static bool FootprintTouchesEdge(
        int col, int row, int fpW, int fpH,
        HashSet<(int, int)> cells,
        string edge)
    {
        if (cells.Count == 0) return false;
        switch (edge)
        {
            case "N":
                for (int c = 0; c < fpW; c++)
                    if (cells.Contains((col + c, row))) return true;
                return false;
            case "S":
                for (int c = 0; c < fpW; c++)
                    if (cells.Contains((col + c, row + fpH - 1))) return true;
                return false;
            case "W":
                for (int r = 0; r < fpH; r++)
                    if (cells.Contains((col, row + r))) return true;
                return false;
            case "E":
                for (int r = 0; r < fpH; r++)
                    if (cells.Contains((col + fpW - 1, row + r))) return true;
                return false;
            default:
                return false;
        }
    }

    private static string RotateEdge(string edge, string fromOrient, string toOrient)
    {
        int steps = OrientationSteps(fromOrient, toOrient);
        string result = edge;
        for (int i = 0; i < steps; i++)
            result = result switch
            {
                "N" => "E",
                "E" => "S",
                "S" => "W",
                "W" => "N",
                _   => result,
            };
        return result;
    }

    private static int OrientationSteps(string fromOrient, string toOrient)
    {
        int from = OrientIndex(fromOrient);
        int to   = OrientIndex(toOrient);
        if (from < 0 || to < 0) return 0;
        return (to - from + 4) % 4;
    }

    private static int OrientIndex(string orient) => orient switch
    {
        "N" => 0,
        "E" => 1,
        "S" => 2,
        "W" => 3,
        _   => -1,
    };

    private static string? NormalizeEdge(string? edge)
    {
        if (string.IsNullOrWhiteSpace(edge)) return null;
        var n = edge.Trim().ToUpperInvariant();
        return n is "N" or "E" or "S" or "W" ? n : null;
    }

    /// <summary>
    /// Prüft ob der Footprint mindestens eine Zelle hat, die konkret in Richtung
    /// <paramref name="wallDir"/> an eine Wand grenzt.
    /// Verhindert False-Positives wenn der Footprint eine ANDERE Wand berührt als die,
    /// auf der das Möbel platziert werden soll (z.B. Interior-Zelle nahe S-Wand,
    /// deren Footprint die E-Wand tangiert → wallDir=S aber E-Wand würde durchrutschen).
    /// </summary>
    private static bool FootprintTouchesWallDir(int col, int row, int fpW, int fpH,
        Dictionary<(int, int), HashSet<Direction>> cellWalls, Direction wallDir)
    {
        for (int r = 0; r < fpH; r++)
            for (int c = 0; c < fpW; c++)
                if (cellWalls.TryGetValue((col + c, row + r), out var dirs) && dirs.Contains(wallDir))
                    return true;
        return false;
    }

    /// <summary>
    /// Prüft ob irgendeine Zelle des Footprints an irgendeine Wand grenzt (beliebige Richtung).
    /// Wird im Pool-Filter genutzt: Interior-Zellen kommen nur in den Pool wenn ihr Footprint
    /// (in einer der möglichen Orientierungen) mindestens eine Wandzelle berührt.
    /// </summary>
    private static bool FootprintTouchesWall(int col, int row, int fpW, int fpH,
        Dictionary<(int, int), HashSet<Direction>> cellWalls)
    {
        for (int r = 0; r < fpH; r++)
            for (int c = 0; c < fpW; c++)
                if (cellWalls.ContainsKey((col + c, row + r))) return true;
        return false;
    }

    /// <summary>
    /// Sammelt alle Wandrichtungen, die irgendeine Zelle des Footprints berührt.
    /// Wird in ResolveVariantForCell genutzt wenn die Ankerzelle selbst keine Wand hat.
    /// </summary>
    private static HashSet<Direction> FootprintWallDirs(int col, int row, int fpW, int fpH,
        Dictionary<(int, int), HashSet<Direction>> cellWalls)
    {
        var result = new HashSet<Direction>();
        for (int r = 0; r < fpH; r++)
            for (int c = 0; c < fpW; c++)
                if (cellWalls.TryGetValue((col + c, row + r), out var dirs))
                    foreach (var d in dirs) result.Add(d);
        return result;
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

    /// <summary>
    /// Löst "facingAnchor" auf: gibt die Orientierung zurück, mit der ein Slot zum Anker
    /// hin schaut, abhängig von Position und Anker-Footprint-Verhältnis (aw × ah).
    ///
    ///   LongSide0: bei horiz. Anker (aw≥ah) → Norden → Stuhl zeigt nach S
    ///              bei vert.  Anker (ah>aw) → Westen → Stuhl zeigt nach E
    ///   LongSide1: bei horiz. → Süden  → N | bei vert. → Osten  → W
    ///   ShortSide0: bei horiz. → Westen → E | bei vert. → Norden → S
    ///   ShortSide1: bei horiz. → Osten  → W | bei vert. → Süden  → N
    ///   Above/Below/Left/Right: direkte Auflösung.
    /// </summary>
    private static string? ResolveFacingAnchorOrient(string position, int aw, int ah)
    {
        bool wide = aw > ah;
        bool tall = ah > aw;
        return position switch
        {
            "LongSide0"  => wide || (!tall) ? "S" : "E",
            "LongSide1"  => wide || (!tall) ? "N" : "W",
            "ShortSide0" => wide ? "E" : "S",
            "ShortSide1" => wide ? "W" : "N",
            "Above"      => "S",
            "Below"      => "N",
            "Left"       => "E",
            "Right"      => "W",
            _            => null,
        };
    }

    // =========================================================================
    // Anchor position offset calculation
    // =========================================================================

    /// <summary>
    /// Berechnet die Zielposition eines abhängigen Möbels (dep) relativ zu einem platzierten
    /// Anker-Möbel. Die Positionsnamen Head/Foot sind relativ zur Orientierung des Ankers:
    ///
    ///   Orient "S" (Füße Süden, Kopf oben/Norden):
    ///     Kopfende = obere Kante (row = ar), Fußende = untere Kante (row = ar+ah-1)
    ///     HeadLeft  = links vom Kopfende  (West)
    ///     HeadRight = rechts vom Kopfende (East)
    ///
    ///   Orient "N" (Füße Norden, Kopf unten/Süden):
    ///     Kopfende = untere Kante (row = ar+ah-1)
    ///     HeadLeft  = rechts vom Kopfende (East, da Blickrichtung gedreht)
    ///     HeadRight = links vom Kopfende  (West)
    ///
    ///   Orient "W" (Füße Westen, Kopf rechts/Osten):
    ///     Kopfende = rechte Spalte (col = ac+aw-1)
    ///     HeadLeft  = oberhalb des Kopfendes (North)
    ///     HeadRight = unterhalb des Kopfendes (South)
    ///
    ///   Orient "E" (Füße Osten, Kopf links/Westen):
    ///     Kopfende = linke Spalte (col = ac)
    ///     HeadLeft  = unterhalb des Kopfendes (South)
    ///     HeadRight = oberhalb des Kopfendes (North)
    ///
    /// Rückgabe: top-left-Anker des dep-Footprints (depW × depH).
    /// </summary>
    private static (int col, int row)? ComputeAnchoredPosition(
        int ac, int ar, int aw, int ah, int depW, int depH, string position, string anchorOrient, int offset = 0)
    {
        return position switch
        {
            "HeadLeft"  => AnchorHeadLeft (ac, ar, aw, ah, depW, depH, anchorOrient),
            "HeadRight" => AnchorHeadRight(ac, ar, aw, ah, depW, depH, anchorOrient),
            "FootLeft"  => AnchorFootLeft (ac, ar, aw, ah, depW, depH, anchorOrient),
            "FootRight" => AnchorFootRight(ac, ar, aw, ah, depW, depH, anchorOrient),
            // Left/Right: Seite entlang der Längsachse (orient-abhängig)
            "Left"      => anchorOrient is "W" or "E"
                            ? ((int, int)?)(ac + (aw - depW) / 2, ar - depH)
                            : (ac - depW, ar + (ah - depH) / 2),
            "Right"     => anchorOrient is "W" or "E"
                            ? ((int, int)?)(ac + (aw - depW) / 2, ar + ah)
                            : (ac + aw, ar + (ah - depH) / 2),
            // Above/Below/Center: absolut, orient-unabhängig
            "Above"     => (ac + (aw - depW) / 2, ar - depH),
            "Below"     => (ac + (aw - depW) / 2, ar + ah),
            "Center"    => (ac + (aw - depW) / 2, ar + (ah - depH) / 2),
            // ── Footprint-relative Positionen mit optionalem Offset entlang der Kante ──
            // offset=0 → erste Zelle, offset=1 → zweite Zelle, usw.
            // Negative Werte: letztes-N → offset=-1 letztes, -2 vorletztes, usw.
            // (normalisiert: offset < 0 → aw/ah + offset − für negative Indizes)
            "LongSide0" => aw >= ah
                            ? ((int, int)?)(ac + NormOffset(offset, aw, depW), ar - depH)          // Norden
                            : (ac - depW,  ar + NormOffset(offset, ah, depH)),                      // Westen
            "LongSide1" => aw >= ah
                            ? ((int, int)?)(ac + NormOffset(offset, aw, depW), ar + ah)             // Süden
                            : (ac + aw,    ar + NormOffset(offset, ah, depH)),                      // Osten
            "ShortSide0" => aw >= ah
                            ? ((int, int)?)(ac - depW,  ar + NormOffset(offset, ah, depH))          // Westen
                            : (ac + NormOffset(offset, aw, depW), ar - depH),                       // Norden
            "ShortSide1" => aw >= ah
                            ? ((int, int)?)(ac + aw,    ar + NormOffset(offset, ah, depH))          // Osten
                            : (ac + NormOffset(offset, aw, depW), ar + ah),                         // Süden
            // ── Orientierungsabhängige Eck-/Seitenpositionen ─────────────────────────────
            // leftPerpendicular/rightPerpendicular wählen die senkrechte Nachbarzelle
            // relativ zur Blickrichtung des Ankers. Damit lassen sich beide L-Shape-Seiten
            // stabil und getrennt konfigurieren (z.B. Dusche/Counter in jeder Ecke).
            "leftPerpendicular" => anchorOrient switch
            {
                "N" => ((int, int)?)(ac - depW,                  ar + (ah - depH) / 2),  // West
                "E" => ((int, int)?)(ac + (aw - depW) / 2,       ar - depH),             // Nord
                "S" => ((int, int)?)(ac + aw,                    ar + (ah - depH) / 2),  // Ost
                "W" => ((int, int)?)(ac + (aw - depW) / 2,       ar + ah),               // Sued
                _   => null,
            },
            "rightPerpendicular" => anchorOrient switch
            {
                "N" => ((int, int)?)(ac + aw,                    ar + (ah - depH) / 2),  // Ost
                "E" => ((int, int)?)(ac + (aw - depW) / 2,       ar + ah),               // Sued
                "S" => ((int, int)?)(ac - depW,                  ar + (ah - depH) / 2),  // West
                "W" => ((int, int)?)(ac + (aw - depW) / 2,       ar - depH),             // Nord
                _   => null,
            },
            // Legacy-Kurzform: entspricht leftPerpendicular und bleibt fuer bestehende
            // Konfigurationen erhalten.
            "perpendicularSide" => anchorOrient switch
            {
                "S" => ((int, int)?)(ac + aw,                    ar + (ah - depH) / 2),  // Right
                "E" => ((int, int)?)(ac + (aw - depW) / 2,       ar + ah),               // Below
                "N" => ((int, int)?)(ac - depW,                  ar + (ah - depH) / 2),  // Left
                "W" => ((int, int)?)(ac + (aw - depW) / 2,       ar - depH),             // Above
                _   => null,
            },
            _           => null,
        };
    }

    /// <summary>
    /// Liefert Kandidatenpositionen fuer "openSidePlacement" in Prioritaetsreihenfolge:
    /// zuerst Primary, dann Secondary. Die gueltige Position wird im Caller bestimmt.
    /// Mapping:
    ///   Orient W/E -> S dann N
    ///   Orient N/S -> W dann E
    /// PZ-Projektion der Zielwandkante auf Zellen:
    ///   W/N-Kante -> gleiche Zelle wie Anker
    ///   E-Kante   -> rechte Nachbarzelle
    ///   S-Kante   -> untere Nachbarzelle
    /// </summary>
    private static IEnumerable<char> ComputeOpenSideOrder(string anchorOrient)
    {
        (char primary, char secondary) = anchorOrient switch
        {
            "W" => ('S', 'N'),
            "E" => ('S', 'N'),
            "N" => ('W', 'E'),
            "S" => ('W', 'E'),
            _   => ('\0', '\0'),
        };

        if (primary != '\0') yield return primary;
        if (secondary != '\0') yield return secondary;
    }

    private static (int col, int row) ComputeOpenSidePosition(
        int ac, int ar, int aw, int ah, int depW, int depH, char side)
    {
        (int centerCol, int centerRow) center = (ac + (aw - depW) / 2, ar + (ah - depH) / 2);
        return side switch
        {
            // N/W-Wand liegt auf der aktuellen Zelle.
            'N' => center,
            'W' => center,
            // S/E-Wand wird über Nachbarzelle mit N/W-Kante repräsentiert.
            'S' => (center.centerCol, center.centerRow + ah),
            'E' => (center.centerCol + aw, center.centerRow),
            _   => center,
        };
    }

    /// <summary>
    /// Berechnet den Zell-Offset entlang einer Ankerkante.
    /// Bei offset=0 → erste Zelle (kein Versatz).
    /// Negative Werte: letztes - |offset| (z.B. -1 = letzte Zelle der Kante).
    /// anchorLen = Länge der Ankerkante, depLen = Tiefe des dep-Footprints.
    /// </summary>
    private static int NormOffset(int offset, int anchorLen, int depLen)
    {
        if (offset >= 0) return offset;
        // -1 = letzte mögliche Position, -2 = vorletzte, usw.
        return anchorLen - depLen + offset + 1;
    }

    // Kopfende oben (S) / unten (N) / rechts (W) / links (E)
    // HeadLeft = "linke" Seite aus Perspektive: stehend am Fußende, zum Kopf schauend
    private static (int col, int row) AnchorHeadLeft(
        int ac, int ar, int aw, int ah, int depW, int depH, string orient) => orient switch
    {
        "S" => (ac - depW,        ar),                  // West des Kopfendes (oben)
        "N" => (ac + aw,          ar + ah - depH),      // East des Kopfendes (unten)
        "W" => (ac + aw - depW,   ar - depH),           // Nord des Kopfendes (rechts)
        "E" => (ac,               ar + ah),             // Süd des Kopfendes (links)
        _   => (ac - depW,        ar),
    };

    private static (int col, int row) AnchorHeadRight(
        int ac, int ar, int aw, int ah, int depW, int depH, string orient) => orient switch
    {
        "S" => (ac + aw,          ar),                  // East des Kopfendes (oben)
        "N" => (ac - depW,        ar + ah - depH),      // West des Kopfendes (unten)
        "W" => (ac + aw - depW,   ar + ah),             // Süd des Kopfendes (rechts)
        "E" => (ac,               ar - depH),           // Nord des Kopfendes (links)
        _   => (ac + aw,          ar),
    };

    private static (int col, int row) AnchorFootLeft(
        int ac, int ar, int aw, int ah, int depW, int depH, string orient) => orient switch
    {
        "S" => (ac - depW,        ar + ah - depH),      // West des Fußendes (unten)
        "N" => (ac + aw,          ar),                  // East des Fußendes (oben)
        "W" => (ac - depW,        ar - depH),           // Nord des Fußendes (links)
        "E" => (ac + aw - depW,   ar + ah),             // Süd des Fußendes (rechts)
        _   => (ac - depW,        ar + ah - depH),
    };

    private static (int col, int row) AnchorFootRight(
        int ac, int ar, int aw, int ah, int depW, int depH, string orient) => orient switch
    {
        "S" => (ac + aw,          ar + ah - depH),      // East des Fußendes (unten)
        "N" => (ac - depW,        ar),                  // West des Fußendes (oben)
        "W" => (ac - depW,        ar + ah),             // Süd des Fußendes (links)
        "E" => (ac + aw - depW,   ar - depH),           // Nord des Fußendes (rechts)
        _   => (ac + aw,          ar + ah - depH),
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

    /// <summary>
    /// Prüft ob jede Footprint-Zelle eines Loot-Containers von mindestens einer
    /// freien Raumzelle aus erreichbar ist (Moore-Nachbarschaft, Reichweite 1).
    /// Simuliert die Belegung nach Platzierung des Footprints: occupied + dieser Footprint.
    /// </summary>
    private static bool LootContainerReachable(
        int col, int row, int fpW, int fpH,
        HashSet<(int, int)> roomCells,
        HashSet<(int, int)> occupied)
    {
        // Simuliere: occupied nach Platzierung dieses Footprints
        var tempOccupied = new HashSet<(int, int)>(occupied);
        for (int r = 0; r < fpH; r++)
            for (int c = 0; c < fpW; c++)
                tempOccupied.Add((col + c, row + r));

        // Jede Footprint-Zelle muss von mind. einer freien Nachbarzelle erreichbar sein
        for (int r = 0; r < fpH; r++)
        for (int c = 0; c < fpW; c++)
        {
            bool reachable = false;
            for (int dr = -1; dr <= 1 && !reachable; dr++)
            for (int dc = -1; dc <= 1 && !reachable; dc++)
            {
                if (dr == 0 && dc == 0) continue;
                var neighbor = (col + c + dc, row + r + dr);
                if (roomCells.Contains(neighbor) && !tempOccupied.Contains(neighbor))
                    reachable = true;
            }
            if (!reachable) return false;
        }
        return true;
    }

    /// <summary>
    /// Prüft ob nach simulierter Platzierung des Footprints alle begehbaren Raumzellen
    /// noch zusammenhängend erreichbar sind (8-Nachbarschaft, da PZ diagonales Gehen erlaubt).
    /// Verhindert dass Möbel mit Kollision Raumbereiche abschneiden – z.B. ein Bett das
    /// in einem nicht-rechteckigen Raum eine Ecke isoliert.
    /// Startpunkt der BFS ist bevorzugt eine Türzelle (garantiert erreichbar vom Eingang).
    /// </summary>
    private static bool RoomRemainsConnected(
        int col, int row, int fpW, int fpH,
        HashSet<(int, int)> roomCells,
        HashSet<(int, int)> occupied,
        HashSet<(int, int)> doorCells)
    {
        // Simuliere: occupied nach Platzierung dieses Footprints
        var tempOccupied = new HashSet<(int, int)>(occupied);
        for (int r = 0; r < fpH; r++)
            for (int c = 0; c < fpW; c++)
                tempOccupied.Add((col + c, row + r));

        // Alle nach Platzierung noch begehbaren Zellen
        var walkable = new HashSet<(int, int)>(roomCells.Count);
        foreach (var cell in roomCells)
            if (!tempOccupied.Contains(cell))
                walkable.Add(cell);

        if (walkable.Count == 0) return true; // Raum komplett voll – kein Connectivity-Check nötig

        // Startpunkt: bevorzugt eine Türzelle (diese ist garantiert vom Eingang erreichbar),
        // sonst erste walkable Zelle.
        var start = default((int, int));
        bool found = false;
        foreach (var d in doorCells)
        {
            if (walkable.Contains(d)) { start = d; found = true; break; }
        }
        if (!found) start = walkable.First();

        // BFS über 4-Nachbarschaft (N/S/E/W) – Bewegung in PZ ist rein orthogonal,
        // diagonale Bewegung ist nicht möglich. Nur LootContainerReachable nutzt die
        // Moore-Nachbarschaft (8 Richtungen) für diagonalen Container-Zugriff.
        var visited = new HashSet<(int, int)>(walkable.Count);
        var queue   = new Queue<(int, int)>();
        queue.Enqueue(start);
        visited.Add(start);

        while (queue.Count > 0)
        {
            var (cc, cr) = queue.Dequeue();
            foreach (var nb in new (int, int)[]
                { (cc, cr - 1), (cc, cr + 1), (cc - 1, cr), (cc + 1, cr) })
            {
                if (walkable.Contains(nb) && visited.Add(nb))
                    queue.Enqueue(nb);
            }
        }

        // Alle begehbaren Zellen müssen von der BFS erreicht worden sein
        return visited.Count == walkable.Count;
    }
}



















































































