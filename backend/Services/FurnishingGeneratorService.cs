using backend.Models;

namespace backend.Services;

// ── Request / Response ────────────────────────────────────────────────────────

/// <summary>One room the user wants to furnish.</summary>
public record RoomSelection(
    int    FloorIndex,
    int    RoomIndex1Based,
    int?   AnchorCol = null,
    int?   AnchorRow = null,
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
    /// true  = Ein einziger Wert wird pro Aufruf gezogen und für ALLE Räume erzwungen (auch wenn DensityMin &lt; DensityMax).
    /// false = Standard: Jeder Raum bekommt einen eigenen Zufallswert, sofern DensityMin &lt; DensityMax.
    /// </summary>
    bool                DensityFixed = false);

/// <summary>A single tile placed on the grid.</summary>
public record PlacedFurnitureItem(
    int    FloorIndex,
    int    Col,
    int    Row,
    string TileId,
    string Layer,
    string Orient,
    string SlotId = "",
    int?   RoomIndex1Based = null,
    int?   AnchorCol = null,
    int?   AnchorRow = null,
    // Client-generated identity for manual drag & drop; never populated server-side.
    string? Id = null);

/// <summary>A reserved rectangular zone (e.g. "Car" spot) that placement must avoid entirely.</summary>
public record ReservedZonePlacement(
    int    FloorIndex,
    int    RoomIndex1Based,
    int    Col,
    int    Row,
    int    Width,
    int    Height,
    string Label);

public record FurnishResult(
    List<PlacedFurnitureItem>   Placements,
    List<string>                Log,
    List<ReservedZonePlacement> ReservedZones);

/// <summary>
/// Optional per-room progress callbacks for <see cref="IFurnishingGeneratorService.Generate"/>.
/// Called synchronously on the generating thread, once per room selection, in order.
/// </summary>
public interface IFurnishProgress
{
    void RoomStarted(int index, int total, RoomSelection sel, string roomName, string? roomType);
    /// <summary>Everything this selection produced: its placements, reserved zones and log lines.</summary>
    void RoomFinished(int index, int total, RoomSelection sel,
                      List<PlacedFurnitureItem> placements, List<ReservedZonePlacement> zones,
                      List<string> log, bool skipped);
}

// ── Interface ─────────────────────────────────────────────────────────────────

public interface IFurnishingGeneratorService
{
    /// <summary>
    /// <paramref name="ct"/> is checked between rooms (and room components); a cancelled run
    /// throws <see cref="OperationCanceledException"/> after reporting the rooms finished so far.
    /// <paramref name="inputs"/> replaces the on-disk room types / tiles / rugs for this call
    /// only (repro-bundle replay); null = use the configured services.
    /// </summary>
    FurnishResult Generate(FurnishRequest request, IFurnishProgress? progress = null, CancellationToken ct = default,
                           GeneratorInputs? inputs = null);
}

/// <summary>In-memory config snapshot a generation run can use instead of the config services.</summary>
public record GeneratorInputs(
    IReadOnlyDictionary<string, RoomTypeConfig> RoomTypes,
    IReadOnlyDictionary<string, TileDefinition> Tiles,
    IReadOnlyDictionary<string, RugDefinition>  Rugs);

// ── Implementation ────────────────────────────────────────────────────────────

public partial class FurnishingGeneratorService : IFurnishingGeneratorService
{
    private const int LayoutSearchNodeLimit = 20000;

    // Cancellation for the current Generate call, so the deep composite-layout search (which
    // can run for minutes on e.g. kitchens) can stop without threading a token through every
    // signature. Generate runs synchronously on one thread, and the service is a singleton
    // shared across requests, hence thread-static rather than a field.
    [ThreadStatic] private static CancellationToken t_cancel;

    // FilterTiles result per (slot instance, room type) for the current Generate call. The
    // composite-layout search re-derives each slot's tile pool on every node, and FilterTiles
    // scans the whole tile catalog — profiling a kitchen showed this was ~86% of its runtime.
    // The result only depends on the slot, room type and catalog, all fixed during one call.
    [ThreadStatic] private static Dictionary<(RoomTypeSlot, string), List<TileDefinition>>? t_layoutPoolCache;

    private readonly IRoomTypeConfigService _roomTypeSvc;
    private readonly ITileConfigService     _tileSvc;
    private readonly IPathfinderService     _pathfinder;
    private readonly IRugCatalogService     _rugSvc;

    public FurnishingGeneratorService(IRoomTypeConfigService roomTypeSvc, ITileConfigService tileSvc, IPathfinderService pathfinder, IRugCatalogService rugSvc)
    {
        _roomTypeSvc = roomTypeSvc;
        _tileSvc     = tileSvc;
        _pathfinder  = pathfinder;
        _rugSvc      = rugSvc;
    }

    // =========================================================================
    // Main entry point
    // =========================================================================

    public FurnishResult Generate(FurnishRequest req, IFurnishProgress? progress = null, CancellationToken ct = default,
                                  GeneratorInputs? inputs = null)
    {
        t_cancel = ct;
        t_layoutPoolCache = new(new SlotKeyComparer());
        try { return GenerateCore(req, progress, ct, inputs); }
        finally { t_cancel = default; t_layoutPoolCache = null; }
    }

    private FurnishResult GenerateCore(FurnishRequest req, IFurnishProgress? progress, CancellationToken ct, GeneratorInputs? inputs)
    {
        var rng            = new Random(req.Seed ?? Environment.TickCount);
        var placements     = new List<PlacedFurnitureItem>();
        var log            = new List<string>();
        var reservedZones  = new List<ReservedZonePlacement>();
        var allTiles       = inputs?.Tiles     ?? _tileSvc.GetAllEnabled();
        var rugCatalog     = inputs?.Rugs      ?? _rugSvc.GetAllEnabled();
        var roomTypes      = inputs?.RoomTypes ?? _roomTypeSvc.GetAll();

        // Möblierungsdichte: zufälliger Wert aus [DensityMin, DensityMax].
        // DensityFixed=true:  ein einziger Wert wird erzwungen und für alle Räume verwendet – einheitliches Bild.
        // DensityFixed=false: jeder Raum bekommt seinen eigenen Zufallswert, sofern Min≠Max.
        float dMin    = Math.Clamp(req.DensityMin, 0f, 1f);
        float dMax    = Math.Clamp(req.DensityMax, 0f, 1f);
        double DrawDensity() => dMin >= dMax ? dMin : dMin + rng.NextDouble() * (dMax - dMin);
        // Nur wenn NICHT DensityFixed und Min≠Max → jeder Raum bekommt einen eigenen Zufallswert.
        bool perRoom  = !req.DensityFixed && dMin < dMax;
        double density = DrawDensity();
        log.Add($"[DENSITY] range=[{dMin:P0}–{dMax:P0}] perRoom={perRoom} (fixed={req.DensityFixed}) → initial={density:P0}");

        // Tracks which opening-adjacent cells in one room are blocked by placed furniture,
        // so the opposing room's opening group is reduced accordingly (aligned-pair awareness).
        var crossRoomBlockedPerFloor = new Dictionary<int, HashSet<(int, int)>>();

        // Stair footprints (mid/end split — see ComputeStairCells), cached per floor since
        // multiple room selections can share a floor.
        var stairCellsPerFloor = new Dictionary<int, (HashSet<(int, int)> mid, HashSet<(int, int)> ends)>();

        // 1-wide room cells per floor (room shape only — inner walls ignored, see
        // NarrowAreaDetector); keyed by floor list index like the detector itself.
        var narrowPerFloor = new Dictionary<int, Dictionary<int, List<int[]>>>();

        int total = req.RoomSelections.Count;
        for (int selIndex = 0; selIndex < total; selIndex++)
        {
            ct.ThrowIfCancellationRequested();
            var sel = req.RoomSelections[selIndex];

            // Everything this selection adds is reported as one slice in the finally below,
            // which also runs for every `continue` / [SKIP] path.
            int placementsBefore = placements.Count, zonesBefore = reservedZones.Count, logBefore = log.Count;
            try
            {
                var floor = req.Building.Floors.FirstOrDefault(f => f.Index == sel.FloorIndex);
                if (floor is null)
                {
                    progress?.RoomStarted(selIndex, total, sel, $"#{sel.RoomIndex1Based}", null);
                    log.Add($"[SKIP] Floor {sel.FloorIndex} not found."); continue;
                }

                if (sel.RoomIndex1Based < 1 || sel.RoomIndex1Based > req.Building.Rooms.Count)
                {
                    progress?.RoomStarted(selIndex, total, sel, $"#{sel.RoomIndex1Based}", null);
                    log.Add($"[SKIP] Room index {sel.RoomIndex1Based} out of range."); continue;
                }

                var room = req.Building.Rooms[sel.RoomIndex1Based - 1];

                // 1. Room-type matching via InternalName (case-insensitive)
                var typeName  = !string.IsNullOrWhiteSpace(sel.RoomTypeOverride) ? sel.RoomTypeOverride : room.InternalName;
                var configKey = roomTypes.Keys.FirstOrDefault(k => k.Equals(typeName, StringComparison.OrdinalIgnoreCase));
                progress?.RoomStarted(selIndex, total, sel, room.Name, configKey ?? typeName);
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

                // 2. Room analysis – split disconnected room indices into separate components.
                // When an explicit anchor is given, GetRoomCells already returns the single
                // connected component containing that cell; no further splitting needed.
                var allRoomCells = GetRoomCells(floor, sel.RoomIndex1Based, sel.AnchorCol, sel.AnchorRow);

                if (!stairCellsPerFloor.TryGetValue(sel.FloorIndex, out var stairCells))
                    stairCellsPerFloor[sel.FloorIndex] = stairCells = ComputeStairCells(floor, req.Building, sel.FloorIndex);
                // Stair treads (middle 3 of the 5-cell span) aren't real floor — excluded before
                // room-size classification/component-splitting, same as a wall would be. The 2
                // end cells (landings) stay in the room; only non-floor-layer furniture is kept
                // off them (see stairEndCells passed into PlaceSlot below).
                allRoomCells.ExceptWith(stairCells.mid);

                if (allRoomCells.Count == 0)
                {
                    var anchorInfo = sel.AnchorCol.HasValue && sel.AnchorRow.HasValue
                        ? $" anchor=({sel.AnchorCol.Value},{sel.AnchorRow.Value})"
                        : string.Empty;
                    log.Add($"[SKIP] '{room.Name}' (floor {sel.FloorIndex}, roomIndex {sel.RoomIndex1Based}{anchorInfo}): no matching room cells found.");
                    continue;
                }

                var components = (!sel.AnchorCol.HasValue || !sel.AnchorRow.HasValue)
                    ? SplitIntoComponents(allRoomCells)
                    : new List<HashSet<(int, int)>> { allRoomCells };

                if (components.Count > 1)
                    log.Add($"[SPLIT] '{room.Name}' (floor {sel.FloorIndex}, roomIndex {sel.RoomIndex1Based}): {allRoomCells.Count} cells → {components.Count} connected components, furnishing each separately");

                foreach (var roomCells in components)
                {
                    ct.ThrowIfCancellationRequested();

                    // Neuen Density-Wert pro Komponente ziehen wenn Range variabel oder Toggle aktiv.
                    if (perRoom)
                        density = DrawDensity();

                    var layoutVariant = SelectLayoutVariant(config, rng, log);

                    var roomSize      = RoomSize.Classify(roomCells.Count);
                    var cellWalls     = ComputeWallDirections(roomCells, floor, stairCells.mid);
                    var doorCells     = GetEdgeCells(floor, roomCells, FloorObjectType.Door);
                    var windowCells   = GetEdgeCells(floor, roomCells, FloorObjectType.Window);
                    // Scoped to edges touching THIS room's cells — edge keys are plain coordinate
                    // strings with no room identifier, so an unfiltered floor-wide set can spuriously
                    // "match" a different room's wall whose grid coordinates happen to sit adjacent
                    // to this room's cells (e.g. another room's wall one column over), corrupting
                    // gap-cell detection for a room it has nothing to do with.
                    var innerWallKeys = floor.Edges
                        .Where(e => e.Type == FloorObjectType.InnerWall
                            && (roomCells.Contains((e.Cell1Col, e.Cell1Row)) || roomCells.Contains((e.Cell2Col, e.Cell2Row))))
                        .Select(e => e.EdgeKey)
                        .ToHashSet();
                    // Gap cells are the only passages through inner walls. Unlike a real door/opening,
                    // blocking one doesn't necessarily seal off anything — the pocket behind it may
                    // still be reachable via another route. So they're NOT unconditionally protected
                    // like doorCells; FindFreeCell/EnumerateFreePlacementCandidates instead defer to
                    // RoomRemainsConnected to decide whether a specific candidate actually disconnects
                    // the room (see BlockedByGapCell).
                    var gapCells = innerWallKeys.Count > 0
                        ? ComputeInnerWallGapCells(roomCells, innerWallKeys)
                        : new HashSet<(int, int)>();
                    // Opening edges: group by external room → each room needs ≥1 free access cell.
                    // Size-1 groups → strict (like door); size ≥ 2 → soft (at least 1 must stay open).
                    // Cross-room awareness: cells whose opposing side was already blocked in another room
                    // are removed from the effective group (shrinks the soft-protect count accordingly).
                    var allOpeningGroups = ComputeOpeningGroups(floor, roomCells);
                    var openingGroups    = new List<HashSet<(int, int)>>();
                    crossRoomBlockedPerFloor.TryGetValue(sel.FloorIndex, out var crossRoomBlocked);
                    foreach (var g in allOpeningGroups)
                    {
                        var effectiveGroup = crossRoomBlocked is { Count: > 0 }
                            ? new HashSet<(int, int)>(g.Where(c => !crossRoomBlocked.Contains(c)))
                            : g;
                        if (effectiveGroup.Count == 0) continue;
                        if (effectiveGroup.Count == 1) doorCells.UnionWith(effectiveGroup);
                        else                           openingGroups.Add(effectiveGroup);
                    }
                    var mainSubRoomCells = ComputeMainSubRoom(roomCells, innerWallKeys,
                        new HashSet<(int, int)>(doorCells.Concat(gapCells)));
                    var occupied            = new HashSet<(int, int)>();
                    var softOccupied        = new HashSet<(int, int)>();
                    var physicalOccupied    = new HashSet<(int, int)>(); // nur Tiles mit HasCollision=true
                    var blockedFrontCells   = new HashSet<(int, int)>();
                    var frontExemptCells    = new HashSet<(int, int)>(); // FloorFurniture ohne Kollision, s. IsFloorFurnitureNoCollision
                    var floorLayerOccupied  = new HashSet<(int, int)>(); // alle FloorFurniture-Layer-Zellen, s. FitsFootprint
                    var cellPropertyGates   = new Dictionary<(int, int), HashSet<string>>();
                    var reservedZoneCells   = new HashSet<(int, int)>();

                    // Sperrzonen (z.B. "Car"-Stellplatz) berechnen. Blockieren die Platzierung nicht
                    // pauschal über `occupied` — Wandmöbel/Bodenauflagen ohne Kollision dürfen sie
                    // weiterhin nutzen (siehe BlockedByReservedZone).
                    if (config.ReservedZones.Count > 0)
                    {
                        var (zoneCells, zonePlacements) = ComputeReservedZones(
                            config.ReservedZones, sel.FloorIndex, sel.RoomIndex1Based, roomCells, openingGroups, log);
                        reservedZoneCells.UnionWith(zoneCells);
                        reservedZones.AddRange(zonePlacements);
                    }

                    // Pfad-Zellen des Raums (aus PathsByRoom, falls vorhanden)
                    var pathCells = floor.PathsByRoom.TryGetValue(sel.RoomIndex1Based, out var path)
                        ? path.Select(p => (p[0], p[1])).ToHashSet()
                        : new HashSet<(int, int)>();
                    pathCells.IntersectWith(roomCells);

                    // Narrow cells (1-wide necks/corridors/bottlenecks + their entry cells): only
                    // wall-mounted and floor-layer tiles may go there (see FitsFootprint). A room
                    // that is narrow everywhere (1x2 laundry etc.) gets no restriction.
                    int floorListIndex = req.Building.Floors.IndexOf(floor);
                    if (!narrowPerFloor.TryGetValue(floorListIndex, out var floorNarrow))
                        narrowPerFloor[floorListIndex] = floorNarrow = NarrowAreaDetector.Compute(req.Building, floorListIndex, ignoreInnerWalls: true);
                    var narrowCells = floorNarrow.TryGetValue(sel.RoomIndex1Based, out var narrowList)
                        ? narrowList.Where(n => n[2] == 1).Select(n => (n[0], n[1])).ToHashSet()
                        : new HashSet<(int, int)>();
                    narrowCells.IntersectWith(roomCells);
                    bool wholeRoomNarrow = narrowCells.Count > 0
                        && roomCells.All(c => narrowCells.Contains(c) || stairCells.ends.Contains(c));

                    log.Add(RoomSeparatorLine(sel.FloorIndex, room.Name));
                    log.Add($"[ROOM] Floor {sel.FloorIndex} · '{room.Name}' → config '{configKey}', {roomCells.Count} cells, size {roomSize}, {pathCells.Count} path cells, {narrowCells.Count} narrow cells, density {density:P0}");
                    if (wholeRoomNarrow)
                    {
                        log.Add("[NARROW] whole room narrow → no restriction");
                        narrowCells.Clear();
                    }

                    var seededColorMap = SeedGroupColors(config, roomSize, allTiles, configKey, rng, log);

                    // Grid layouts are placed first, as fixed units; their occupancy/anchors/colour
                    // locks then seed both the composite solver and the greedy pass below.
                    var gridState = PlaceGrids(config, layoutVariant, roomSize, sel.FloorIndex, roomCells, cellWalls,
                        doorCells, windowCells, pathCells, allTiles, seededColorMap, reservedZoneCells, rng, configKey,
                        sel.RoomIndex1Based, sel.AnchorCol, sel.AnchorRow, innerWallKeys, openingGroups, gapCells,
                        stairCells.ends, mainSubRoomCells, narrowCells, log);
                    if (gridState is not null)
                    {
                        placements.AddRange(gridState.Placements);
                        foreach (var (groupId, color) in gridState.ColorMap)
                            seededColorMap[groupId] = color;
                    }

                    if (layoutVariant is not null)
                    {
                        var layoutAttemptOrder = BuildLayoutAttemptOrder(config, layoutVariant, rng);
                        if (TryPlaceCompositeLayout(
                                config,
                                layoutVariant,
                                layoutAttemptOrder,
                                roomSize,
                                density,
                                sel.FloorIndex,
                                roomCells,
                                cellWalls,
                                doorCells,
                                windowCells,
                                pathCells,
                                allTiles,
                                seededColorMap,
                                rng,
                                configKey,
                                sel.RoomIndex1Based,
                                sel.AnchorCol,
                                sel.AnchorRow,
                                placements,
                                log,
                                innerWallKeys,
                                mainSubRoomCells,
                                openingGroups,
                                reservedZoneCells,
                                gapCells,
                                narrowCells,
                                out var usedVariant,
                                gridState is null ? null : SeedStateFromGrids(gridState)))
                        {
                            log.Add($"[ROOM] layout variant -> '{usedVariant!.Id}'");
                            continue;
                        }
                    }

                    // 3. Slot selection
                    var activeLayoutSlotIds = BuildLayoutSlotFilter(config, layoutVariant, log);
                    var slotsBase = SelectSlots(config, roomSize, rng, log, allTiles, configKey, density, activeLayoutSlotIds, rugCatalog, roomCells);

                    // Pool count-step ceiling for the fallback (non-backtracking) placement pass
                    // below — mirrors TryPlaceCompositeLayout's countStep loop so a room that
                    // reaches this fallback still gets a chance to shrink an over-full pool
                    // instead of only ever trying countStep=0 (max pool size) once.
                    int fallbackMaxStep = layoutVariant?.Pools is { Count: > 0 } fallbackPools
                        ? fallbackPools
                            .Select(p => p.TotalCountBySize.TryGetValue(roomSize, out var r) ? Math.Max(0, r.Max - r.Min) : 0)
                            .DefaultIfEmpty(0).Max()
                        : 0;

                    // 4. Place each slot
                    // List-valued: a slot with countBySize>1 places multiple instances under the
                    // same slot.Id — see AddAnchorEntry/the round-robin pick in PlaceSlot.
                    var anchorMap      = new Dictionary<string, List<(int col, int row, int fpW, int fpH, string orient)>>(StringComparer.OrdinalIgnoreCase);
                    var anchorUseCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                    var colorMap   = new Dictionary<string, string>(seededColorMap, StringComparer.OrdinalIgnoreCase);
                    var variantMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

                    // Place slots in dependency order (requiresSlot / anchorRules-target chains
                    // resolved before their dependents), so a randomized tie-break among
                    // independent slots (see SelectSlots) can never sequence a dependent slot
                    // ahead of the slot/group it requires. Ordering among independent slots is
                    // preserved unchanged by ExpandLayoutSlotSequence's stable ThenBy(index) sort.
                    void PlaceOrderedSlot(RoomTypeSlot slot, HashSet<(int, int)>? decorPathCellsForSlot)
                    {
                        // Abhängigkeitsprüfung: requiresSlot = Slot oder SlotGroupId muss zuvor
                        // erfolgreich platziert worden sein (Eintrag in anchorMap).
                        if (!string.IsNullOrEmpty(slot.RequiresSlot)
                            && !anchorMap.ContainsKey(slot.RequiresSlot))
                        {
                            log.Add($"  [SKIP] '{slot.Id}': requiresSlot='{slot.RequiresSlot}' wurde nicht platziert");
                            return;
                        }
                        if (HasUnresolvedDependentAnchor(slot, anchorMap.ContainsKey))
                        {
                            log.Add($"  [SKIP] '{slot.Id}': kein anchorTarget von requiresSlot='{slot.RequiresSlot}' wurde platziert");
                            return;
                        }
                        PlaceSlot(slot, sel.FloorIndex, roomCells, cellWalls, doorCells, windowCells,
                            pathCells, occupied, softOccupied, physicalOccupied, blockedFrontCells, floorLayerOccupied, allTiles, rugCatalog, anchorMap, anchorUseCounts, colorMap, variantMap, config,
                            sel.RoomIndex1Based, sel.AnchorCol, sel.AnchorRow,
                            placements, log, rng, configKey, innerWallKeys, mainSubRoomCells, openingGroups, cellPropertyGates, reservedZoneCells, frontExemptCells, gapCells, decorPathCellsForSlot,
                            stairEndCells: stairCells.ends, narrowCells: narrowCells);
                    }

                    if (gridState is not null)
                    {
                        occupied.UnionWith(gridState.Occupied);
                        softOccupied.UnionWith(gridState.SoftOccupied);
                        physicalOccupied.UnionWith(gridState.PhysicalOccupied);
                        blockedFrontCells.UnionWith(gridState.BlockedFrontCells);
                        frontExemptCells.UnionWith(gridState.FrontExemptCells);
                        foreach (var p in gridState.Placements)
                            if (p.Layer.Equals("FloorFurniture", StringComparison.OrdinalIgnoreCase))
                                floorLayerOccupied.Add((p.Col, p.Row));
                        foreach (var (cell, gate) in gridState.CellPropertyGates)
                            cellPropertyGates[cell] = new HashSet<string>(gate, StringComparer.OrdinalIgnoreCase);
                    }

                    // Grid anchors / tile-group locks; re-applied after every countStep reset below.
                    void SeedGridAnchors()
                    {
                        if (gridState is null) return;
                        foreach (var (key, entry) in gridState.AnchorMap)
                            anchorMap[key] = [entry];
                        foreach (var (key, vg) in gridState.VariantMap)
                            variantMap[key] = vg;
                    }
                    SeedGridAnchors();

                    // Snapshot pre-attempt state so a failed countStep attempt (missing required
                    // pool slots) can be rolled back before retrying with a smaller pool instead
                    // of stacking a second, overlapping placement pass on top of the first.
                    var occupiedSnap          = new HashSet<(int, int)>(occupied);
                    var softOccupiedSnap      = new HashSet<(int, int)>(softOccupied);
                    var physicalOccupiedSnap  = new HashSet<(int, int)>(physicalOccupied);
                    var blockedFrontCellsSnap = new HashSet<(int, int)>(blockedFrontCells);
                    var frontExemptCellsSnap  = new HashSet<(int, int)>(frontExemptCells);
                    var floorLayerOccupiedSnap = new HashSet<(int, int)>(floorLayerOccupied);
                    var cellPropertyGatesSnap = cellPropertyGates.ToDictionary(kv => kv.Key, kv => new HashSet<string>(kv.Value, StringComparer.OrdinalIgnoreCase));
                    var placementsCountBefore = placements.Count;

                    for (int countStep = 0; countStep <= fallbackMaxStep; countStep++)
                    {
                        if (countStep > 0)
                        {
                            occupied.Clear(); occupied.UnionWith(occupiedSnap);
                            softOccupied.Clear(); softOccupied.UnionWith(softOccupiedSnap);
                            physicalOccupied.Clear(); physicalOccupied.UnionWith(physicalOccupiedSnap);
                            blockedFrontCells.Clear(); blockedFrontCells.UnionWith(blockedFrontCellsSnap);
                            frontExemptCells.Clear(); frontExemptCells.UnionWith(frontExemptCellsSnap);
                            floorLayerOccupied.Clear(); floorLayerOccupied.UnionWith(floorLayerOccupiedSnap);
                            cellPropertyGates.Clear();
                            foreach (var kv in cellPropertyGatesSnap) cellPropertyGates[kv.Key] = new HashSet<string>(kv.Value, StringComparer.OrdinalIgnoreCase);
                            anchorMap.Clear();
                            anchorUseCounts.Clear();
                            colorMap.Clear();
                            foreach (var kv in seededColorMap) colorMap[kv.Key] = kv.Value;
                            variantMap.Clear();
                            SeedGridAnchors();
                            placements.RemoveRange(placementsCountBefore, placements.Count - placementsCountBefore);
                        }

                        var poolSlots = layoutVariant is not null ? ExpandPoolSlots(layoutVariant, roomSize, countStep, rng, log, allTiles, configKey, density) : [];
                        var slotsToPlace = poolSlots.Count > 0
                            ? [..slotsBase, ..poolSlots.Select(s => (s, 1))]
                            : slotsBase;

                        var orderedRoomSlots = ExpandLayoutSlotSequence(slotsToPlace);
                        var structuralRoomSlots = orderedRoomSlots;
                        var decorRoomSlots = new List<RoomTypeSlot>();
                        if (config.UsePostPlacementPathAvoidance)
                        {
                            structuralRoomSlots = orderedRoomSlots.Where(s => !IsFreestandingDecorSlot(s, allTiles, configKey)).ToList();
                            decorRoomSlots = orderedRoomSlots.Where(s => IsFreestandingDecorSlot(s, allTiles, configKey)).ToList();
                        }

                        foreach (var slot in structuralRoomSlots)
                            PlaceOrderedSlot(slot, null);

                        if (decorRoomSlots.Count > 0)
                        {
                            // Computed AFTER all structural (collision + anchor-coupled) furniture is
                            // placed, so the path reflects the room as actually furnished — see
                            // RoomTypeConfig.UsePostPlacementPathAvoidance.
                            var decorPathCells = ComputePostPlacementPathCells(roomCells, doorCells, physicalOccupied);
                            if (decorPathCells.Count > 0)
                                log.Add($"  [PATH] post-placement path ({decorPathCells.Count} cells) applied to {decorRoomSlots.Count} freestanding decor slot(s)");
                            foreach (var slot in decorRoomSlots)
                                PlaceOrderedSlot(slot, decorPathCells.Count > 0 ? decorPathCells : null);
                        }

                        var missingRequired = poolSlots.Where(s => s.Required).Count(s => !anchorMap.ContainsKey(s.Id));
                        if (missingRequired == 0)
                        {
                            if (countStep > 0)
                                log.Add($"  [LAYOUT-FALLBACK] '{layoutVariant!.Id}': step {countStep} placed all required pool slots");
                            break;
                        }
                        if (countStep < fallbackMaxStep)
                            log.Add($"  [LAYOUT-FALLBACK] '{layoutVariant!.Id}': step {countStep} missing {missingRequired} required pool slot(s), retrying with fewer pool slot(s)");
                    }

                    // After furnishing: record which opening-adjacent cells are now blocked so
                    // later rooms shrink their effective opening group on the opposing side.
                    if (!crossRoomBlockedPerFloor.TryGetValue(sel.FloorIndex, out var crb))
                        crossRoomBlockedPerFloor[sel.FloorIndex] = crb = new HashSet<(int, int)>();
                    foreach (var edge in floor.Edges.Where(e => e.Type == FloorObjectType.Opening))
                    {
                        var c1 = (edge.Cell1Col, edge.Cell1Row);
                        var c2 = (edge.Cell2Col, edge.Cell2Row);
                        if (roomCells.Contains(c1) && occupied.Contains(c1)) crb.Add(c2);
                        if (roomCells.Contains(c2) && occupied.Contains(c2)) crb.Add(c1);
                    }
                }
            }
            finally
            {
                // A cancelled room is incomplete — don't report it as finished.
                if (progress is not null && !ct.IsCancellationRequested)
                {
                    var newPlacements = placements.GetRange(placementsBefore, placements.Count - placementsBefore);
                    var newLog        = log.GetRange(logBefore, log.Count - logBefore);
                    progress.RoomFinished(selIndex, total, sel,
                        newPlacements,
                        reservedZones.GetRange(zonesBefore, reservedZones.Count - zonesBefore),
                        newLog,
                        skipped: newPlacements.Count == 0 && newLog.Any(l => l.StartsWith("[SKIP]")));
                }
            }
        }

        return new FurnishResult(placements, log, reservedZones);
    }

    // =========================================================================
    // Slot selection
    // =========================================================================

    /// <summary>
    /// Reserved pseudo-category in AllowedCategories: weighted like any other category, but when
    /// rolled for a slot instance that instance places nothing (see SelectSlots). Never a real tile Group.
    /// </summary>
    private const string EmptyCategory = "__empty__";

    /// <summary>True if the slot restricts to at least one real category (ignoring EmptyCategory).</summary>
    private static bool HasRealCategories(RoomTypeSlot slot) =>
        slot.AllowedCategories.Keys.Any(k => k != EmptyCategory);

    /// <summary>True if the slot can place at least one instance in a room of this size (Max -1 = unlimited).</summary>
    private static bool AvailableForSize(RoomTypeSlot slot, string roomSize) =>
        slot.CountBySize.TryGetValue(roomSize, out var cnt) && (cnt.Max == -1 || cnt.Max > 0);

    private static List<(RoomTypeSlot slot, int count)> SelectSlots(
        RoomTypeConfig config, string roomSize, Random rng, List<string> log,
        IReadOnlyDictionary<string, TileDefinition> allTiles, string roomTypeName,
        double density = 1.0, IReadOnlyCollection<string>? allowedSlotIds = null,
        IReadOnlyDictionary<string, RugDefinition>? rugCatalog = null,
        HashSet<(int, int)>? roomCells = null)
    {
        var result       = new List<(RoomTypeSlot, int)>();
        var groupWinners = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var candidateSlots = allowedSlotIds is null || allowedSlotIds.Count == 0
            ? config.Slots
            : config.Slots.Where(s => allowedSlotIds.Contains(s.Id)).ToList();

        // A rug slot's candidates come from the rug catalog, not FilterTiles/allTiles — see
        // PlaceSlot's identical branch. Mirrored here so a rug slot inside a SlotGroupId
        // ("one of N rug variants") isn't wrongly pre-filtered out as having zero tiles.
        bool HasCandidates(RoomTypeSlot s) =>
            s.RugSlot is not null && rugCatalog is not null && roomCells is not null
                ? BuildRugCandidates(rugCatalog, s, roomTypeName, roomCells).Count > 0
                : FilterTiles(allTiles, s, roomTypeName).Count > 0;

        // Resolve group variants: one winner per SlotGroupId
        foreach (var grp in candidateSlots
            .Where(s => !string.IsNullOrEmpty(s.SlotGroupId))
            .GroupBy(s => s.SlotGroupId!, StringComparer.OrdinalIgnoreCase))
        {
            var allVariants = grp.ToList();
            // Variants without a count for this room size would win the roll and then place
            // nothing — drop them first so only size-eligible variants compete (as grids do).
            var sizedVariants = allVariants.Where(s => AvailableForSize(s, roomSize)).ToList();
            if (sizedVariants.Count == 0)
            {
                log.Add($"  [GROUP] '{grp.Key}': none of {allVariants.Count} variant(s) available for size '{roomSize}', skipping group");
                continue;
            }
            if (sizedVariants.Count < allVariants.Count)
            {
                var excludedBySize = string.Join(", ", allVariants.Except(sizedVariants).Select(s => s.Id));
                log.Add($"  [GROUP] '{grp.Key}': {allVariants.Count - sizedVariants.Count} of {allVariants.Count} variant(s) excluded for size '{roomSize}' ({excludedBySize})");
                allVariants = sizedVariants;
            }
            // Pre-filter to variants the active tile set can actually satisfy — FilterTiles is
            // pure/deterministic (no RNG), so this runs before the weighted roll instead of
            // rolling a winner blind and silently losing the whole group if it has no tiles.
            var variants = allVariants.Where(HasCandidates).ToList();
            if (variants.Count == 0)
            {
                log.Add($"  [GROUP] '{grp.Key}': all {allVariants.Count} variant(s) have no matching tiles for active tile set, skipping group");
                continue;
            }
            if (variants.Count < allVariants.Count)
            {
                var excluded = string.Join(", ", allVariants.Except(variants).Select(s => s.Id));
                log.Add($"  [GROUP] '{grp.Key}': {allVariants.Count - variants.Count} of {allVariants.Count} variant(s) excluded as unavailable in active tile set ({excluded})");
            }
            var totalW = variants.Sum(s => s.GroupWeight);
            if (totalW <= 0) totalW = variants.Count;
            int acc = 0, roll = rng.Next(totalW);
            var winner = variants[0];
            foreach (var v in variants) { acc += v.GroupWeight; if (roll < acc) { winner = v; break; } }
            groupWinners.Add(winner.Id);
            log.Add($"  [GROUP] '{grp.Key}': chose '{winner.Id}' ({winner.GroupWeight}/{totalW})");
        }

        // Eligible = ungrouped + group winners; required first, then by priority.
        // Equal Required+Priority ties get a random tertiary key so scarce space doesn't
        // always favor whichever slot happens to be declared first in room-types.json.
        foreach (var slot in candidateSlots
            .Where(s => string.IsNullOrEmpty(s.SlotGroupId) || groupWinners.Contains(s.Id))
            .OrderByDescending(s => s.Required).ThenBy(s => s.Priority).ThenBy(_ => rng.Next()))
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

            // EmptyCategory: each instance above the guaranteed minimum rolls against the real
            // categories' combined weight; an "empty" roll drops that instance entirely (replaces
            // the old dummy-slot-in-one-of-group workaround for variation at 100% density).
            if (count > 0 && slot.AllowedCategories.TryGetValue(EmptyCategory, out var emptyW) && emptyW > 0)
            {
                int realW = slot.AllowedCategories.Where(kv => kv.Key != EmptyCategory).Sum(kv => Math.Max(0, kv.Value));
                if (realW <= 0) realW = 5;
                int guaranteed = slot.Required ? Math.Max(cnt.Min, 1) : cnt.Min;
                int rolled = 0, skipped = 0;
                for (int i = guaranteed; i < count; i++, rolled++)
                    if (rng.Next(emptyW + realW) < emptyW) skipped++;
                if (rolled > 0)
                    log.Add($"  [EMPTY] '{slot.Id}': {skipped} of {rolled} instance(s) rolled empty ({emptyW}/{emptyW + realW})");
                count -= skipped;
            }

            if (count <= 0) continue;

            result.Add((slot, count));
            log.Add($"  [SLOT] '{slot.Id}' ({slot.Label}): {count}× (min {cnt.Min}, max {max}, density {density:P0})");
        }

        return result;
    }

    /// <summary>Visual "====Floor N - RoomName====" divider so each room's log section is easy to spot.</summary>
    private static string RoomSeparatorLine(int floorIndex, string roomName)
    {
        const int totalWidth = 70;
        var label = $"Floor {floorIndex} - {roomName}";
        int pad = Math.Max(totalWidth - label.Length, 8);
        int padLeft = pad / 2;
        int padRight = pad - padLeft;
        return new string('=', padLeft) + label + new string('=', padRight);
    }

    private static LayoutVariant? SelectLayoutVariant(RoomTypeConfig config, Random rng, List<string> log)
    {
        if (config.LayoutVariants is null || config.LayoutVariants.Count == 0)
            return null;

        var variants = config.LayoutVariants
            .Where(v => !string.IsNullOrWhiteSpace(v.Id) && !v.Disabled)
            .ToList();

        if (variants.Count == 0)
            return null;

        int totalWeight = variants.Sum(v => Math.Max(1, v.Weight));
        if (totalWeight <= 0) totalWeight = variants.Count;

        int roll = rng.Next(totalWeight);
        int acc = 0;
        var chosen = variants[0];
        foreach (var v in variants)
        {
            acc += Math.Max(1, v.Weight);
            if (roll < acc) { chosen = v; break; }
        }

        log.Add($"  [LAYOUT] chose '{chosen.Id}' ({chosen.Weight}/{totalWeight})" +
                (string.IsNullOrWhiteSpace(chosen.Label) ? string.Empty : $" – {chosen.Label}"));
        return chosen;
    }

    private static HashSet<string>? BuildLayoutSlotFilter(RoomTypeConfig config, LayoutVariant? variant, List<string>? log = null)
    {
        if (variant is null || variant.SlotIds is null || variant.SlotIds.Count == 0)
            return null;

        var knownSlots = config.Slots
            .Select(s => s.Id)
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var active = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var missingCore = new List<string>();
        // Grid ids may be listed alongside slot ids (see BuildLayoutGridFilter): not slots, not "missing".
        var gridIds = config.Grids.Select(g => g.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);

        foreach (var slotId in variant.SlotIds)
        {
            if (string.IsNullOrWhiteSpace(slotId) || gridIds.Contains(slotId)) continue;
            if (knownSlots.Contains(slotId)) active.Add(slotId);
            else missingCore.Add(slotId);
        }

        var missingCommon = new List<string>();
        foreach (var slotId in config.CommonSlotIds ?? [])
        {
            if (string.IsNullOrWhiteSpace(slotId) || gridIds.Contains(slotId)) continue;
            if (knownSlots.Contains(slotId)) active.Add(slotId);
            else missingCommon.Add(slotId);
        }

        if (missingCore.Count > 0 && log is not null)
            log.Add($"  [LAYOUT] '{variant.Id}': missing core slots ignored [{string.Join(", ", missingCore)}]");

        if (missingCommon.Count > 0 && log is not null)
            log.Add($"  [LAYOUT] '{variant.Id}': missing common slots ignored [{string.Join(", ", missingCommon)}]");

        if (active.Count == 0)
            return null;

        log?.Add($"  [LAYOUT] '{variant.Id}': active slots (core+common) [{string.Join(", ", active.OrderBy(x => x))}]");
        return active;
    }

    // =========================================================================
    // Composite layout solver (Option A)
    // =========================================================================

    private sealed class LayoutPlacementState
    {
        public HashSet<(int, int)> Occupied { get; }
        public HashSet<(int, int)> SoftOccupied { get; }
        public HashSet<(int, int)> PhysicalOccupied { get; }
        public HashSet<(int, int)> BlockedFrontCells { get; }
        /// <summary>Cells occupied by a FloorFurniture-layer tile with no collision — exempt from BlocksFrontCell.</summary>
        public HashSet<(int, int)> FrontExemptCells { get; }
        /// <summary>Cell → properties another slot's tile must ALL have to share that cell (from CellRequiredProperties).</summary>
        public Dictionary<(int, int), HashSet<string>> CellPropertyGates { get; }
        /// <summary>Read-only reserved-zone cells (e.g. "Car" spot) — see BlockedByReservedZone.</summary>
        public HashSet<(int, int)> ReservedZoneCells { get; }
        /// <summary>Read-only 1-wide cells only wall/floor-layer tiles may use — see FitsFootprint.</summary>
        public HashSet<(int, int)>? NarrowCells { get; init; }
        public Dictionary<string, (int col, int row, int fpW, int fpH, string orient)> AnchorMap { get; }
        public Dictionary<string, string> ColorMap { get; }
        public Dictionary<string, string> VariantMap { get; }
        public List<PlacedFurnitureItem> Placements { get; }
        public List<(string SlotId, string TileId, string Orient, int Col, int Row)> SlotPlacements { get; }

        public LayoutPlacementState(
            HashSet<(int, int)> occupied,
            HashSet<(int, int)> softOccupied,
            HashSet<(int, int)> physicalOccupied,
            HashSet<(int, int)> blockedFrontCells,
            HashSet<(int, int)> frontExemptCells,
            Dictionary<(int, int), HashSet<string>> cellPropertyGates,
            HashSet<(int, int)> reservedZoneCells,
            Dictionary<string, (int col, int row, int fpW, int fpH, string orient)> anchorMap,
            Dictionary<string, string> colorMap,
            Dictionary<string, string> variantMap,
            List<PlacedFurnitureItem> placements,
            List<(string SlotId, string TileId, string Orient, int Col, int Row)> slotPlacements)
        {
            Occupied = occupied;
            SoftOccupied = softOccupied;
            PhysicalOccupied = physicalOccupied;
            BlockedFrontCells = blockedFrontCells;
            FrontExemptCells = frontExemptCells;
            CellPropertyGates = cellPropertyGates;
            ReservedZoneCells = reservedZoneCells;
            AnchorMap = anchorMap;
            ColorMap = colorMap;
            VariantMap = variantMap;
            Placements = placements;
            SlotPlacements = slotPlacements;
        }

        public LayoutPlacementState Clone() => new(
            new HashSet<(int, int)>(Occupied),
            new HashSet<(int, int)>(SoftOccupied),
            new HashSet<(int, int)>(PhysicalOccupied),
            new HashSet<(int, int)>(BlockedFrontCells),
            new HashSet<(int, int)>(FrontExemptCells),
            CellPropertyGates.ToDictionary(kv => kv.Key, kv => new HashSet<string>(kv.Value, StringComparer.OrdinalIgnoreCase)),
            ReservedZoneCells, // read-only, shared reference is safe
            new Dictionary<string, (int col, int row, int fpW, int fpH, string orient)>(AnchorMap, StringComparer.OrdinalIgnoreCase),
            new Dictionary<string, string>(ColorMap, StringComparer.OrdinalIgnoreCase),
            new Dictionary<string, string>(VariantMap, StringComparer.OrdinalIgnoreCase),
            new List<PlacedFurnitureItem>(Placements),
            new List<(string SlotId, string TileId, string Orient, int Col, int Row)>(SlotPlacements))
        {
            NarrowCells = NarrowCells, // read-only, shared reference is safe
        };
    }

    private sealed record LayoutPlacementCandidate(
        int Col,
        int Row,
        string Orient,
        TileDefinition Tile,
        string EffectiveColorGroup);

    private static bool TryPlaceCompositeLayout(
        RoomTypeConfig config,
        LayoutVariant chosenVariant,
        IReadOnlyList<LayoutVariant> attemptOrder,
        string roomSize,
        double density,
        int floorIndex,
        HashSet<(int, int)> roomCells,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        HashSet<(int, int)> doorCells,
        HashSet<(int, int)> windowCells,
        HashSet<(int, int)> pathCells,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        Dictionary<string, string> seededColorMap,
        Random rng,
        string roomTypeName,
        int roomIndex1Based,
        int? selectionAnchorCol,
        int? selectionAnchorRow,
        List<PlacedFurnitureItem> placements,
        List<string> log,
        HashSet<string>? innerWallKeys,
        HashSet<(int, int)>? mainSubRoomCells,
        List<HashSet<(int, int)>>? openingGroups,
        HashSet<(int, int)> reservedZoneCells,
        HashSet<(int, int)> gapCells,
        HashSet<(int, int)>? narrowCells,
        out LayoutVariant? usedVariant,
        LayoutPlacementState? seedState = null)
    {
        usedVariant = null;
        foreach (var variant in attemptOrder)
        {
            var attemptLog = new List<string>();
            var activeSlotIds = BuildLayoutSlotFilter(config, variant, attemptLog);
            if (activeSlotIds is null || activeSlotIds.Count == 0)
                continue;

            var slotsBase = SelectSlots(config, roomSize, rng, attemptLog, allTiles, roomTypeName, density, activeSlotIds);

            // Compute max count-step range across all pools for this variant
            int maxStep = (variant.Pools ?? [])
                .Select(p => p.TotalCountBySize.TryGetValue(roomSize, out var r) ? Math.Max(0, r.Max - r.Min) : 0)
                .DefaultIfEmpty(0).Max();

            bool variantSucceeded = false;
            for (int countStep = 0; countStep <= maxStep; countStep++)
            {
                // Log per-pool counts being attempted at this step
                if (variant.Pools?.Count > 0)
                {
                    var countInfo = string.Join(", ", variant.Pools
                        .Select(p =>
                        {
                            if (!p.TotalCountBySize.TryGetValue(roomSize, out var r)) return null;
                            var n = Math.Max(r.Min, r.Max - countStep);
                            return r.Max > r.Min ? $"{p.Id}={n} (range {r.Min}–{r.Max})" : $"{p.Id}={n}";
                        })
                        .Where(s => s is not null));
                    if (!string.IsNullOrEmpty(countInfo))
                        attemptLog.Add($"  [LAYOUT] '{variant.Id}' step {countStep}: pool counts — {countInfo}");
                }

                // Expand pool slots at current count step and merge
                var poolSlots = ExpandPoolSlots(variant, roomSize, countStep, rng, attemptLog, allTiles, roomTypeName, density);
                var slotsToPlace = poolSlots.Count > 0
                    ? [..slotsBase, ..poolSlots.Select(s => (s, 1))]
                    : slotsBase;

                if (slotsToPlace.Count == 0)
                {
                    log.Add($"  [LAYOUT] '{variant.Id}': no slots selected for full-fit attempt");
                    break;
                }

                if (!TryPlaceCompositeLayoutVariant(
                        variant,
                        slotsToPlace,
                        floorIndex,
                        roomCells,
                        cellWalls,
                        doorCells,
                        windowCells,
                        pathCells,
                        allTiles,
                        config,
                        seededColorMap,
                        rng,
                        roomTypeName,
                        roomIndex1Based,
                        selectionAnchorCol,
                        selectionAnchorRow,
                        innerWallKeys,
                        mainSubRoomCells,
                        openingGroups,
                        reservedZoneCells,
                        gapCells,
                        narrowCells,
                        out var layoutPlacements,
                        out var placementLog,
                        out var visitedNodes,
                        seedState))
                {
                    var stepNote = countStep < maxStep ? $", retrying with {countStep + 1} fewer pool slot(s)" : string.Empty;
                    log.Add($"  [LAYOUT] '{variant.Id}': full-fit attempt failed after {visitedNodes} search nodes{stepNote}");
                    continue;
                }

                // Full-fit succeeded at this count step
                if (!variant.Id.Equals(chosenVariant.Id, StringComparison.OrdinalIgnoreCase))
                {
                    log.Add($"  [LAYOUT] full-fit switched from '{chosenVariant.Id}' to '{variant.Id}'" +
                            (string.IsNullOrWhiteSpace(variant.Label) ? string.Empty : $" – {variant.Label}"));
                }
                usedVariant = variant;
                foreach (var line in attemptLog)
                    log.Add(line);
                foreach (var line in placementLog)
                    log.Add(line);
                placements.AddRange(layoutPlacements);
                variantSucceeded = true;
                break;
            } // end count-step loop

            if (variantSucceeded) return true;
        }

        log.Add("  [LAYOUT] full-fit solver found no complete placement for the configured variants – falling back to slot-by-slot placement");
        return false;
    }

    private static bool TryPlaceCompositeLayoutVariant(
        LayoutVariant variant,
        List<(RoomTypeSlot slot, int count)> slotsToPlace,
        int floorIndex,
        HashSet<(int, int)> roomCells,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        HashSet<(int, int)> doorCells,
        HashSet<(int, int)> windowCells,
        HashSet<(int, int)> pathCells,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        RoomTypeConfig config,
        Dictionary<string, string> seededColorMap,
        Random rng,
        string roomTypeName,
        int roomIndex1Based,
        int? selectionAnchorCol,
        int? selectionAnchorRow,
        HashSet<string>? innerWallKeys,
        HashSet<(int, int)>? mainSubRoomCells,
        List<HashSet<(int, int)>>? openingGroups,
        HashSet<(int, int)> reservedZoneCells,
        HashSet<(int, int)> gapCells,
        HashSet<(int, int)>? narrowCells,
        out List<PlacedFurnitureItem> layoutPlacements,
        out List<string> placementLog,
        out int visitedNodes,
        LayoutPlacementState? seedState = null)
    {
        var orderedSlots = ExpandLayoutSlotSequence(slotsToPlace);
        var initialState = seedState?.Clone() ?? new LayoutPlacementState(
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

        // UsePostPlacementPathAvoidance: freestanding decor (no AnchorRules, no collision on any
        // candidate tile — e.g. plants/lamps/pictures, but NOT lamp→nightstand/mirror→counter,
        // which stay anchor-coupled to their structural target) is solved in a separate pass
        // AFTER all structural furniture, so the walking-path computed in between reflects the
        // room as actually furnished. When the flag is off (default) this is a single unchanged
        // SearchCompositeLayout call over the full slot list, identical to prior behavior.
        var structuralSlots = orderedSlots;
        var decorSlots = new List<RoomTypeSlot>();
        if (config.UsePostPlacementPathAvoidance)
        {
            structuralSlots = orderedSlots.Where(s => !IsFreestandingDecorSlot(s, allTiles, roomTypeName)).ToList();
            decorSlots = orderedSlots.Where(s => IsFreestandingDecorSlot(s, allTiles, roomTypeName)).ToList();
        }

        visitedNodes = 0;
        if (!SearchCompositeLayout(
                0,
                structuralSlots,
                initialState,
                floorIndex,
                roomCells,
                cellWalls,
                doorCells,
                windowCells,
                pathCells,
                allTiles,
                config,
                rng,
                roomTypeName,
                roomIndex1Based,
                selectionAnchorCol,
                selectionAnchorRow,
                innerWallKeys,
                mainSubRoomCells,
                openingGroups,
                gapCells,
                ref visitedNodes,
                out var finalState))
        {
            layoutPlacements = [];
            placementLog = [];
            return false;
        }

        placementLog = [];
        if (decorSlots.Count > 0)
        {
            var decorPathCells = ComputePostPlacementPathCells(roomCells, doorCells, finalState.PhysicalOccupied);
            int decorVisited = 0;
            bool decorOk = SearchCompositeLayout(
                0, decorSlots, finalState.Clone(), floorIndex, roomCells, cellWalls, doorCells, windowCells,
                pathCells, allTiles, config, rng, roomTypeName, roomIndex1Based, selectionAnchorCol, selectionAnchorRow,
                innerWallKeys, mainSubRoomCells, openingGroups, gapCells, ref decorVisited, out var decorState,
                decorPathCells.Count > 0 ? decorPathCells : null);

            if (!decorOk && decorPathCells.Count > 0)
            {
                // Graceful degrade: the new path constraint may have starved an otherwise-valid
                // decor placement in a tight room — retry unconstrained before failing the whole
                // variant over something that isn't structural furniture's fault.
                decorVisited = 0;
                decorOk = SearchCompositeLayout(
                    0, decorSlots, finalState.Clone(), floorIndex, roomCells, cellWalls, doorCells, windowCells,
                    pathCells, allTiles, config, rng, roomTypeName, roomIndex1Based, selectionAnchorCol, selectionAnchorRow,
                    innerWallKeys, mainSubRoomCells, openingGroups, gapCells, ref decorVisited, out decorState, null);
            }

            if (!decorOk)
            {
                layoutPlacements = [];
                placementLog = [];
                return false;
            }

            finalState = decorState;
            visitedNodes += decorVisited;
            if (decorPathCells.Count > 0)
                placementLog.Add($"  [PATH] '{variant.Id}': post-placement path ({decorPathCells.Count} cells) applied to {decorSlots.Count} freestanding decor slot(s)");
        }

        layoutPlacements = finalState.Placements;
        placementLog.Add($"  [LAYOUT] '{variant.Id}': full-fit solver placed a complete layout ({orderedSlots.Count} slot instances, {visitedNodes} search nodes)");
        foreach (var placement in finalState.SlotPlacements)
            placementLog.Add($"  [PLACED] '{placement.SlotId}': '{placement.TileId}' orient '{placement.Orient}' at ({placement.Col},{placement.Row})");

        return true;
    }

    private static List<RoomTypeSlot> ExpandLayoutSlotSequence(List<(RoomTypeSlot slot, int count)> slotsToPlace)
    {
        var indexed = slotsToPlace
            .Select((entry, index) => new { entry.slot, entry.count, index })
            .ToList();

        var slotById = indexed
            .Where(x => !string.IsNullOrWhiteSpace(x.slot.Id))
            .GroupBy(x => x.slot.Id, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.First().slot, StringComparer.OrdinalIgnoreCase);

        // RequiresSlot/AnchorTarget may reference either a slot Id or a SlotGroupId (see
        // RoomTypeConfig.RequiresSlot doc comment) — only one winner per group survives into
        // slotsToPlace by this point, so this is a straightforward 1:1 lookup.
        var slotByGroupId = indexed
            .Where(x => !string.IsNullOrWhiteSpace(x.slot.SlotGroupId))
            .GroupBy(x => x.slot.SlotGroupId, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.First().slot, StringComparer.OrdinalIgnoreCase);

        RoomTypeSlot? ResolveSlot(string id) =>
            slotById.TryGetValue(id, out var byId) ? byId :
            slotByGroupId.TryGetValue(id, out var byGroup) ? byGroup : null;

        var depthCache = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

        int ComputeDepth(RoomTypeSlot slot, HashSet<string> visiting)
        {
            if (string.IsNullOrWhiteSpace(slot.Id)) return 0;
            if (depthCache.TryGetValue(slot.Id, out var cached)) return cached;
            if (!visiting.Add(slot.Id)) return 0;

            int depth = 0;
            if (!string.IsNullOrWhiteSpace(slot.RequiresSlot)
                && ResolveSlot(slot.RequiresSlot) is { } requiresParent)
            {
                depth = Math.Max(depth, ComputeDepth(requiresParent, visiting) + 1);
            }

            foreach (var anchorTarget in slot.AnchorRules
                         .Select(r => r.AnchorTarget)
                         .Where(t => !string.IsNullOrWhiteSpace(t))
                         .Distinct(StringComparer.OrdinalIgnoreCase))
            {
                if (ResolveSlot(anchorTarget) is { } anchorParent)
                    depth = Math.Max(depth, ComputeDepth(anchorParent, visiting) + 1);
            }

            // A matchAnchorCluster rug's bounding box depends on EVERY sibling that also
            // requires the same parent (e.g. all 4 of a table's chairs, not just the required
            // ones) — RequiresSlot alone only orders it after the parent itself. Without this,
            // two same-depth optional siblings (e.g. an optional head/foot chair placed after an
            // optional rug slot, per plain JSON array order) can leave the rug computing its
            // cluster bounds before that chair exists, silently under-sizing it.
            if (slot.RugSlot?.Sizing.Mode.Equals("matchAnchorCluster", StringComparison.OrdinalIgnoreCase) == true
                && !string.IsNullOrWhiteSpace(slot.RequiresSlot))
            {
                foreach (var sibling in indexed.Select(x => x.slot)
                             .Where(s => !s.Id.Equals(slot.Id, StringComparison.OrdinalIgnoreCase)
                                      && s.RequiresSlot.Equals(slot.RequiresSlot, StringComparison.OrdinalIgnoreCase)))
                {
                    depth = Math.Max(depth, ComputeDepth(sibling, visiting) + 1);
                }
            }

            visiting.Remove(slot.Id);
            depthCache[slot.Id] = depth;
            return depth;
        }

        // Required slots always go before optional ones, full stop — depth/priority/index only
        // break ties within each bucket. Without this, a required slot with a dependency (e.g.
        // an anchored corner counter, depth>0) could sort after an unrelated optional slot
        // (depth 0), letting the optional slot grab a cell the required one geometrically needs.
        return indexed
            .OrderByDescending(x => x.slot.Required)
            .ThenBy(x => ComputeDepth(x.slot, new HashSet<string>(StringComparer.OrdinalIgnoreCase)))
            .ThenBy(x => x.index)
            .SelectMany(x => Enumerable.Range(0, x.count).Select(_ => x.slot))
            .ToList();
    }

    /// <summary>
    /// Expands a variant's Pools into ephemeral RoomTypeSlot instances chained by anchor rules.
    /// Called inside TryPlaceCompositeLayout before the solver runs so pool slots flow through
    /// ExpandLayoutSlotSequence and SearchCompositeLayout unchanged.
    /// </summary>
    private static List<RoomTypeSlot> ExpandPoolSlots(
        LayoutVariant variant, string roomSizeKey, int countStep, Random rng, List<string> log,
        IReadOnlyDictionary<string, TileDefinition> allTiles, string roomTypeName, double density)
    {
        var result = new List<RoomTypeSlot>();
        if (variant.Pools is null || variant.Pools.Count == 0) return result;

        foreach (var pool in variant.Pools)
        {
            if (!pool.TotalCountBySize.TryGetValue(roomSizeKey, out var countRange))
            {
                log.Add($"    [POOL] '{pool.Id}': no count entry for size={roomSizeKey}, skipped");
                continue;
            }
            var totalCount = Math.Max(countRange.Min, countRange.Max - countStep);
            if (totalCount <= 0)
            {
                log.Add($"    [POOL] '{pool.Id}': totalCount=0 for size={roomSizeKey}, skipped");
                continue;
            }

            // Build position-type list: required categories fill the FRONT (anchor-adjacent,
            // most geometrically reliable) region, remainder = null (default category) fills
            // the tail. Chain index doubles as both physical distance from the fixed anchor
            // AND backtracking search-visitation order (see ExpandLayoutSlotSequence's
            // RequiresSlot-depth ordering), so the tail is both the highest-rejection-risk
            // position (most likely to hit a door/opening/wall-end) and the first thing
            // countStep sacrifices on retry — required categories must never land there.
            // Only the required entries are shuffled among themselves (relative order variety);
            // default entries are all identical (pool.DefaultCategories) so shuffling them is a
            // no-op and skipped.
            // Truncation order: highest Weight first (stable tie-break on declaration
            // order), so when a pool is too small to fit every required category, the
            // lowest-weight categories are sacrificed first instead of whichever happens
            // to be declared last in room-types.json.
            var requiredEntries = new List<LayoutPoolRequiredSlot>();
            var droppedLabels = new List<string>();
            int rawRequiredTotal = pool.RequiredSlots.Sum(rs => rs.Count);
            foreach (var rs in pool.RequiredSlots.OrderByDescending(rs => rs.Weight))
            {
                int placed = 0;
                for (; placed < rs.Count && requiredEntries.Count < totalCount; placed++)
                    requiredEntries.Add(rs);
                if (placed < rs.Count)
                    droppedLabels.Add(rs.Count > 1 ? $"{rs.Label} (x{rs.Count - placed})" : rs.Label);
            }
            if (rawRequiredTotal > totalCount)
                log.Add($"    [POOL-WARN] '{pool.Id}': sum of required counts ({rawRequiredTotal}) exceeds totalCount ({totalCount}), dropped: {string.Join(", ", droppedLabels)}");

            var positionTypes = new List<LayoutPoolRequiredSlot?>(ShuffleCopy(requiredEntries, rng));
            while (positionTypes.Count < totalCount)
                positionTypes.Add(null);
            int sumRequired = requiredEntries.Count;

            log.Add($"    [POOL] '{pool.Id}': expanding {totalCount} slots ({sumRequired} required, {totalCount - sumRequired} default)");

            for (int i = 0; i < totalCount; i++)
            {
                var slotId       = $"{pool.Id}_{i}";
                var rs           = positionTypes[i];
                var anchorTarget = i == 0 ? pool.AnchorTarget : $"{pool.Id}_{i - 1}";
                var anchorPos    = i == 0 ? pool.FirstAnchorPosition : pool.ChainAnchorPosition;
                var anchorOrient = i == 0
                    ? (string.IsNullOrEmpty(pool.FirstOrient) ? "match" : pool.FirstOrient)
                    : (string.IsNullOrEmpty(pool.ChainOrient) ? "match" : pool.ChainOrient);
                var layer        = rs is not null && !string.IsNullOrEmpty(rs.RequiredLayer)
                    ? rs.RequiredLayer : pool.RequiredLayer;

                var slot = new RoomTypeSlot
                {
                    Id                 = slotId,
                    Label              = rs is not null ? rs.Label : $"{pool.Label} {i + 1}",
                    Footprint          = new SlotFootprint { Width = 1, Height = 1, CanRotate = false },
                    Required           = true,
                    Priority           = 0,
                    CountBySize        = [],
                    AllowedCategories  = rs is not null
                        ? new Dictionary<string, int> { [rs.Category] = rs.Weight }
                        : new Dictionary<string, int>(pool.DefaultCategories),
                    PlacementRules     = pool.PlacementRules,
                    RequiredLayer      = layer,
                    RequiredProperties = rs is not null ? [..rs.RequiredProperties] : [..pool.RequiredProperties],
                    AnchorRules        = [new AnchorRule { AnchorTarget = anchorTarget, Positions = [anchorPos], Orient = anchorOrient }],
                    RequiresSlot       = anchorTarget,
                    BlocksFrontCell    = rs?.BlocksFrontCell ?? pool.BlocksFrontCell,
                    BlocksPlacement    = rs?.BlocksPlacement ?? pool.BlocksPlacement,
                    SoftBlocks         = rs?.SoftBlocks ?? pool.SoftBlocks,
                    CellRequiredProperties = rs is not null ? [..rs.CellRequiredProperties] : [..pool.CellRequiredProperties],
                    ColorGroupId       = pool.ColorGroupId,
                    MaterialGroupId    = pool.MaterialGroupId,
                    TileGroupId        = pool.TileGroupId,
                    SlotGroupId        = string.Empty,
                    SlotGroupMode      = string.Empty,
                    GroupWeight        = 5,
                    FallbackRules      = rs?.FallbackRules ?? [],
                };
                result.Add(slot);

                // Spawn companion slots for required types that have them, or for default
                // filler positions via the pool's DefaultCompanions.
                var companionSource = rs is not null ? rs.Companions : pool.DefaultCompanions;
                if (companionSource is { Count: > 0 } companions)
                {
                    // Resolve "one-of" companion groups: companions sharing a non-empty SlotGroupId
                    // are alternatives, not additions — roll exactly one winner (weighted by
                    // GroupWeight), same convention as RoomTypeSlot.SlotGroupId/GroupWeight above.
                    // Ungrouped companions (SlotGroupId empty) are still all placed, as before.
                    // Same tile-availability pre-filter as SelectSlots' SlotGroupId resolution —
                    // a companion variant with zero matching tiles in the active tile set can
                    // never win, even if its weight roll would have picked it.
                    bool CompanionHasTiles(LayoutPoolCompanion c) => FilterTiles(allTiles, new RoomTypeSlot
                    {
                        Id                = "__probe__",
                        Label             = c.Label,
                        Footprint         = new SlotFootprint { Width = 1, Height = 1, CanRotate = false },
                        AllowedCategories = c.AllowedCategories,
                        RequiredLayer     = c.RequiredLayer,
                        RequiredProperties = c.RequiredProperties,
                    }, roomTypeName).Count > 0;

                    var companionGroupWinners = new HashSet<int>();
                    foreach (var grp in companions
                        .Select((c, ci) => (c, ci))
                        .Where(t => !string.IsNullOrEmpty(t.c.SlotGroupId))
                        .GroupBy(t => t.c.SlotGroupId, StringComparer.OrdinalIgnoreCase))
                    {
                        var allVariants = grp.ToList();
                        var variants = allVariants.Where(t => CompanionHasTiles(t.c)).ToList();
                        if (variants.Count == 0)
                        {
                            log.Add($"    [GROUP] '{slotId}' companion group '{grp.Key}': all {allVariants.Count} variant(s) have no matching tiles for active tile set, skipping group");
                            continue;
                        }
                        if (variants.Count < allVariants.Count)
                        {
                            var excluded = string.Join(", ", allVariants.Except(variants).Select(t => t.c.Label));
                            log.Add($"    [GROUP] '{slotId}' companion group '{grp.Key}': {allVariants.Count - variants.Count} of {allVariants.Count} variant(s) excluded as unavailable in active tile set ({excluded})");
                        }
                        var totalW   = variants.Sum(t => t.c.GroupWeight);
                        if (totalW <= 0) totalW = variants.Count;
                        int acc = 0, roll = rng.Next(totalW);
                        var winner = variants[0];
                        foreach (var v in variants) { acc += v.c.GroupWeight; if (roll < acc) { winner = v; break; } }
                        companionGroupWinners.Add(winner.ci);
                        log.Add($"    [GROUP] '{slotId}' companion group '{grp.Key}': chose '{winner.c.Label}' ({winner.c.GroupWeight}/{totalW})");
                    }

                    for (int ci = 0; ci < companions.Count; ci++)
                    {
                        var c = companions[ci];
                        if (!string.IsNullOrEmpty(c.SlotGroupId) && !companionGroupWinners.Contains(ci))
                            continue;
                        // Non-required companions (e.g. a hanging counter above a floor counter)
                        // are density-gated like an ordinary optional 0-1 slot (SelectSlots' own
                        // single-optional-slot branch) instead of always being attempted — this
                        // is what makes "how many counters get a hanging companion" scale with
                        // density instead of always being every placed counter.
                        if (!c.Required && rng.NextDouble() >= density)
                            continue;
                        var companionId = $"{slotId}_companion_{ci}";
                        result.Add(new RoomTypeSlot
                        {
                            Id                 = companionId,
                            Label              = c.Label,
                            Footprint          = new SlotFootprint { Width = 1, Height = 1, CanRotate = false },
                            Required           = c.Required,
                            Priority           = 0,
                            CountBySize        = [],
                            AllowedCategories  = new Dictionary<string, int>(c.AllowedCategories),
                            PlacementRules     = pool.PlacementRules,
                            RequiredLayer      = c.RequiredLayer,
                            RequiredProperties = [..c.RequiredProperties],
                            AnchorRules        = [new AnchorRule { AnchorTarget = slotId, Positions = [c.AnchorPosition], Orient = c.Orient }],
                            RequiresSlot       = slotId,
                            BlocksFrontCell    = c.BlocksFrontCell,
                            BlocksPlacement    = c.BlocksPlacement,
                            SoftBlocks         = c.SoftBlocks,
                            CellRequiredProperties = [..c.CellRequiredProperties],
                            ColorGroupId       = string.Empty,
                            MaterialGroupId    = string.Empty,
                            TileGroupId        = c.TileGroupId,
                            RequireTileGroupMatch = c.RequireTileGroupMatch,
                            SlotGroupId        = string.Empty,
                            SlotGroupMode      = string.Empty,
                            GroupWeight        = 5,
                            FallbackRules      = [],
                        });
                    }
                }
            }
        }
        return result;
    }

    private static List<LayoutVariant> BuildLayoutAttemptOrder(RoomTypeConfig config, LayoutVariant chosenVariant, Random rng)
    {
        var pool = config.LayoutVariants
            .Where(v => !string.IsNullOrWhiteSpace(v.Id) && !v.Disabled)
            .ToList();

        var order = new List<LayoutVariant>();
        var preferred = pool.FirstOrDefault(v => v.Id.Equals(chosenVariant.Id, StringComparison.OrdinalIgnoreCase));
        if (preferred is not null)
        {
            order.Add(preferred);
            pool.Remove(preferred);
        }

        while (pool.Count > 0)
        {
            int totalWeight = pool.Sum(v => Math.Max(1, v.Weight));
            int roll = rng.Next(totalWeight);
            int acc = 0;
            int chosenIndex = 0;
            for (int i = 0; i < pool.Count; i++)
            {
                acc += Math.Max(1, pool[i].Weight);
                if (roll < acc)
                {
                    chosenIndex = i;
                    break;
                }
            }

            order.Add(pool[chosenIndex]);
            pool.RemoveAt(chosenIndex);
        }

        return order;
    }

    private static bool SearchCompositeLayout(
        int index,
        IReadOnlyList<RoomTypeSlot> orderedSlots,
        LayoutPlacementState state,
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
        HashSet<(int, int)>? mainSubRoomCells,
        List<HashSet<(int, int)>>? openingGroups,
        HashSet<(int, int)> gapCells,
        ref int visitedNodes,
        out LayoutPlacementState finalState,
        HashSet<(int, int)>? decorPathCells = null)
    {
        if (index >= orderedSlots.Count)
        {
            finalState = state;
            return true;
        }

        visitedNodes++;
        t_cancel.ThrowIfCancellationRequested();
        if (visitedNodes > LayoutSearchNodeLimit)
        {
            finalState = state;
            return false;
        }

        var slot = orderedSlots[index];
        var candidates = EnumerateLayoutPlacementCandidates(
            slot,
            roomCells,
            cellWalls,
            doorCells,
            windowCells,
            pathCells,
            allTiles,
            state,
            config,
            rng,
            roomTypeName,
            innerWallKeys,
            mainSubRoomCells,
            openingGroups,
            gapCells,
            decorPathCells);

        // An optional slot (e.g. a hanging counter above a floor counter) with nowhere to go
        // is simply omitted — it must never sink the whole backtracking branch and force a
        // smaller/worse layout for everything else in it. A required slot still hard-fails
        // this branch (falls through to the empty-candidates case below) exactly as before.
        if (candidates.Count == 0 && !slot.Required)
        {
            return SearchCompositeLayout(
                index + 1,
                orderedSlots,
                state,
                floorIndex,
                roomCells,
                cellWalls,
                doorCells,
                windowCells,
                pathCells,
                allTiles,
                config,
                rng,
                roomTypeName,
                roomIndex1Based,
                selectionAnchorCol,
                selectionAnchorRow,
                innerWallKeys,
                mainSubRoomCells,
                openingGroups,
                gapCells,
                ref visitedNodes,
                out finalState,
                decorPathCells);
        }

        foreach (var candidate in candidates)
        {
            var nextState = state.Clone();
            CommitLayoutPlacement(floorIndex, slot, candidate, roomIndex1Based, selectionAnchorCol, selectionAnchorRow, nextState);
            if (SearchCompositeLayout(
                    index + 1,
                    orderedSlots,
                    nextState,
                    floorIndex,
                    roomCells,
                    cellWalls,
                    doorCells,
                    windowCells,
                    pathCells,
                    allTiles,
                    config,
                    rng,
                    roomTypeName,
                    roomIndex1Based,
                    selectionAnchorCol,
                    selectionAnchorRow,
                    innerWallKeys,
                    mainSubRoomCells,
                    openingGroups,
                    gapCells,
                    ref visitedNodes,
                    out finalState,
                    decorPathCells))
            {
                return true;
            }
        }

        finalState = state;
        return false;
    }

    private static List<LayoutPlacementCandidate> EnumerateLayoutPlacementCandidates(
        RoomTypeSlot slot,
        HashSet<(int, int)> roomCells,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        HashSet<(int, int)> doorCells,
        HashSet<(int, int)> windowCells,
        HashSet<(int, int)> pathCells,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        LayoutPlacementState state,
        RoomTypeConfig config,
        Random rng,
        string roomTypeName,
        HashSet<string>? innerWallKeys = null,
        HashSet<(int, int)>? mainSubRoomCells = null,
        List<HashSet<(int, int)>>? openingGroups = null,
        HashSet<(int, int)>? gapCells = null,
        HashSet<(int, int)>? decorPathCells = null)
    {
        if (!string.IsNullOrEmpty(slot.RequiresSlot)
            && !state.AnchorMap.ContainsKey(slot.RequiresSlot))
        {
            return [];
        }
        if (HasUnresolvedDependentAnchor(slot, state.AnchorMap.ContainsKey))
            return [];

        var (tilePool, effectiveColorGroup) = PrepareLayoutTilePool(slot, allTiles, state, config, roomTypeName);
        if (tilePool.Count == 0)
            return [];

        var orderedTiles = OrderTileCandidatesForLayout(tilePool, slot, rng);
        var result = new List<LayoutPlacementCandidate>();

        var anchorRule = ResolveActiveAnchorRule(slot, state.AnchorMap);
        if (anchorRule is not null)
        {
            var anchorInfo = state.AnchorMap[anchorRule.AnchorTarget];
            var positions = anchorRule.Positions.Count > 0
                ? ShuffleCopy(anchorRule.Positions, rng)
                : [];

            // Anchored placement may land on the anchor target's OWN footprint (e.g. a lamp on
            // its required nightstand, softBlocks=true) — but must still respect OTHER slots'
            // soft-blocked cells. Only exempt the anchor's own footprint instead of ignoring
            // softOccupied for the whole room (see IsValidAnchoredPlacement).
            HashSet<(int, int)> effectiveSoftOccupied = state.SoftOccupied;
            if (state.SoftOccupied.Count > 0)
            {
                effectiveSoftOccupied = new HashSet<(int, int)>(state.SoftOccupied);
                for (int r = 0; r < anchorInfo.fpH; r++)
                    for (int c = 0; c < anchorInfo.fpW; c++)
                        effectiveSoftOccupied.Remove((anchorInfo.col + c, anchorInfo.row + r));
            }

            // Connectivity inputs for the anchored candidates below — fixed for this search node.
            // Protected cells cost a flood fill, so only computed if a candidate gets that far
            // (this runs on every node of the composite search).
            var anchorEntryCells = openingGroups is { Count: > 0 }
                ? new HashSet<(int, int)>(doorCells.Concat(openingGroups.SelectMany(g => g)))
                : doorCells;
            // The anchor's own footprint is exempt (see PlaceSlot's anchored path for why).
            var anchorProtectedCells = new Lazy<HashSet<(int, int)>>(() =>
            {
                var cells = ComputeProtectedCells(roomCells, state.PhysicalOccupied, anchorEntryCells, innerWallKeys);
                for (int r = 0; r < anchorInfo.fpH; r++)
                    for (int c = 0; c < anchorInfo.fpW; c++)
                        cells.Remove((anchorInfo.col + c, anchorInfo.row + r));
                return cells;
            }, LazyThreadSafetyMode.None);

            // Mirrors the free-placement loop below: union candidates found under the primary
            // PlacementRules with any found under FallbackRules entries (e.g. a required pool
            // slot — stove/sink — that can't validly place under its normal rules gets a second
            // chance under a relaxed fallback rule set), rather than stopping at first success.
            foreach (var rules in EnumeratePlacementRuleChain(slot))
            foreach (var baseTile in orderedTiles)
            foreach (var position in positions)
            {
                if (position.Equals("openSidePlacement", StringComparison.OrdinalIgnoreCase))
                {
                    foreach (var side in ComputeOpenSideOrder(anchorInfo.orient))
                    {
                        var orient = ResolveAnchoredOrient(anchorRule.Orient, anchorInfo, position, baseTile, side);
                        var finalTile = ResolveFinalTileForOrient(baseTile, orient, allTiles);
                        int fpW = finalTile.TileLayout.Count > 0 ? (finalTile.TileLayout[0]?.Count ?? 1) : 1;
                        int fpH = finalTile.TileLayout.Count;
                        var pos = ComputeOpenSidePosition(anchorInfo.col, anchorInfo.row, anchorInfo.fpW, anchorInfo.fpH, fpW, fpH, side);
                        if (IsValidAnchoredPlacement(slot, pos.col, pos.row, fpW, fpH, orient, finalTile, roomCells, cellWalls, doorCells, windowCells, pathCells, state.Occupied, state.PhysicalOccupied, state.BlockedFrontCells, innerWallKeys, cellPropertyGates: state.CellPropertyGates, reservedZoneCells: state.ReservedZoneCells, frontExemptCells: state.FrontExemptCells, gapCells: gapCells, rulesOverride: rules, effectiveSoftOccupied: effectiveSoftOccupied, entryCells: anchorEntryCells, protectedCells: anchorProtectedCells, narrowCells: state.NarrowCells))
                            result.Add(new LayoutPlacementCandidate(pos.col, pos.row, orient, finalTile, effectiveColorGroup));
                    }

                    continue;
                }

                if (position.Equals("oppositeWall", StringComparison.OrdinalIgnoreCase))
                {
                    var orient = ResolveAnchoredOrient(anchorRule.Orient, anchorInfo, position, baseTile);
                    var finalTile = ResolveFinalTileForOrient(baseTile, orient, allTiles);
                    int fpW = finalTile.TileLayout.Count > 0 ? (finalTile.TileLayout[0]?.Count ?? 1) : 1;
                    int fpH = finalTile.TileLayout.Count;
                    int minDist = Math.Max(1, anchorRule.MinOppositeWallDistance ?? 1);
                    int maxDist = anchorRule.MaxOppositeWallDistance is int maxCfg && maxCfg > 0
                        ? Math.Max(minDist, maxCfg)
                        : int.MaxValue;
                    foreach (var pos in ComputeOppositeWallCandidates(
                                 anchorInfo.col,
                                 anchorInfo.row,
                                 anchorInfo.fpW,
                                 anchorInfo.fpH,
                                 anchorInfo.orient,
                                 fpW,
                                 fpH,
                                 minDist,
                                 maxDist,
                                 roomCells,
                                 innerWallKeys))
                    {
                        if (IsValidAnchoredPlacement(slot, pos.col, pos.row, fpW, fpH, orient, finalTile, roomCells, cellWalls, doorCells, windowCells, pathCells, state.Occupied, state.PhysicalOccupied, state.BlockedFrontCells, innerWallKeys, cellPropertyGates: state.CellPropertyGates, reservedZoneCells: state.ReservedZoneCells, frontExemptCells: state.FrontExemptCells, gapCells: gapCells, rulesOverride: rules, effectiveSoftOccupied: effectiveSoftOccupied, entryCells: anchorEntryCells, protectedCells: anchorProtectedCells, narrowCells: state.NarrowCells))
                            result.Add(new LayoutPlacementCandidate(pos.col, pos.row, orient, finalTile, effectiveColorGroup));
                    }

                    continue;
                }

                var anchoredOrient = ResolveAnchoredOrient(anchorRule.Orient, anchorInfo, position, baseTile);
                var anchoredTile = ResolveFinalTileForOrient(baseTile, anchoredOrient, allTiles);
                int depW = anchoredTile.TileLayout.Count > 0 ? (anchoredTile.TileLayout[0]?.Count ?? 1) : 1;
                int depH = anchoredTile.TileLayout.Count;
                var anchoredPos = ComputeAnchoredPosition(anchorInfo.col, anchorInfo.row, anchorInfo.fpW, anchorInfo.fpH, depW, depH, position, anchorInfo.orient, anchorRule.OffsetAlongAnchor);
                if (!anchoredPos.HasValue)
                    continue;

                var (col, row) = anchoredPos.Value;
                if (IsValidAnchoredPlacement(slot, col, row, depW, depH, anchoredOrient, anchoredTile, roomCells, cellWalls, doorCells, windowCells, pathCells, state.Occupied, state.PhysicalOccupied, state.BlockedFrontCells, innerWallKeys, cellPropertyGates: state.CellPropertyGates, reservedZoneCells: state.ReservedZoneCells, frontExemptCells: state.FrontExemptCells, gapCells: gapCells, rulesOverride: rules, effectiveSoftOccupied: effectiveSoftOccupied, entryCells: anchorEntryCells, protectedCells: anchorProtectedCells, narrowCells: state.NarrowCells))
                    result.Add(new LayoutPlacementCandidate(col, row, anchoredOrient, anchoredTile, effectiveColorGroup));
            }

            return DistinctLayoutCandidates(result);
        }

        foreach (var placementRules in EnumeratePlacementRuleChain(slot))
        foreach (var baseTile in orderedTiles)
        {
            var candidates = EnumerateFreePlacementCandidates(
                slot,
                baseTile,
                placementRules,
                roomCells,
                cellWalls,
                doorCells,
                windowCells,
                pathCells,
                state.Occupied,
                state.SoftOccupied,
                state.PhysicalOccupied,
                allTiles,
                rng,
                effectiveColorGroup,
                state.BlockedFrontCells,
                innerWallKeys,
                mainSubRoomCells,
                openingGroups,
                state.CellPropertyGates,
                state.ReservedZoneCells,
                state.FrontExemptCells,
                gapCells,
                decorPathCells,
                state.NarrowCells);
            result.AddRange(candidates);
        }

        return DistinctLayoutCandidates(result);
    }

    private static List<LayoutPlacementCandidate> DistinctLayoutCandidates(List<LayoutPlacementCandidate> candidates)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<LayoutPlacementCandidate>();
        foreach (var candidate in candidates)
        {
            var key = $"{candidate.Col}:{candidate.Row}:{candidate.Orient}:{candidate.Tile.TileId}";
            if (seen.Add(key))
                result.Add(candidate);
        }

        return result;
    }

    /// <summary>
    /// A RequiresSlot slot whose anchor rules all point at unplaced targets (e.g. a lamp anchored to
    /// an optional grid bed table that got dropped while the grid itself placed) must be skipped —
    /// otherwise it silently falls back to free placement anywhere in the room. Slots without
    /// RequiresSlot keep that fallback. matchAnchorCluster rugs ignore AnchorRules by design.
    /// </summary>
    private static bool HasUnresolvedDependentAnchor(RoomTypeSlot slot, Func<string, bool> isPlaced)
    {
        if (string.IsNullOrEmpty(slot.RequiresSlot)) return false;
        if (slot.RugSlot?.Sizing.Mode.Equals("matchAnchorCluster", StringComparison.OrdinalIgnoreCase) == true) return false;
        var targets = slot.AnchorRules?.Where(r => !string.IsNullOrEmpty(r.AnchorTarget)).Select(r => r.AnchorTarget).ToList();
        return targets is { Count: > 0 } && !targets.Any(isPlaced);
    }

    private static AnchorRule? ResolveActiveAnchorRule(
        RoomTypeSlot slot,
        Dictionary<string, (int col, int row, int fpW, int fpH, string orient)> anchorMap)
    {
        if (slot.AnchorRules?.Count > 0)
        {
            foreach (var rule in slot.AnchorRules)
            {
                if (!string.IsNullOrEmpty(rule.AnchorTarget) && anchorMap.ContainsKey(rule.AnchorTarget))
                    return rule;
            }
        }

        return null;
    }

    /// <summary>Slot by reference (instances are fixed within a search), room type case-insensitive.</summary>
    private sealed class SlotKeyComparer : IEqualityComparer<(RoomTypeSlot Slot, string RoomType)>
    {
        public bool Equals((RoomTypeSlot Slot, string RoomType) a, (RoomTypeSlot Slot, string RoomType) b) =>
            ReferenceEquals(a.Slot, b.Slot) && string.Equals(a.RoomType, b.RoomType, StringComparison.OrdinalIgnoreCase);
        public int GetHashCode((RoomTypeSlot Slot, string RoomType) k) =>
            HashCode.Combine(System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(k.Slot),
                             StringComparer.OrdinalIgnoreCase.GetHashCode(k.RoomType));
    }

    private static (List<TileDefinition> candidates, string effectiveColorGroup) PrepareLayoutTilePool(
        RoomTypeSlot slot,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        LayoutPlacementState state,
        RoomTypeConfig config,
        string roomTypeName)
    {
        // Shared cached list — ApplyLayoutGroupFilters and the callers only read/copy it.
        var cache = t_layoutPoolCache;
        if (cache is null || !cache.TryGetValue((slot, roomTypeName), out var candidates))
        {
            candidates = FilterTiles(allTiles, slot, roomTypeName);
            cache?.Add((slot, roomTypeName), candidates);
        }
        if (candidates.Count == 0)
            return ([], string.Empty);

        return ApplyLayoutGroupFilters(candidates, slot, state, config);
    }

    /// <summary>Palette entry meaning "every colour the group's members can use".</summary>
    private const string AllColorsToken = "*";

    /// <summary>
    /// Pre-seeds each colour group's lock before any placement, so every member (slot or grid
    /// piece available for this room size) can match it:
    /// • palette "*"   → random among the colours all members share (or all their colours if none are shared);
    /// • palette list  → random among palette ∩ shared colours (whole palette if that's empty);
    /// • no palette    → random among the shared colours when ≥2 coloured members exist.
    /// Without this, the first piece placed locks its own colour, and a member with no tile in that
    /// colour falls back to its unfiltered pool — so the group ends up mixed.
    /// </summary>
    private static Dictionary<string, string> SeedGroupColors(
        RoomTypeConfig config, string roomSize,
        IReadOnlyDictionary<string, TileDefinition> allTiles, string roomTypeName,
        Random rng, List<string> log)
    {
        var seeded = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        string EffectiveGroup(string slotGroup) => slotGroup switch
        {
            "none"             => string.Empty,
            { Length: > 0 } cg => cg,
            _                  => config.ColorGroupId,
        };

        var members = config.Slots
            .Where(s => s.RugSlot is null && AvailableForSize(s, roomSize))
            .Concat(config.Grids
                .Where(g => g.AllowedSizes.Count == 0 || g.AllowedSizes.Any(z => z.Equals(roomSize, StringComparison.OrdinalIgnoreCase)))
                .SelectMany(g => g.Cells.Select(c => BuildGridCellSlot(g, c))))
            .GroupBy(s => EffectiveGroup(s.ColorGroupId), StringComparer.OrdinalIgnoreCase)
            .Where(g => !string.IsNullOrEmpty(g.Key))
            .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.OrdinalIgnoreCase);

        var groupIds = members.Keys.Concat(config.ColorPalettes.Keys).Distinct(StringComparer.OrdinalIgnoreCase);
        foreach (var groupId in groupIds)
        {
            // Colour sets per member; members without coloured tiles never conflict and are skipped.
            var memberColors = (members.GetValueOrDefault(groupId) ?? [])
                .Select(slot => FilterTiles(allTiles, slot, roomTypeName)
                    .SelectMany(t => t.Colors)
                    .Where(c => !string.IsNullOrEmpty(c))
                    .ToHashSet(StringComparer.OrdinalIgnoreCase))
                .Where(set => set.Count > 0)
                .ToList();
            var shared = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var union  = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (memberColors.Count > 0)
            {
                shared.UnionWith(memberColors[0]);
                foreach (var set in memberColors.Skip(1)) shared.IntersectWith(set);
                foreach (var set in memberColors) union.UnionWith(set);
            }

            var palette = (config.ColorPalettes.GetValueOrDefault(groupId) ?? [])
                .Where(c => !string.IsNullOrEmpty(c)).ToList();
            List<string> choices;
            string source;
            if (palette.Contains(AllColorsToken))
            {
                choices = (shared.Count > 0 ? shared : union).ToList();
                source = shared.Count > 0 ? "all, shared by members" : "all, members share none";
            }
            else if (palette.Count > 0)
            {
                var fitting = palette.Where(shared.Contains).ToList();
                choices = fitting.Count > 0 ? fitting : palette;
                source = fitting.Count > 0 && fitting.Count < palette.Count ? "palette ∩ shared" : "palette";
            }
            else if (memberColors.Count >= 2)
            {
                if (shared.Count == 0)
                {
                    log.Add($"    [COLOR] group='{groupId}': members share no colour, first placed piece decides");
                    continue;
                }
                choices = shared.ToList();
                source = $"shared by {memberColors.Count} members";
            }
            else continue; // single coloured member: its first tile may lock freely

            if (choices.Count == 0) continue;
            choices.Sort(StringComparer.OrdinalIgnoreCase); // deterministic per seed
            seeded[groupId] = choices[rng.Next(choices.Count)];
            log.Add($"    [COLOR] group='{groupId}' pre-seeded to '{seeded[groupId]}' ({source}: {string.Join(", ", choices)})");
        }

        return seeded;
    }

    /// <summary>
    /// Colour / tile-group / material narrowing of an already footprint-filtered candidate list
    /// against the locks recorded in <paramref name="state"/>. Split out of PrepareLayoutTilePool
    /// so the grid placer can cache FilterTiles once per cell and re-apply only this cheap part
    /// per candidate position.
    /// </summary>
    private static (List<TileDefinition> candidates, string effectiveColorGroup) ApplyLayoutGroupFilters(
        List<TileDefinition> candidates,
        RoomTypeSlot slot,
        LayoutPlacementState state,
        RoomTypeConfig config)
    {
        var effectiveColorGroup = slot.ColorGroupId switch
        {
            "none"               => string.Empty,
            { Length: > 0 } cg   => cg,
            _                    => config.ColorGroupId,
        };

        if (!string.IsNullOrEmpty(effectiveColorGroup)
            && state.ColorMap.TryGetValue(effectiveColorGroup, out var requiredColor)
            && !string.IsNullOrEmpty(requiredColor))
        {
            var colored = candidates
                .Where(t => t.Colors.Any(c => c.Equals(requiredColor, StringComparison.OrdinalIgnoreCase)))
                .ToList();
            if (colored.Count > 0)
                candidates = colored;
        }

        if (!string.IsNullOrEmpty(slot.TileGroupId)
            && state.VariantMap.TryGetValue(slot.TileGroupId, out var requiredVariantGroup)
            && !string.IsNullOrEmpty(requiredVariantGroup))
        {
            var grouped = candidates
                .Where(t => t.VariantGroup.Equals(requiredVariantGroup, StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (grouped.Count > 0)
                candidates = grouped;
            else if (slot.RequireTileGroupMatch)
                candidates = [];
        }

        if (!string.IsNullOrEmpty(slot.MaterialGroupId)
            && !slot.MaterialGroupId.Equals("none", StringComparison.OrdinalIgnoreCase))
        {
            var matFiltered = candidates
                .Where(t => t.Materials.Any(m => m.Equals(slot.MaterialGroupId, StringComparison.OrdinalIgnoreCase)))
                .ToList();
            if (matFiltered.Count > 0)
                candidates = matFiltered;
        }

        return (candidates, effectiveColorGroup);
    }

    private static List<TileDefinition> OrderTileCandidatesForLayout(List<TileDefinition> candidates, RoomTypeSlot slot, Random rng)
    {
        if (candidates.Count <= 1)
            return candidates.ToList();

        if (!HasRealCategories(slot))
            return ShuffleCopy(candidates, rng);

        var result = new List<TileDefinition>();
        var byGroup = candidates
            .GroupBy(t => t.Group, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.OrdinalIgnoreCase);

        var weightedGroups = slot.AllowedCategories
            .Where(kv => byGroup.ContainsKey(kv.Key))
            .Select(kv => (Group: kv.Key, Weight: Math.Max(1, kv.Value)))
            .ToList();

        while (weightedGroups.Count > 0)
        {
            int totalWeight = weightedGroups.Sum(g => g.Weight);
            int roll = rng.Next(totalWeight);
            int acc = 0;
            int chosenIndex = 0;
            for (int i = 0; i < weightedGroups.Count; i++)
            {
                acc += weightedGroups[i].Weight;
                if (roll < acc)
                {
                    chosenIndex = i;
                    break;
                }
            }

            var group = weightedGroups[chosenIndex].Group;
            result.AddRange(ShuffleCopy(byGroup[group], rng));
            weightedGroups.RemoveAt(chosenIndex);
        }

        foreach (var extra in ShuffleCopy(candidates.Where(t => result.All(r => !r.TileId.Equals(t.TileId, StringComparison.OrdinalIgnoreCase))).ToList(), rng))
            result.Add(extra);

        return result;
    }

    private static IEnumerable<PlacementRules> EnumeratePlacementRuleChain(RoomTypeSlot slot)
    {
        yield return slot.PlacementRules;
        if (slot.FallbackRules is null) yield break;
        foreach (var rules in slot.FallbackRules)
            yield return rules;
    }

    private static List<LayoutPlacementCandidate> EnumerateFreePlacementCandidates(
        RoomTypeSlot slot,
        TileDefinition baseTile,
        PlacementRules rules,
        HashSet<(int, int)> roomCells,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        HashSet<(int, int)> doorCells,
        HashSet<(int, int)> windowCells,
        HashSet<(int, int)> pathCells,
        HashSet<(int, int)> occupied,
        HashSet<(int, int)> softOccupied,
        HashSet<(int, int)> physicalOccupied,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        Random rng,
        string effectiveColorGroup,
        HashSet<(int, int)>? blockedFrontCells = null,
        HashSet<string>? innerWallKeys = null,
        HashSet<(int, int)>? mainSubRoomCells = null,
        List<HashSet<(int, int)>>? openingGroups = null,
        Dictionary<(int, int), HashSet<string>>? cellPropertyGates = null,
        HashSet<(int, int)>? reservedZoneCells = null,
        HashSet<(int, int)>? frontExemptCells = null,
        HashSet<(int, int)>? gapCells = null,
        HashSet<(int, int)>? decorPathCells = null,
        HashSet<(int, int)>? narrowCells = null)
    {
        IEnumerable<(int col, int row)> pool = roomCells;

        if (rules.NearWall)
            pool = pool.Where(c => cellWalls.ContainsKey(c));
        if (rules.NearDoor)
            pool = pool.Where(c => doorCells.Contains(c));
        if (rules.NearWindow)
            pool = pool.Where(c => windowCells.Contains(c));
        if (rules.CornerOnly)
            pool = pool.Where(c => cellWalls.TryGetValue(c, out var w) && w.Count >= 2);
        if (rules.AvoidCorners)
            pool = pool.Where(c => !(cellWalls.TryGetValue(c, out var w) && w.Count >= 2));
        if (!rules.AllowOnPath && baseTile.HasCollision && pathCells.Count > 0)
            pool = pool.Where(c => !pathCells.Contains(c));
        if (rules.MainSubRoom && mainSubRoomCells != null)
            pool = pool.Where(c => mainSubRoomCells.Contains(c));

        var poolList = pool.Distinct().ToList();
        if (rules.CenterRoom)
        {
            float cx = roomCells.Average(c => (float)c.Item1);
            float cy = roomCells.Average(c => (float)c.Item2);
            poolList = poolList
                .OrderBy(c => Math.Abs(c.Item1 - cx) + Math.Abs(c.Item2 - cy) + rng.NextDouble() * 0.9)
                .ToList();
        }
        else
        {
            poolList = ShuffleCopy(poolList, rng);
        }

        // entryCells/protectedCells are invariant across the candidate loop below (they only
        // depend on physicalOccupied, which doesn't change until a slot is actually placed),
        // so compute them once here instead of per-candidate.
        var entryCells = openingGroups is { Count: > 0 }
            ? new HashSet<(int, int)>(doorCells.Concat(openingGroups.SelectMany(g => g)))
            : doorCells;
        var protectedCells = ComputeProtectedCells(roomCells, physicalOccupied, entryCells, innerWallKeys);

        var result = new List<LayoutPlacementCandidate>();
        foreach (var cell in poolList)
        {
            var variants = ResolveVariantsForCell(baseTile, cell, cellWalls, allTiles, rules, slot.Required);
            foreach (var (resolvedTile, orient, wallDir) in variants)
            {
                int fpW = resolvedTile.TileLayout.Count > 0 ? (resolvedTile.TileLayout[0]?.Count ?? 1) : 1;
                int fpH = resolvedTile.TileLayout.Count;

                var (anchorCol, anchorRow) = rules.NearWall
                    ? ComputeWallAnchor(cell, wallDir, fpW, fpH)
                    : (cell.col, cell.row);

                if (rules.NearWall && (!FootprintTouchesWallDir(anchorCol, anchorRow, fpW, fpH, cellWalls, wallDir)
                    || !FootprintFullyBacked(anchorCol, anchorRow, fpW, fpH, wallDir, resolvedTile, cellWalls, roomCells)))
                    continue;
                if (!FitsFootprint(anchorCol, anchorRow, fpW, fpH, roomCells, occupied, softOccupied, blockedFrontCells, innerWallKeys, resolvedTile, narrowCells: narrowCells))
                    continue;
                if (!SatisfiesCellPropertyGates(anchorCol, anchorRow, fpW, fpH, resolvedTile, cellPropertyGates))
                    continue;
                if (BlockedByReservedZone(anchorCol, anchorRow, fpW, fpH, resolvedTile, reservedZoneCells))
                    continue;
                if (slot.BlocksFrontCell)
                {
                    var frontCells = FrontCells(anchorCol, anchorRow, fpW, fpH, orient);
                    if (frontCells.Count == 0 || frontCells.Any(fc =>
                        !roomCells.Contains(fc) || physicalOccupied.Contains(fc) ||
                        (occupied.Contains(fc) && !(frontExemptCells?.Contains(fc) ?? false)))
                        || FootprintTouchesWallDir(anchorCol, anchorRow, fpW, fpH, cellWalls, Enum.Parse<Direction>(orient)))
                        continue;
                }
                if (!rules.AllowOnPath && resolvedTile.HasCollision && pathCells.Count > 0
                    && FootprintTouchesCells(anchorCol, anchorRow, fpW, fpH, pathCells))
                    continue;

                // Post-placement traffic path (UsePostPlacementPathAvoidance): keeps freestanding
                // non-collision decor off the real walking route computed after all collision
                // furniture is placed. FloorFurniture-layer decor (rugs etc.) AND Wall*-layer
                // decor (pictures, wall-mounted lamps, mirrors) stay exempt — neither sits in the
                // floor traffic space, so they can go anywhere, same as today (see
                // IsExemptFromReservedZone, same exemption used for reserved zones).
                if (!rules.AllowOnPath && !resolvedTile.HasCollision && !IsExemptFromReservedZone(resolvedTile)
                    && decorPathCells is { Count: > 0 }
                    && FootprintTouchesCells(anchorCol, anchorRow, fpW, fpH, decorPathCells))
                    continue;
                if (!rules.NearDoor && FootprintTouchesCells(anchorCol, anchorRow, fpW, fpH, doorCells))
                    continue;

                // Gap cells are the sole passage through an inner wall — treat them exactly
                // like a real door/opening (unconditionally off-limits, any layer, any
                // collision state). Doesn't make sense for anything, even non-colliding decor,
                // to sit directly in a narrow passage.
                if (!rules.NearDoor && gapCells is { Count: > 0 }
                    && FootprintTouchesCells(anchorCol, anchorRow, fpW, fpH, gapCells))
                    continue;

                if (openingGroups is { Count: > 0 } &&
                    !OpeningGroupsAllowPlacement(anchorCol, anchorRow, fpW, fpH, resolvedTile.HasCollision, physicalOccupied, openingGroups))
                    continue;
                if (resolvedTile.IsHigh && openingGroups is { Count: > 0 }
                    && openingGroups.Any(g => g.Any(c =>
                        c.Item1 >= anchorCol && c.Item1 < anchorCol + fpW &&
                        c.Item2 >= anchorRow && c.Item2 < anchorRow + fpH)))
                    continue;
                if (!rules.NearWindow && ViolatesWindowPlacement(anchorCol, anchorRow, fpW, fpH, resolvedTile, orient, windowCells))
                    continue;
                if (resolvedTile.IsLootContainer && !LootContainerReachable(anchorCol, anchorRow, fpW, fpH, roomCells, physicalOccupied))
                    continue;
                if (resolvedTile.HasCollision
                    && !RoomRemainsConnected(anchorCol, anchorRow, fpW, fpH, roomCells, physicalOccupied, entryCells, innerWallKeys, protectedCells))
                    continue;

                result.Add(new LayoutPlacementCandidate(anchorCol, anchorRow, orient, resolvedTile, effectiveColorGroup));
            }
        }

        return result;
    }

    private static bool IsValidAnchoredPlacement(
        RoomTypeSlot slot,
        int col,
        int row,
        int fpW,
        int fpH,
        string orient,
        TileDefinition tile,
        HashSet<(int, int)> roomCells,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        HashSet<(int, int)> doorCells,
        HashSet<(int, int)> windowCells,
        HashSet<(int, int)> pathCells,
        HashSet<(int, int)> occupied,
        HashSet<(int, int)> physicalOccupied,
        HashSet<(int, int)>? blockedFrontCells = null,
        HashSet<string>? innerWallKeys = null,
        List<HashSet<(int, int)>>? openingGroups = null,
        Dictionary<(int, int), HashSet<string>>? cellPropertyGates = null,
        HashSet<(int, int)>? reservedZoneCells = null,
        HashSet<(int, int)>? frontExemptCells = null,
        HashSet<(int, int)>? gapCells = null,
        PlacementRules? rulesOverride = null,
        HashSet<(int, int)>? effectiveSoftOccupied = null,
        HashSet<(int, int)>? floorLayerOccupied = null,
        HashSet<(int, int)>? stairEndCells = null,
        HashSet<(int, int)>? entryCells = null,
        Lazy<HashSet<(int, int)>>? protectedCells = null,
        HashSet<(int, int)>? narrowCells = null)
    {
        // Defaults to slot.PlacementRules (unchanged behavior); callers that want to retry an
        // anchored placement under a FallbackRules entry (see EnumeratePlacementRuleChain) pass
        // that entry here instead.
        var rules = rulesOverride ?? slot.PlacementRules;

        // effectiveSoftOccupied (if provided) is the caller's softOccupied set with the anchor
        // target's own footprint cells removed — lets a requiresSlot-dependent slot land on its
        // anchor (e.g. lamp on nightstand) while still respecting OTHER slots' soft-blocked cells.
        // tile/floorLayerOccupied let a non-colliding FloorFurniture tile (e.g. a rug) correctly
        // overlap OTHER slots' occupied cells (chairs, a table) instead of being blocked by them —
        // see FitsFootprint's useFloorLayerOccupied branch, same as the plain-path anchored check.
        if (!FitsFootprint(col, row, fpW, fpH, roomCells, occupied, effectiveSoftOccupied, blockedFrontCells, innerWallKeys, tile, floorLayerOccupied, stairEndCells, narrowCells))
            return false;
        // Anchored orientation (e.g. "match" the anchor's facing) can land on an orientation
        // the tile itself doesn't support — ResolveFinalTileForOrient falls back to the
        // unmodified base tile when no matching variant exists, so this is the only gate that
        // catches it. Mirrors the AllowedOrients check EnumerateFreePlacementCandidates/
        // ResolveVariantForCell already does for free (non-anchored) placement.
        if (tile.AllowedOrients.Count > 0
            && !AllowedOrientsMatch(tile, orient))
            return false;
        if (!SatisfiesCellPropertyGates(col, row, fpW, fpH, tile, cellPropertyGates))
            return false;
        if (BlockedByReservedZone(col, row, fpW, fpH, tile, reservedZoneCells))
            return false;
        if (slot.BlocksFrontCell)
        {
            var frontCells = FrontCells(col, row, fpW, fpH, orient);
            if (frontCells.Count == 0 || frontCells.Any(fc =>
                !roomCells.Contains(fc) || physicalOccupied.Contains(fc) ||
                (occupied.Contains(fc) && !(frontExemptCells?.Contains(fc) ?? false)))
                || FootprintTouchesWallDir(col, row, fpW, fpH, cellWalls, Enum.Parse<Direction>(orient)))
                return false;
        }
        if (rules.NearWall && !FootprintTouchesWall(col, row, fpW, fpH, cellWalls))
            return false;
        // Backed against the wall behind it → that whole back edge must be backed (no half of a
        // 1×2 piece hanging past the wall's end). Touching a wall only sideways stays allowed.
        if (rules.NearWall && BackWall(orient) is { } backDir
            && FootprintTouchesWallDir(col, row, fpW, fpH, cellWalls, backDir)
            && !FootprintFullyBacked(col, row, fpW, fpH, backDir, tile, cellWalls, roomCells))
            return false;
        if (rules.NearWall
            && !MatchesAnchoredWallAlignment(tile, col, row, fpW, fpH, cellWalls, rules.WallAlignment))
            return false;
        if (rules.CornerOnly && !FootprintTouchesCorner(col, row, fpW, fpH, cellWalls))
            return false;
        if (!rules.NearDoor && !IsFloorFurnitureNoCollision(tile) && FootprintTouchesCells(col, row, fpW, fpH, doorCells))
            return false;
        // Gap cells (sole passage through an inner wall) — unconditionally off-limits, same as
        // a real door, regardless of layer/collision (see slot's NearDoor exemption above).
        if (!rules.NearDoor && gapCells is { Count: > 0 }
            && FootprintTouchesCells(col, row, fpW, fpH, gapCells))
            return false;
        if (openingGroups is { Count: > 0 } &&
            !OpeningGroupsAllowPlacement(col, row, fpW, fpH, tile.HasCollision, physicalOccupied, openingGroups))
            return false;
        if (tile.IsHigh && openingGroups is { Count: > 0 }
            && openingGroups.Any(g => g.Any(c =>
                c.Item1 >= col && c.Item1 < col + fpW &&
                c.Item2 >= row && c.Item2 < row + fpH)))
            return false;
        if (!rules.AllowOnPath && tile.HasCollision && pathCells.Count > 0
            && FootprintTouchesCells(col, row, fpW, fpH, pathCells))
            return false;
        if (!rules.NearWindow && ViolatesWindowPlacement(col, row, fpW, fpH, tile, orient, windowCells))
            return false;
        // Connectivity / loot reachability — same guards as free placement. Only when the caller
        // supplies entryCells (the grid placer validates its whole layout separately instead).
        if (entryCells is not null)
        {
            if (tile.IsLootContainer && !LootContainerReachable(col, row, fpW, fpH, roomCells, physicalOccupied))
                return false;
            if (tile.HasCollision
                && !RoomRemainsConnected(col, row, fpW, fpH, roomCells, physicalOccupied, entryCells, innerWallKeys, protectedCells?.Value))
                return false;
        }
        return true;
    }

    private static bool FootprintTouchesCorner(int col, int row, int fpW, int fpH,
        Dictionary<(int, int), HashSet<Direction>> cellWalls)
    {
        for (int r = 0; r < fpH; r++)
            for (int c = 0; c < fpW; c++)
                if (cellWalls.TryGetValue((col + c, row + r), out var dirs) && dirs.Count >= 2)
                    return true;
        return false;
    }

    private static bool MatchesAnchoredWallAlignment(
        TileDefinition tile,
        int col,
        int row,
        int fpW,
        int fpH,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        string alignment)
    {
        if (string.IsNullOrWhiteSpace(alignment)
            || alignment.Equals("any", StringComparison.OrdinalIgnoreCase))
            return true;

        var wallDirs = FootprintWallDirs(col, row, fpW, fpH, cellWalls);
        if (wallDirs.Count == 0)
            return false;

        foreach (var wallDir in wallDirs)
        {
            if (MatchesAlignment(tile, wallDir, alignment))
                return true;
        }

        return false;
    }

    private static string ResolveAnchoredOrient(
        string? anchorOrientRule,
        (int col, int row, int fpW, int fpH, string orient) anchorInfo,
        string anchorPos,
        TileDefinition baseTile,
        char? chosenOpenSide = null)
    {
        return anchorOrientRule switch
        {
            "match" or "parallelToAnchor" => anchorInfo.orient,
            "opposite" => anchorInfo.orient switch
            {
                "N" => "S",
                "S" => "N",
                "E" => "W",
                "W" => "E",
                _ => baseTile.Orientation,
            },
            "cwPerpendicular" => anchorInfo.orient switch
            {
                "S" => "E",
                "E" => "N",
                "N" => "W",
                "W" => "S",
                _ => baseTile.Orientation,
            },
            "ccwPerpendicular" => anchorInfo.orient switch
            {
                "S" => "W",
                "W" => "N",
                "N" => "E",
                "E" => "S",
                _ => baseTile.Orientation,
            },
            "openSideFacing" => chosenOpenSide switch
            {
                'N' => "S",
                'S' => "N",
                'E' => "W",
                'W' => "E",
                _ => baseTile.Orientation,
            },
            "facingAnchor" => anchorPos.Equals("oppositeWall", StringComparison.OrdinalIgnoreCase)
                ? anchorInfo.orient switch
                {
                    "N" => "S",
                    "S" => "N",
                    "E" => "W",
                    "W" => "E",
                    _ => baseTile.Orientation,
                }
                : ResolveFacingAnchorOrient(anchorPos, anchorInfo.fpW, anchorInfo.fpH, anchorInfo.orient) ?? baseTile.Orientation,
            "cornerFromAnchor" => (anchorInfo.orient, anchorPos) switch
            {
                // Returns the corner POSITION (= tile orientation field = which walls the tile is against).
                // tile-definitions convention: orientation=NW means the tile goes in the NW room corner.
                ("S", "rightOfAnchor") => "NW", // main N wall, corner goes west → NW room corner
                ("S", "leftOfAnchor")  => "NE", // main N wall, corner goes east → NE room corner
                ("N", "rightOfAnchor") => "SE", // main S wall, corner goes east → SE room corner
                ("N", "leftOfAnchor")  => "SW", // main S wall, corner goes west → SW room corner
                ("E", "rightOfAnchor") => "SW", // main W wall, corner goes south → SW room corner
                ("E", "leftOfAnchor")  => "NW", // main W wall, corner goes north → NW room corner
                ("W", "rightOfAnchor") => "NE", // main E wall, corner goes north → NE room corner
                ("W", "leftOfAnchor")  => "SE", // main E wall, corner goes south → SE room corner
                _ => baseTile.Orientation,
            },
            // Corner cases (tile continues one of the two walls the anchor corner touches):
            // CW = the wall NOT used by perpendicularCCW's arm (see ComputeAnchoredPosition's
            // rightOfAnchor/leftOfAnchor corner cases, which use the same CW/CCW convention).
            "perpendicularCW" => anchorInfo.orient switch
            {
                "NW" => "S", "NE" => "W", "SE" => "N", "SW" => "E",
                "N"  => "E", "E"  => "S", "S"  => "W", "W"  => "N",
                _    => baseTile.Orientation,
            },
            "perpendicularCCW" => anchorInfo.orient switch
            {
                "NW" => "E", "NE" => "S", "SE" => "W", "SW" => "N",
                "N"  => "W", "E"  => "N", "S"  => "E", "W"  => "S",
                _    => baseTile.Orientation,
            },
            "N" or "S" or "E" or "W" => anchorOrientRule,
            _ => baseTile.Orientation,
        };
    }

    private static TileDefinition ResolveFinalTileForOrient(
        TileDefinition baseTile,
        string desiredOrient,
        IReadOnlyDictionary<string, TileDefinition> allTiles)
    {
        if (string.IsNullOrEmpty(baseTile.VariantGroup)) return baseTile;

        // Same VariantGroup can legitimately be shared across layers (e.g. a hanging counter's
        // Wallfurniture tile shares its floor counter's VariantGroup so tileGroupId can lock them
        // to matching colors) — Layer must also match, or this can silently swap in a tile from a
        // completely different layer just because the orientation happened to fit.
        var exact = allTiles.Values.FirstOrDefault(t =>
            t.VariantGroup.Equals(baseTile.VariantGroup, StringComparison.OrdinalIgnoreCase) &&
            t.Layer.Equals(baseTile.Layer, StringComparison.OrdinalIgnoreCase) &&
            OrientMatches(t, desiredOrient));
        if (exact is not null) return exact;

        var byAllowedOrient = allTiles.Values.FirstOrDefault(t =>
            t.VariantGroup.Equals(baseTile.VariantGroup, StringComparison.OrdinalIgnoreCase) &&
            t.Layer.Equals(baseTile.Layer, StringComparison.OrdinalIgnoreCase) &&
            AllowedOrientsMatch(t, desiredOrient));
        if (byAllowedOrient is not null) return byAllowedOrient;

        static bool IsNorthSouth(string o) => o.Equals("N", StringComparison.OrdinalIgnoreCase)
                                           || o.Equals("S", StringComparison.OrdinalIgnoreCase);
        static bool IsEastWest(string o) => o.Equals("E", StringComparison.OrdinalIgnoreCase)
                                         || o.Equals("W", StringComparison.OrdinalIgnoreCase);

        var axisFallback = allTiles.Values.FirstOrDefault(t =>
            t.VariantGroup.Equals(baseTile.VariantGroup, StringComparison.OrdinalIgnoreCase) &&
            t.Layer.Equals(baseTile.Layer, StringComparison.OrdinalIgnoreCase) &&
            ((IsNorthSouth(desiredOrient) && IsNorthSouth(t.Orientation)) ||
             (IsEastWest(desiredOrient) && IsEastWest(t.Orientation))));

        return axisFallback ?? baseTile;
    }

    private static void CommitLayoutPlacement(
        int floorIndex,
        RoomTypeSlot slot,
        LayoutPlacementCandidate candidate,
        int roomIndex1Based,
        int? selectionAnchorCol,
        int? selectionAnchorRow,
        LayoutPlacementState state)
    {
        int fpW = candidate.Tile.TileLayout.Count > 0 ? (candidate.Tile.TileLayout[0]?.Count ?? 1) : 1;
        int fpH = candidate.Tile.TileLayout.Count;

        for (int r = 0; r < candidate.Tile.TileLayout.Count; r++)
        {
            var rowTiles = candidate.Tile.TileLayout[r];
            if (rowTiles is null) continue;
            for (int c = 0; c < rowTiles.Count; c++)
            {
                var tid = rowTiles[c];
                if (string.IsNullOrEmpty(tid)) continue;
                state.Placements.Add(new PlacedFurnitureItem(
                    floorIndex,
                    candidate.Col + c,
                    candidate.Row + r,
                    tid,
                    candidate.Tile.Layer,
                    candidate.Orient,
                    slot.Id,
                    roomIndex1Based,
                    selectionAnchorCol,
                    selectionAnchorRow));
                if (slot.BlocksPlacement)
                    state.Occupied.Add((candidate.Col + c, candidate.Row + r));
                else if (slot.SoftBlocks)
                    state.SoftOccupied.Add((candidate.Col + c, candidate.Row + r));
                if (candidate.Tile.HasCollision)
                    state.PhysicalOccupied.Add((candidate.Col + c, candidate.Row + r));
                else if (IsFloorFurnitureNoCollision(candidate.Tile))
                    state.FrontExemptCells.Add((candidate.Col + c, candidate.Row + r));
                if (!slot.BlocksPlacement && slot.CellRequiredProperties.Count > 0)
                {
                    var cell = (candidate.Col + c, candidate.Row + r);
                    if (!state.CellPropertyGates.TryGetValue(cell, out var gate))
                        state.CellPropertyGates[cell] = gate = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    gate.UnionWith(slot.CellRequiredProperties);
                }
            }
        }

        if (slot.BlocksFrontCell)
            foreach (var fc in FrontCells(candidate.Col, candidate.Row, fpW, fpH, candidate.Orient))
                state.BlockedFrontCells.Add(fc);

        if (candidate.Tile.IsLootContainer)
            foreach (var fc in FrontCells(candidate.Col, candidate.Row, fpW, fpH, candidate.Orient))
                if (!state.Occupied.Contains(fc))
                    state.SoftOccupied.Add(fc);

        if (!string.IsNullOrEmpty(slot.Id))
            state.AnchorMap[slot.Id] = (candidate.Col, candidate.Row, fpW, fpH, candidate.Orient);
        if (!string.IsNullOrEmpty(slot.SlotGroupId))
            state.AnchorMap.TryAdd(slot.SlotGroupId, (candidate.Col, candidate.Row, fpW, fpH, candidate.Orient));

        if (!string.IsNullOrEmpty(candidate.EffectiveColorGroup) && !state.ColorMap.ContainsKey(candidate.EffectiveColorGroup))
        {
            var firstColor = candidate.Tile.Colors.FirstOrDefault(c => !string.IsNullOrEmpty(c));
            if (!string.IsNullOrEmpty(firstColor))
                state.ColorMap[candidate.EffectiveColorGroup] = firstColor;
        }

        if (!string.IsNullOrEmpty(slot.TileGroupId) &&
            !state.VariantMap.ContainsKey(slot.TileGroupId) &&
            !string.IsNullOrEmpty(candidate.Tile.VariantGroup))
        {
            state.VariantMap[slot.TileGroupId] = candidate.Tile.VariantGroup;
        }

        state.SlotPlacements.Add((slot.Id, candidate.Tile.TileId, candidate.Orient, candidate.Col, candidate.Row));
    }

    private static List<T> ShuffleCopy<T>(IEnumerable<T> source, Random rng)
    {
        var list = source.ToList();
        for (int i = list.Count - 1; i > 0; i--)
        {
            int j = rng.Next(i + 1);
            (list[i], list[j]) = (list[j], list[i]);
        }

        return list;
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
        HashSet<(int, int)> blockedFrontCells,
        HashSet<(int, int)> floorLayerOccupied,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        IReadOnlyDictionary<string, RugDefinition> rugCatalog,
        Dictionary<string, List<(int col, int row, int fpW, int fpH, string orient)>> anchorMap,
        Dictionary<string, int> anchorUseCounts,
        Dictionary<string, string> colorMap,
        Dictionary<string, string> variantMap,
        RoomTypeConfig config,
        int roomIndex1Based,
        int? selectionAnchorCol,
        int? selectionAnchorRow,
        List<PlacedFurnitureItem> placements, List<string> log, Random rng,
        string roomTypeName = "",
        HashSet<string>? innerWallKeys = null,
        HashSet<(int, int)>? mainSubRoomCells = null,
        List<HashSet<(int, int)>>? openingGroups = null,
        Dictionary<(int, int), HashSet<string>>? cellPropertyGates = null,
        HashSet<(int, int)>? reservedZoneCells = null,
        HashSet<(int, int)>? frontExemptCells = null,
        HashSet<(int, int)>? gapCells = null,
        HashSet<(int, int)>? decorPathCells = null,
        HashSet<(int, int)>? stairEndCells = null,
        HashSet<(int, int)>? narrowCells = null)
    {
        // matchAnchorCluster rugs (e.g. a dining rug sized to table+chairs) resolve their target
        // size/position from the anchor parent's placed cluster instead of slot.Footprint/anchorRules
        // — computed up front so it can override BuildRugCandidates' sizing below, and reused again
        // later to place the slot directly at the cluster's bounding box.
        (int col, int row, int w, int h, string orient)? rugClusterBounds = null;
        if (slot.RugSlot is not null
            && slot.RugSlot.Sizing.Mode.Equals("matchAnchorCluster", StringComparison.OrdinalIgnoreCase))
        {
            var gridMembers = GridClusterMemberIds(config, slot.RequiresSlot, anchorMap);
            bool gridPiecesOnly = slot.RugSlot.Sizing.ClusterGridPiecesOnly && gridMembers.Count > 0;
            if (slot.RugSlot.Sizing.ClusterGridPiecesOnly && gridMembers.Count == 0)
                log.Add($"  [INFO] '{slot.Id}': clusterGridPiecesOnly ignored — '{slot.RequiresSlot}' is no placed grid");
            rugClusterBounds = ComputeAnchorClusterBounds(slot.RequiresSlot, anchorMap, config.Slots, slot.Id,
                extraMemberIds: gridMembers, includeRequiringSlots: !gridPiecesOnly);
            if (rugClusterBounds is null)
            {
                log.Add($"  [WARN] '{slot.Id}': matchAnchorCluster — parent '{slot.RequiresSlot}' not placed, skipping");
                return;
            }
        }

        var candidates = slot.RugSlot is not null
            ? BuildRugCandidates(rugCatalog, slot, roomTypeName, roomCells,
                rugClusterBounds is { } rcb ? (rcb.w, rcb.h) : null)
            : FilterTiles(allTiles, slot, roomTypeName);
        if (candidates.Count == 0)
        {
            log.Add($"  [WARN] '{slot.Id}': no matching tiles " +
                    $"(layer='{slot.RequiredLayer}', cats=[{string.Join(",", slot.AllowedCategories.Keys.Where(k => k != EmptyCategory))}], " +
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
        // Resolved outside the if so it survives to the FindFreeCell calls below — a wall-
        // orientation variant re-search (ResolveVariantForCell) needs to keep respecting this
        // same color lock, not just the initial candidate filter (see requiredColor param there).
        string? requiredColor = null;
        if (!string.IsNullOrEmpty(effectiveColorGroup)
            && colorMap.TryGetValue(effectiveColorGroup, out var lockedColor)
            && !string.IsNullOrEmpty(lockedColor))
        {
            requiredColor = lockedColor;
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
            else if (slot.RequireTileGroupMatch)
            {
                candidates = [];
                log.Add($"    [TILEGROUP] '{slot.Id}': group='{slot.TileGroupId}' → no tile matches variantGroup='{requiredVariantGroup}', requireTileGroupMatch=true, skipping");
            }
            // else: kein Match → ungefilterten Pool behalten
        }

        // ── Materialfilter ─────────────────────────────────────────────────────
        // AND-verknüpft mit Farbfilter: nur Tiles die Material enthält werden bevorzugt.
        // Same "survives to FindFreeCell" reasoning as requiredColor above.
        string? requiredMaterial = null;
        if (!string.IsNullOrEmpty(slot.MaterialGroupId)
            && !slot.MaterialGroupId.Equals("none", StringComparison.OrdinalIgnoreCase))
        {
            requiredMaterial = slot.MaterialGroupId;
            var matFiltered = candidates
                .Where(t => t.Materials.Any(m => m.Equals(slot.MaterialGroupId, StringComparison.OrdinalIgnoreCase)))
                .ToList();
            if (matFiltered.Count > 0)
            {
                candidates = matFiltered;
                log.Add($"    [MATERIAL] '{slot.Id}': filter material='{slot.MaterialGroupId}' ({matFiltered.Count} tiles)");
            }
            // else: kein Match → ungefilterten Pool behalten (Slot wird nicht verworfen)
        }

        // Resolve anchor rule
        (int col, int row, int fpW, int fpH, string orient)? anchorInfo = null;
        string?      anchorPos        = null;
        List<string> anchorPositions  = [];  // full list, for retrying alternates when anchorPos doesn't fit
        string?      anchorOrientRule = null;   // "match" | "parallelToAnchor" | "opposite" | "facingAnchor" | "N/S/E/W" | null
        int     anchorOffset     = 0;      // offsetAlongAnchor für LongSide/ShortSide
        int?    anchorMinOppositeWallDistance = null;
        int?    anchorMaxOppositeWallDistance = null;
        // Kumulative Ablehnungszähler für [WARN]-Log (nur im else-Zweig gefüllt, sonst 0)
        int totalNoVariant = 0, totalNoFit = 0, totalNoWallDir = 0, totalFits = 0, totalPath = 0, totalLoot = 0;
        int totalDoor = 0, totalWindow = 0, totalConnectivity = 0;
        if (slot.AnchorRules?.Count > 0)
        {
            foreach (var rule in slot.AnchorRules)
                if (!string.IsNullOrEmpty(rule.AnchorTarget) && anchorMap.TryGetValue(rule.AnchorTarget, out var instances) && instances.Count > 0)
                {
                    // Round-robin over the target's instances (a slot with countBySize>1 records
                    // one anchorMap entry per instance — see AddAnchorEntry below) so e.g. 2 deco
                    // items anchoring onto 2 cabinets pair up 1:1 instead of both anchoring onto
                    // whichever cabinet instance was placed last. Wraps if this dependent slot's
                    // own count exceeds the target's instance count.
                    int useIdx = anchorUseCounts.GetValueOrDefault(rule.AnchorTarget, 0) % instances.Count;
                    anchorUseCounts[rule.AnchorTarget] = useIdx + 1;

                    anchorInfo       = instances[useIdx];
                    anchorPositions  = rule.Positions;
                    anchorPos        = rule.Positions.Count > 0 ? rule.Positions[rng.Next(rule.Positions.Count)] : null;
                    anchorOrientRule = rule.Orient;
                    anchorOffset     = rule.OffsetAlongAnchor;
                    anchorMinOppositeWallDistance = rule.MinOppositeWallDistance;
                    anchorMaxOppositeWallDistance = rule.MaxOppositeWallDistance;
                    break;
                }
        }

        var tile = SelectTile(candidates, slot, rng);
        if (tile is null) return;

        (int col, int row, string orient, TileDefinition placedTile, int rejNoVariant, int rejNoFit, int rejDoor, int rejWindow, int rejConnectivity)? result = null;
        if (rugClusterBounds is { } cb)
        {
            // Single deterministic target (the cluster's own bounding box) — no candidate search,
            // just validate it like any other anchored placement (reusing the same validator the
            // composite-layout solver uses, now fit for this too since FitsFootprint's floor-layer
            // exemption was threaded through it above).
            int cfpW = tile.TileLayout.Count > 0 ? (tile.TileLayout[0]?.Count ?? 1) : 1;
            int cfpH = tile.TileLayout.Count;
            bool clusterValid = IsValidAnchoredPlacement(slot, cb.col, cb.row, cfpW, cfpH, cb.orient, tile,
                roomCells, cellWalls, doorCells, windowCells, pathCells, occupied, physicalOccupied,
                blockedFrontCells, innerWallKeys, openingGroups, cellPropertyGates, reservedZoneCells,
                frontExemptCells, gapCells, floorLayerOccupied: floorLayerOccupied, stairEndCells: stairEndCells, narrowCells: narrowCells);
            if (clusterValid)
            {
                result = (cb.col, cb.row, cb.orient, tile, 0, 0, 0, 0, 0);
            }
            else
            {
                log.Add($"  [WARN] '{slot.Id}': matchAnchorCluster — bounds {cb.w}×{cb.h} at ({cb.col},{cb.row}) invalid for '{tile.TileId}'");
                return;
            }
        }
        else if (anchorInfo.HasValue && anchorPos != null)
        {
            // Anchored placement gets exactly one shot at the anchor's single target position
            // (or its few named alternates) — unlike free placement, which has many pool cells
            // to try, so a single bad tile pick (wrong orientation, missing VariantGroup variant,
            // etc.) can fail the whole slot even though other candidates would fit. Retry every
            // matching candidate tile in turn, same as the composite-layout solver
            // (BuildLayoutCandidates) already does via OrderTileCandidatesForLayout.
            foreach (var candidateTile in OrderTileCandidatesForLayout(candidates, slot, rng))
            {
            tile = candidateTile;
            result = null;
            // Delegates to the shared static ResolveAnchoredOrient (also used by the composite
            // layout solver) instead of keeping a second, independently-maintained copy of the
            // same switch — two copies previously drifted apart (missing cases, swapped corner
            // keys) without either side noticing, since each path only exercises its own copy.
            string ResolveAnchoredOrient(char? chosenOpenSide = null) =>
                FurnishingGeneratorService.ResolveAnchoredOrient(anchorOrientRule, anchorInfo!.Value, anchorPos ?? string.Empty, tile, chosenOpenSide);

            TileDefinition ResolveFinalTile(string desiredOrient)
            {
                if (string.IsNullOrEmpty(tile.VariantGroup)) return tile;

                // Same VariantGroup can legitimately be shared across layers (e.g. a hanging
                // counter's Wallfurniture tile shares its floor counter's VariantGroup so
                // tileGroupId can lock them to matching colors) — Layer must also match, or this
                // can silently swap in a tile from a completely different layer just because the
                // orientation happened to fit.
                //
                // `tile` itself already came from the color/material-filtered `candidates` pool,
                // but this re-search reaches back into the FULL allTiles set to find an
                // orientation sibling — without also preferring requiredColor/requiredMaterial
                // here, it could silently swap in a differently-colored sibling just because it
                // matches the needed orientation (closes over the same locals PlaceSlot's
                // color/material filter block above resolved).
                TileDefinition? FindMatch(Func<TileDefinition, bool> orientPredicate)
                {
                    var pool = allTiles.Values.Where(t =>
                        t.VariantGroup.Equals(tile.VariantGroup, StringComparison.OrdinalIgnoreCase) &&
                        t.Layer.Equals(tile.Layer, StringComparison.OrdinalIgnoreCase) &&
                        orientPredicate(t)).ToList();
                    if (pool.Count == 0) return null;

                    if (!string.IsNullOrEmpty(requiredColor))
                    {
                        var colorMatched = pool.Where(t => t.Colors.Any(c => c.Equals(requiredColor, StringComparison.OrdinalIgnoreCase))).ToList();
                        if (colorMatched.Count > 0) pool = colorMatched;
                    }
                    if (!string.IsNullOrEmpty(requiredMaterial))
                    {
                        var materialMatched = pool.Where(t => t.Materials.Any(m => m.Equals(requiredMaterial, StringComparison.OrdinalIgnoreCase))).ToList();
                        if (materialMatched.Count > 0) pool = materialMatched;
                    }
                    return pool.FirstOrDefault();
                }

                // 1) Exakte Orientierung bevorzugen (z.B. N, S, E, W vorhanden).
                var exact = FindMatch(t => OrientMatches(t, desiredOrient));
                if (exact is not null) return exact;

                // 2) Falls es keine exakte Variante gibt, auf Achsen-Ebene auflösen.
                // Viele Sets haben nur N/W als Basis, aber allowedOrients enthält N/S bzw. E/W.
                var byAllowedOrient = FindMatch(t => AllowedOrientsMatch(t, desiredOrient));
                if (byAllowedOrient is not null) return byAllowedOrient;

                // 3) Letzter Fallback: gleiche Achse über Orientation-Feld (NS oder EW).
                static bool IsNorthSouth(string o) => o.Equals("N", StringComparison.OrdinalIgnoreCase)
                                                   || o.Equals("S", StringComparison.OrdinalIgnoreCase);
                static bool IsEastWest(string o) => o.Equals("E", StringComparison.OrdinalIgnoreCase)
                                                 || o.Equals("W", StringComparison.OrdinalIgnoreCase);

                var axisFallback = FindMatch(t =>
                    (IsNorthSouth(desiredOrient) && IsNorthSouth(t.Orientation)) ||
                    (IsEastWest(desiredOrient) && IsEastWest(t.Orientation)));

                return axisFallback ?? tile;
            }

            var initialAnchorPos = anchorPos;
            // Mirrors the non-anchored FallbackRules chain below: try the primary PlacementRules
            // across every anchor position first; only if NONE of them validate, retry the same
            // search under each FallbackRules entry in order, stopping at the first success. This
            // is what lets a required pool slot (e.g. stove/sink) that's geometrically boxed in
            // under its normal rules (e.g. touching a door) get a second chance under a relaxed
            // fallback rule set instead of being silently dropped.
            // Anchored placement may land on the anchor target's OWN footprint (e.g. a lamp on
            // its required nightstand, softBlocks=true) — but must still respect OTHER slots'
            // soft-blocked cells. Only exempt the anchor's own footprint instead of ignoring
            // softOccupied for the whole room, otherwise an unrelated anchored slot can collide
            // with an unrelated soft-blocked slot that happens to land on the same cell.
            HashSet<(int, int)> effectiveSoftOccupied = softOccupied;
            if (anchorInfo.HasValue && softOccupied.Count > 0)
            {
                var (aCol, aRow, aFpW, aFpH, _) = anchorInfo.Value;
                effectiveSoftOccupied = new HashSet<(int, int)>(softOccupied);
                for (int r = 0; r < aFpH; r++)
                    for (int c = 0; c < aFpW; c++)
                        effectiveSoftOccupied.Remove((aCol + c, aRow + r));
            }

            // Connectivity inputs for anchored placements — same as the free-placement path
            // (FindFreeCell). Invariant while this slot is being placed: physicalOccupied only
            // changes once a position is committed.
            var anchorEntryCells = openingGroups is { Count: > 0 }
                ? new HashSet<(int, int)>(doorCells.Concat(openingGroups.SelectMany(g => g)))
                : doorCells;
            var anchorProtectedCells = ComputeProtectedCells(roomCells, physicalOccupied, anchorEntryCells, innerWallKeys);
            // The piece is meant to attach to its anchor (counter run, chairs around a table), so
            // the anchor itself doesn't need to keep a free neighbour — door/pocket isolation and
            // every other already-placed piece still do.
            if (anchorInfo.HasValue)
            {
                var (pCol, pRow, pFpW, pFpH, _) = anchorInfo.Value;
                for (int r = 0; r < pFpH; r++)
                    for (int c = 0; c < pFpW; c++)
                        anchorProtectedCells.Remove((pCol + c, pRow + r));
            }

            var anchorRuleChain = EnumeratePlacementRuleChain(slot).ToList();
            for (int ruleIdx = 0; ruleIdx < anchorRuleChain.Count && result is null; ruleIdx++)
            {
                var rules = anchorRuleChain[ruleIdx];
                anchorPos = initialAnchorPos;

                bool TryAnchorPosition(int ac, int ar, string anchoredOrient, TileDefinition finalTile, int fpW, int fpH, char? chosenOpenSide = null)
                {
                    // requiresSlot-Slots dürfen bewusst auf dem Ankermöbel (z.B. Nachttisch mit
                    // softBlocks=true) platziert werden — effectiveSoftOccupied hat dessen Zellen
                    // bereits ausgenommen, respektiert aber softOccupied-Zellen anderer Slots.
                    bool fitOk  = FitsFootprint(ac, ar, fpW, fpH, roomCells, occupied, effectiveSoftOccupied, innerWallKeys: innerWallKeys, tile: finalTile, floorLayerOccupied: floorLayerOccupied, stairEndCells: stairEndCells, narrowCells: narrowCells)
                                  && SatisfiesCellPropertyGates(ac, ar, fpW, fpH, finalTile, cellPropertyGates)
                                  && !BlockedByReservedZone(ac, ar, fpW, fpH, finalTile, reservedZoneCells);
                    // Anchored orientation (e.g. "match" the anchor's facing) can land on an
                    // orientation the tile itself doesn't support — ResolveFinalTile falls back to
                    // the unmodified tile when no matching variant exists, so this is the only gate
                    // that catches it. Mirrors the AllowedOrients check the free-placement path
                    // (ResolveVariantForCell) already does; see also IsValidAnchoredPlacement, the
                    // composite-layout solver's independent copy of this same anchored-placement logic.
                    bool orientOk = finalTile.AllowedOrients.Count == 0
                                  || AllowedOrientsMatch(finalTile, anchoredOrient);
                    bool doorOk = (rules.NearDoor
                                  || IsFloorFurnitureNoCollision(finalTile)
                                  || !FootprintTouchesCells(ac, ar, fpW, fpH, doorCells))
                                  && (openingGroups is not { Count: > 0 }
                                  || OpeningGroupsAllowPlacement(ac, ar, fpW, fpH, finalTile.HasCollision, physicalOccupied, openingGroups))
                                  && (!finalTile.IsHigh
                                  || openingGroups is not { Count: > 0 }
                                  || !openingGroups.Any(g => g.Any(c =>
                                      c.Item1 >= ac && c.Item1 < ac + fpW &&
                                      c.Item2 >= ar && c.Item2 < ar + fpH)));
                    bool gapOk = rules.NearDoor
                                  || gapCells is not { Count: > 0 }
                                  || !FootprintTouchesCells(ac, ar, fpW, fpH, gapCells);
                    bool pathOk = rules.AllowOnPath
                                  || !finalTile.HasCollision
                                  || pathCells.Count == 0
                                  || !FootprintTouchesCells(ac, ar, fpW, fpH, pathCells);
                    bool winOk  = rules.NearWindow
                                  || !ViolatesWindowPlacement(ac, ar, fpW, fpH, finalTile, anchoredOrient, windowCells);
                    // "Open side" must actually be open — reject if a wall (outer or inner/
                    // sub-room dividing wall) sits on the anchor's chosen side.
                    bool sideOk = chosenOpenSide is not { } sc
                                  || !FootprintTouchesWallDir(anchorInfo.Value.col, anchorInfo.Value.row,
                                         anchorInfo.Value.fpW, anchorInfo.Value.fpH, cellWalls,
                                         Enum.Parse<Direction>(sc.ToString()));
                    // Backed against the wall behind it → the whole back edge must be backed (same
                    // rule as IsValidAnchoredPlacement), e.g. a TV table at the opposite wall must
                    // not stick out past the wall's end.
                    bool wallOk = !rules.NearWall
                                  || BackWall(anchoredOrient) is not { } backDir
                                  || !FootprintTouchesWallDir(ac, ar, fpW, fpH, cellWalls, backDir)
                                  || FootprintFullyBacked(ac, ar, fpW, fpH, backDir, finalTile, cellWalls, roomCells);
                    bool baseValid = fitOk && doorOk && gapOk && pathOk && winOk && sideOk && orientOk && wallOk;
                    // Same guards as free placement (see FindFreeCell): a colliding anchored piece —
                    // e.g. a dining chair around its table, a coffee table in front of a sofa — must
                    // not seal off a door cell or a pocket of the room, nor cut off an already-placed
                    // piece; loot containers must stay reachable. Flood fills, so only evaluated once
                    // the cheap checks pass.
                    bool lootOk = !baseValid
                                  || !finalTile.IsLootContainer
                                  || LootContainerReachable(ac, ar, fpW, fpH, roomCells, physicalOccupied);
                    bool connOk = !baseValid
                                  || !finalTile.HasCollision
                                  || RoomRemainsConnected(ac, ar, fpW, fpH, roomCells, physicalOccupied, anchorEntryCells, innerWallKeys, anchorProtectedCells);
                    bool anchorValid = baseValid && lootOk && connOk;

                    if (anchorValid)
                    {
                        result = (ac, ar, anchoredOrient, finalTile, 0, 0, 0, 0, 0);
                        return true;
                    }

                    var sideSuffix = chosenOpenSide.HasValue ? $" side='{chosenOpenSide.Value}'" : string.Empty;
                    var ruleSuffix = ruleIdx > 0 ? $" rule#{ruleIdx}" : string.Empty;
                    log.Add($"    [ANCHOR-FAIL] '{slot.Id}'{ruleSuffix} tile='{tile.TileId}': pos=({ac},{ar}){sideSuffix} fit={fitOk} door={doorOk} gap={gapOk} path={pathOk} window={winOk} side={sideOk} orient={orientOk} loot={lootOk} conn={connOk}");
                    return false;
                }

                if (anchorPos!.Equals("openSidePlacement", StringComparison.OrdinalIgnoreCase))
            {
                foreach (var side in ComputeOpenSideOrder(anchorInfo.Value.orient))
                {
                    var anchoredOrient = ResolveAnchoredOrient(side);
                    var finalTile = ResolveFinalTile(anchoredOrient);
                    int fpW = finalTile.TileLayout.Count > 0 ? (finalTile.TileLayout[0]?.Count ?? 1) : 1;
                    int fpH = finalTile.TileLayout.Count;
                    var pos = ComputeOpenSidePosition(anchorInfo.Value.col, anchorInfo.Value.row,
                        anchorInfo.Value.fpW, anchorInfo.Value.fpH, fpW, fpH, side);

                    log.Add($"    [ANCHOR] '{slot.Id}' tile='{tile.TileId}': anchorOrientRule='{anchorOrientRule ?? "null"}' anchorPos='openSidePlacement' side='{side}' -> anchoredOrient='{anchoredOrient}'");
                    if (TryAnchorPosition(pos.col, pos.row, anchoredOrient, finalTile, fpW, fpH, side))
                        break;
                }
                if (result is null && ruleIdx == anchorRuleChain.Count - 1)
                    log.Add($"    [ANCHOR-FAIL] '{slot.Id}': openSidePlacement found no valid side for orient='{anchorInfo.Value.orient}'");
            }
            else if (anchorPos.Equals("oppositeWall", StringComparison.OrdinalIgnoreCase))
            {
                var anchoredOrient = ResolveAnchoredOrient();
                var finalTile = ResolveFinalTile(anchoredOrient);
                int fpW = finalTile.TileLayout.Count > 0 ? (finalTile.TileLayout[0]?.Count ?? 1) : 1;
                int fpH = finalTile.TileLayout.Count;

                int minDist = Math.Max(1, anchorMinOppositeWallDistance ?? 1);
                int maxCfg = anchorMaxOppositeWallDistance ?? 0;
                int maxDist = maxCfg <= 0
                    ? int.MaxValue
                    : Math.Max(minDist, maxCfg);

                log.Add($"    [ANCHOR] '{slot.Id}' tile='{tile.TileId}': anchorOrientRule='{anchorOrientRule ?? "null"}' anchorPos='oppositeWall' minDist={minDist} maxDist={(maxDist == int.MaxValue ? "inf" : maxDist.ToString())} -> anchoredOrient='{anchoredOrient}'");
                foreach (var candidate in ComputeOppositeWallCandidates(
                             anchorInfo.Value.col, anchorInfo.Value.row,
                             anchorInfo.Value.fpW, anchorInfo.Value.fpH,
                             anchorInfo.Value.orient,
                             fpW, fpH,
                             minDist, maxDist,
                             roomCells,
                             innerWallKeys))
                {
                    if (TryAnchorPosition(candidate.col, candidate.row, anchoredOrient, finalTile, fpW, fpH))
                        break;
                }

                if (result is null && ruleIdx == anchorRuleChain.Count - 1)
                    log.Add($"    [ANCHOR-FAIL] '{slot.Id}': oppositeWall found no valid wall candidate for orient='{anchorInfo.Value.orient}'");
            }
            else
            {
                // Retry every named position declared on this anchor rule (shuffled), not just
                // the one rolled up-front — mirrors the openSidePlacement/oppositeWall branches
                // above, which already loop through multiple candidates. Without this, a rule
                // listing e.g. ["rightOfAnchor","leftOfAnchor"] would only ever try one of them,
                // failing the whole (possibly required) slot if that one doesn't fit.
                var candidatePositions = ShuffleCopy(
                    anchorPositions.Where(p =>
                        !p.Equals("openSidePlacement", StringComparison.OrdinalIgnoreCase) &&
                        !p.Equals("oppositeWall", StringComparison.OrdinalIgnoreCase)),
                    rng);
                if (candidatePositions.Count == 0 && anchorPos != null)
                    candidatePositions = [anchorPos];

                bool anyFit = false;
                foreach (var candidatePos in candidatePositions)
                {
                    anchorPos = candidatePos;
                    var anchoredOrient = ResolveAnchoredOrient();
                    log.Add($"    [ANCHOR] '{slot.Id}' tile='{tile.TileId}': anchorOrientRule='{anchorOrientRule ?? "null"}' anchorPos='{anchorPos}' anchorFpW={anchorInfo.Value.fpW} anchorFpH={anchorInfo.Value.fpH} -> anchoredOrient='{anchoredOrient}'");
                    var finalTile = ResolveFinalTile(anchoredOrient);
                    int fpW = finalTile.TileLayout.Count > 0 ? (finalTile.TileLayout[0]?.Count ?? 1) : 1;
                    int fpH = finalTile.TileLayout.Count;
                    var p = ComputeAnchoredPosition(anchorInfo.Value.col, anchorInfo.Value.row,
                        anchorInfo.Value.fpW, anchorInfo.Value.fpH, fpW, fpH, anchorPos, anchorInfo.Value.orient, anchorOffset);

                    if (p.HasValue)
                    {
                        var (ac, ar) = p.Value;
                        if (TryAnchorPosition(ac, ar, anchoredOrient, finalTile, fpW, fpH))
                        {
                            anyFit = true;
                            break;
                        }
                    }
                    else
                    {
                        log.Add($"    [ANCHOR-FAIL] '{slot.Id}': ComputeAnchoredPosition returned null for anchorPos='{anchorPos}'");
                    }
                }
                if (!anyFit && candidatePositions.Count > 1 && ruleIdx == anchorRuleChain.Count - 1)
                    log.Add($"    [ANCHOR-FAIL] '{slot.Id}': no valid position among [{string.Join(", ", candidatePositions)}]");
            }

                if (result is not null && ruleIdx > 0)
                    log.Add($"    [ANCHOR-FALLBACK {ruleIdx}] '{slot.Id}': used fallback rule #{ruleIdx}");
            }

            if (result is not null) break;
            }
        }
        else
        {
            // Primary placement attempt
            result = FindFreeCell(slot, roomCells, cellWalls, doorCells, windowCells,
                pathCells, occupied, softOccupied, physicalOccupied, blockedFrontCells, tile, allTiles, slot.PlacementRules, rng, log,
                innerWallKeys, mainSubRoomCells, openingGroups, out var primaryRej, cellPropertyGates, reservedZoneCells, frontExemptCells, gapCells, decorPathCells, floorLayerOccupied, stairEndCells, requiredColor, requiredMaterial, narrowCells);
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
                        pathCells, occupied, softOccupied, physicalOccupied, blockedFrontCells, tile, allTiles, fbRules, rng, log,
                        innerWallKeys, mainSubRoomCells, openingGroups, out var fbRej, cellPropertyGates, reservedZoneCells, frontExemptCells, gapCells, decorPathCells, floorLayerOccupied, stairEndCells, requiredColor, requiredMaterial, narrowCells);
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
                placements.Add(new PlacedFurnitureItem(
                    floorIndex,
                    col + c,
                    row + r,
                    tid,
                    placedTile.Layer,
                    orient,
                    slot.Id,
                    roomIndex1Based,
                    selectionAnchorCol,
                    selectionAnchorRow));
                if (slot.BlocksPlacement)
                    occupied.Add((col + c, row + r));
                else if (slot.SoftBlocks)
                    softOccupied.Add((col + c, row + r));
                // Bodenebene unabhängig von BlocksPlacement erfassen, damit ein anderes
                // FloorFurniture-Deko-Tile (z.B. Teppich) nicht auf bereits belegtem Boden
                // stapelt, selbst wenn dieser Slot selbst nicht blockt (siehe FitsFootprint).
                if (placedTile.Layer.Equals("FloorFurniture", StringComparison.OrdinalIgnoreCase))
                    floorLayerOccupied.Add((col + c, row + r));
                // Physikalische Belegung: unabhängig von BlocksPlacement, nur nach HasCollision
                if (placedTile.HasCollision)
                    physicalOccupied.Add((col + c, row + r));
                else if (IsFloorFurnitureNoCollision(placedTile))
                    frontExemptCells?.Add((col + c, row + r));
                if (!slot.BlocksPlacement && slot.CellRequiredProperties.Count > 0 && cellPropertyGates is not null)
                {
                    var gateCell = (col + c, row + r);
                    if (!cellPropertyGates.TryGetValue(gateCell, out var gate))
                        cellPropertyGates[gateCell] = gate = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    gate.UnionWith(slot.CellRequiredProperties);
                }
            }
        }

        if (slot.BlocksFrontCell)
            foreach (var fc in FrontCells(col, row, finalFpW, finalFpH, orient))
                blockedFrontCells.Add(fc);

        if (placedTile.IsLootContainer)
            foreach (var fc in FrontCells(col, row, finalFpW, finalFpH, orient))
                if (!occupied.Contains(fc))
                    softOccupied.Add(fc);

        // A slot with countBySize>1 (e.g. 2 cabinets) calls PlaceSlot once per instance, all
        // sharing the same slot.Id — append rather than overwrite, so a dependent that anchors
        // onto this slot.Id can pair with EACH instance in turn (see the round-robin pick at
        // the anchor-resolution site above) instead of every dependent piling onto whichever
        // instance happened to be placed last.
        void AddAnchorEntry(string key)
        {
            if (string.IsNullOrEmpty(key)) return;
            if (!anchorMap.TryGetValue(key, out var list)) anchorMap[key] = list = [];
            list.Add((col, row, finalFpW, finalFpH, orient));
        }
        AddAnchorEntry(slot.Id);
        AddAnchorEntry(slot.SlotGroupId);

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
            .Where(t => !HasRealCategories(slot) || slot.AllowedCategories.ContainsKey(t.Group))
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

    // =========================================================================
    // Rug catalog resolution (RoomTypeSlot.RugSlot) — bypasses FilterTiles entirely.
    // A rug slot's candidates come from the RugDefinition catalog, not TileDefinition
    // entries; each eligible RugDefinition is assembled into a transient, never-persisted
    // TileDefinition-shaped object at the slot's resolved target size, then flows through
    // the exact same SelectTile/anchor/FindFreeCell/emission pipeline as any other tile.
    // =========================================================================

    private readonly record struct RoomBounds(int MinCol, int MaxCol, int MinRow, int MaxRow)
    {
        public int Width  => MaxCol - MinCol + 1;
        public int Height => MaxRow - MinRow + 1;
    }

    private static RoomBounds ComputeRoomBounds(HashSet<(int, int)> roomCells) => new(
        roomCells.Min(c => c.Item1), roomCells.Max(c => c.Item1),
        roomCells.Min(c => c.Item2), roomCells.Max(c => c.Item2));

    /// <summary>
    /// Longest contiguous run of cells along one axis of the room's bounding box for which a
    /// full `shortAxis`-wide band is actually present in roomCells — i.e. the longest stretch
    /// a fill-sized rug could cover as one solid rectangle. Bounding-box-derived (still doesn't
    /// know about true room polygon shape beyond this one scan — an L-shaped room's legs are
    /// each scored as their own run, so the longer leg wins), but unlike a pure bbox length this
    /// correctly stops at internal gaps the bbox doesn't know about — most notably a stairwell's
    /// blocked middle cells carved out of allRoomCells (see ComputeStairCells) — instead of
    /// sizing a rug that can never fit anywhere and always fails to place.
    /// </summary>
    private static int LongestFittableRun(HashSet<(int, int)> roomCells, RoomBounds b, bool isHorizontal, int shortAxis)
    {
        int best = 0;
        if (isHorizontal)
        {
            for (int rowStart = b.MinRow; rowStart + shortAxis - 1 <= b.MaxRow; rowStart++)
            {
                int run = 0;
                for (int col = b.MinCol; col <= b.MaxCol; col++)
                {
                    bool bandFree = true;
                    for (int r = rowStart; r < rowStart + shortAxis; r++)
                        if (!roomCells.Contains((col, r))) { bandFree = false; break; }
                    run = bandFree ? run + 1 : 0;
                    if (run > best) best = run;
                }
            }
        }
        else
        {
            for (int colStart = b.MinCol; colStart + shortAxis - 1 <= b.MaxCol; colStart++)
            {
                int run = 0;
                for (int row = b.MinRow; row <= b.MaxRow; row++)
                {
                    bool bandFree = true;
                    for (int c = colStart; c < colStart + shortAxis; c++)
                        if (!roomCells.Contains((c, row))) { bandFree = false; break; }
                    run = bandFree ? run + 1 : 0;
                    if (run > best) best = run;
                }
            }
        }
        return best;
    }

    private static (int width, int height) ComputeRugFillSize(HashSet<(int, int)> roomCells, RugSizing sizing)
    {
        var b = ComputeRoomBounds(roomCells);
        bool isHorizontal = b.Width >= b.Height;
        int shortAxis = sizing.FillShortAxis;

        int fittableRun = LongestFittableRun(roomCells, b, isHorizontal, shortAxis);
        int longTarget = Math.Max(shortAxis, fittableRun - 2 * sizing.FillMarginEachEnd);
        longTarget = Math.Min(longTarget, fittableRun);
        if (sizing.FillMaxLongAxis is { } cap) longTarget = Math.Min(longTarget, cap);

        return isHorizontal ? (longTarget, shortAxis) : (shortAxis, longTarget);
    }

    /// <summary>
    /// Builds a full [row][col] tileId grid for a modular RugDefinition at exactly (w,h).
    /// Corner roles always occupy the 4 corner cells; edge roles fill the remaining border
    /// cells on their side; Center fills everything else. Corner checks are evaluated before
    /// edge checks, so at w==2 or h==2 every cell on that axis matches a corner condition
    /// first — the two corners on that axis simply abut with no separate edge row/column,
    /// falling out of the ordering with no special-case branch needed.
    /// </summary>
    private static List<List<string>> AssembleModularRugLayout(RugDefinition rug, int w, int h)
    {
        var grid = new List<List<string>>(h);
        for (int r = 0; r < h; r++)
        {
            bool isTopRow = r == 0, isBottomRow = r == h - 1;
            var row = new List<string>(w);
            for (int c = 0; c < w; c++)
            {
                bool isLeftCol = c == 0, isRightCol = c == w - 1;
                string role =
                    (isTopRow    && isLeftCol)  ? RugRole.TL :
                    (isTopRow    && isRightCol) ? RugRole.TR :
                    (isBottomRow && isLeftCol)  ? RugRole.BL :
                    (isBottomRow && isRightCol) ? RugRole.BR :
                    isTopRow    ? RugRole.N :
                    isBottomRow ? RugRole.S :
                    isLeftCol   ? RugRole.W :
                    isRightCol  ? RugRole.E :
                    RugRole.Center;
                row.Add(rug.Pieces.GetValueOrDefault(role, string.Empty));
            }
            grid.Add(row);
        }
        return grid;
    }

    private static List<TileDefinition> BuildRugCandidates(
        IReadOnlyDictionary<string, RugDefinition> rugCatalog, RoomTypeSlot slot,
        string roomTypeName, HashSet<(int, int)> roomCells, (int w, int h)? sizeOverride = null)
    {
        var rugSlot = slot.RugSlot!;
        // sizeOverride (matchAnchorCluster mode) wins over both fixed and fill — the caller has
        // already resolved the real target size from the anchor cluster's bounding box.
        var (targetW, targetH) = sizeOverride is { } o ? (o.w, o.h)
            : rugSlot.Sizing.Mode.Equals("fill", StringComparison.OrdinalIgnoreCase)
            ? ComputeRugFillSize(roomCells, rugSlot.Sizing)
            : (slot.Footprint.Width, slot.Footprint.Height);

        var eligible = rugCatalog.Values
            .Where(r => r.RoomTypes.Count == 0
                     || string.IsNullOrEmpty(roomTypeName)
                     || r.RoomTypes.Any(rt => rt.Equals(roomTypeName, StringComparison.OrdinalIgnoreCase)))
            .Where(r => rugSlot.AllowedRugIds.Count == 0 || rugSlot.AllowedRugIds.Contains(r.Id))
            .Where(r => rugSlot.ModeFilter.Equals("any", StringComparison.OrdinalIgnoreCase)
                     || r.Mode.Equals(rugSlot.ModeFilter, StringComparison.OrdinalIgnoreCase));

        var result = new List<TileDefinition>();
        foreach (var rug in eligible)
        {
            List<List<string>>? layout = rug.Mode.Equals("modular", StringComparison.OrdinalIgnoreCase)
                ? (targetW >= rug.MinWidth && targetH >= rug.MinHeight ? AssembleModularRugLayout(rug, targetW, targetH) : null)
                : rug.PreassembledSizes.FirstOrDefault(sz => sz.Width == targetW && sz.Height == targetH)?.TileLayout
                  ?? (slot.Footprint.CanRotate ? rug.PreassembledSizes.FirstOrDefault(sz => sz.Width == targetH && sz.Height == targetW)?.TileLayout : null);
            if (layout is null) continue;

            result.Add(new TileDefinition
            {
                Id = rug.Id, TileId = rug.Id, Label = rug.Label,
                TileLayout = layout, Group = rug.Group, Layer = "FloorFurniture",
                // TileDefinition.IsHigh defaults to true (see TileDefinition.cs) — a rug is
                // floor decor, never "high" furniture, so it must be explicitly overridden here
                // or ViolatesWindowPlacement wrongly treats it as window-blocking.
                IsHigh = false, IsMedium = false,
                HasCollision = false, VariantGroup = rug.VariantGroup,
                Colors = rug.Colors, Materials = rug.Materials, RoomTypes = rug.RoomTypes,
            });
        }
        return result;
    }

    /// <summary>
    /// Bounding box of an anchor parent's placed instance unioned with every other already-placed
    /// slot instance that also anchors to it (RequiresSlot == parentSlotId) — e.g. a dining table
    /// plus its 4 chairs. Generic (not rug-specific): reusable anywhere "parent + its anchored
    /// children as one footprint" is needed. Returns null if the parent itself isn't placed yet
    /// (shouldn't happen given required-before-optional slot ordering, but degrades gracefully).
    /// </summary>
    private static (int col, int row, int w, int h, string orient)? ComputeAnchorClusterBounds(
        string parentSlotId,
        Dictionary<string, List<(int col, int row, int fpW, int fpH, string orient)>> anchorMap,
        List<RoomTypeSlot> allSlots,
        string excludeSlotId,
        int parentInstanceIndex = 0,
        IEnumerable<string>? extraMemberIds = null,
        bool includeRequiringSlots = true)
    {
        if (!anchorMap.TryGetValue(parentSlotId, out var parentInstances)
            || parentInstanceIndex >= parentInstances.Count)
            return null;

        var (pc, pr, pw, ph, parentOrient) = parentInstances[parentInstanceIndex];
        int minCol = pc, minRow = pr, maxCol = pc + pw - 1, maxRow = pr + ph - 1;

        foreach (var child in includeRequiringSlots ? allSlots : [])
        {
            if (child.Id == excludeSlotId || !child.RequiresSlot.Equals(parentSlotId, StringComparison.OrdinalIgnoreCase))
                continue;
            if (!anchorMap.TryGetValue(child.Id, out var childInstances))
                continue;
            foreach (var (cc, cr, cw, ch, _) in childInstances)
            {
                minCol = Math.Min(minCol, cc); minRow = Math.Min(minRow, cr);
                maxCol = Math.Max(maxCol, cc + cw - 1); maxRow = Math.Max(maxRow, cr + ch - 1);
            }
        }

        // Grid parent (see GridClusterMemberIds): every placed cell of the grid is a member.
        foreach (var memberId in extraMemberIds ?? [])
        {
            if (!anchorMap.TryGetValue(memberId, out var memberInstances)) continue;
            foreach (var (cc, cr, cw, ch, _) in memberInstances)
            {
                minCol = Math.Min(minCol, cc); minRow = Math.Min(minRow, cr);
                maxCol = Math.Max(maxCol, cc + cw - 1); maxRow = Math.Max(maxRow, cr + ch - 1);
            }
        }

        return (minCol, minRow, maxCol - minCol + 1, maxRow - minRow + 1, parentOrient);
    }

    private static TileDefinition? SelectTile(List<TileDefinition> candidates, RoomTypeSlot slot, Random rng)
    {
        if (candidates.Count == 0) return null;
        if (!HasRealCategories(slot)) return candidates[rng.Next(candidates.Count)];

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
        "isMedium"      => t.IsMedium,
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
        HashSet<(int, int)>? blockedFrontCells,
        TileDefinition baseTile,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        PlacementRules rules,
        Random rng,
        List<string>? debugLog,
        HashSet<string>? innerWallKeys,
        HashSet<(int, int)>? mainSubRoomCells,
        List<HashSet<(int, int)>>? openingGroups,
        out (int noVariant, int noWallDir, int noFits, int noPath, int noLoot, int door, int window, int connectivity) rejCounters,
        Dictionary<(int, int), HashSet<string>>? cellPropertyGates = null,
        HashSet<(int, int)>? reservedZoneCells = null,
        HashSet<(int, int)>? frontExemptCells = null,
        HashSet<(int, int)>? gapCells = null,
        HashSet<(int, int)>? decorPathCells = null,
        HashSet<(int, int)>? floorLayerOccupied = null,
        HashSet<(int, int)>? stairEndCells = null,
        string? requiredColor = null,
        string? requiredMaterial = null,
        HashSet<(int, int)>? narrowCells = null)
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
        if (rules.AvoidCorners) pool = pool.Where(c => !(cellWalls.TryGetValue(c, out var w) && w.Count >= 2));

        // Pfad-Schutz: Möbel mit Kollision dürfen nicht auf Laufwegen stehen,
        // außer der Slot erlaubt es explizit (AllowOnPath = true).
        if (!rules.AllowOnPath && baseTile.HasCollision && pathCells.Count > 0)
            pool = pool.Where(c => !pathCells.Contains(c));
        if (rules.MainSubRoom && mainSubRoomCells != null)
            pool = pool.Where(c => mainSubRoomCells.Contains(c));

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

        // entryCells/protectedCells are invariant across the candidate loop below (they only
        // depend on physicalOccupied, which doesn't change until a slot is actually placed),
        // so compute them once here instead of per-candidate.
        var entryCells = openingGroups is { Count: > 0 }
            ? new HashSet<(int, int)>(doorCells.Concat(openingGroups.SelectMany(g => g)))
            : doorCells;
        var protectedCells = ComputeProtectedCells(roomCells, physicalOccupied, entryCells, innerWallKeys);

        int rejNoVariant = 0, rejNoWallDir = 0, rejFits = 0, rejPath = 0, rejLoot = 0, rejDoor = 0, rejWindow = 0, rejConnectivity = 0;
        foreach (var cell in poolList)
        {
            var variants = ResolveVariantsForCell(baseTile, cell, cellWalls, allTiles, rules, slot.Required, requiredColor, requiredMaterial);
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
                if (rules.NearWall && (!FootprintTouchesWallDir(anchorCol, anchorRow, fpW, fpH, cellWalls, wallDir)
                    || !FootprintFullyBacked(anchorCol, anchorRow, fpW, fpH, wallDir, resolvedTile, cellWalls, roomCells)))
                { rejNoWallDir++; continue; }

                if (!FitsFootprint(anchorCol, anchorRow, fpW, fpH, roomCells, occupied, softOccupied, blockedFrontCells, innerWallKeys, resolvedTile, floorLayerOccupied, stairEndCells, narrowCells))
                {
                    rejFits++;
                    if (traceBathtub && debugLog is not null)
                        debugLog.Add($"    [TRACE] '{slot.Id}': reject FITS cell=({cell.col},{cell.row}) anchor=({anchorCol},{anchorRow}) orient='{orient}' fp={fpW}x{fpH}");
                    continue;
                }

                if (!SatisfiesCellPropertyGates(anchorCol, anchorRow, fpW, fpH, resolvedTile, cellPropertyGates))
                {
                    rejFits++;
                    continue;
                }

                if (BlockedByReservedZone(anchorCol, anchorRow, fpW, fpH, resolvedTile, reservedZoneCells))
                {
                    rejFits++;
                    continue;
                }

                // Zelle vor der Vorderseite muss frei bleiben (Herd, Kühlschrank, ...).
                if (slot.BlocksFrontCell)
                {
                    var frontCells = FrontCells(anchorCol, anchorRow, fpW, fpH, orient);
                    if (frontCells.Count == 0 || frontCells.Any(fc =>
                        !roomCells.Contains(fc) || physicalOccupied.Contains(fc) ||
                        (occupied.Contains(fc) && !(frontExemptCells?.Contains(fc) ?? false)))
                        || FootprintTouchesWallDir(anchorCol, anchorRow, fpW, fpH, cellWalls, Enum.Parse<Direction>(orient)))
                    {
                        rejFits++;
                        continue;
                    }
                }

                // Pfad-Schutz auf Footprint-Ebene: Der Pool-Filter oben prüft nur die Ankerzelle.
                // Nach ComputeWallAnchor kann der verschobene Anker Pfadzellen überdecken
                // (z.B. cell=(4,4), wallDir=S, anchor=(4,3) = Pfadzelle).
                if (!rules.AllowOnPath && resolvedTile.HasCollision && pathCells.Count > 0
                    && FootprintTouchesCells(anchorCol, anchorRow, fpW, fpH, pathCells)) { rejPath++; continue; }

                // Post-placement-Laufweg (UsePostPlacementPathAvoidance): hält freistehende
                // kollisionsfreie Deko vom realen, nach der Struktur-Möblierung berechneten
                // Laufweg fern. FloorFurniture-Deko (Teppiche etc.) UND Wand-Deko (Bilder,
                // Wandlampen, Spiegel) bleiben ausgenommen — beide stehen nicht im Laufweg
                // am Boden, dürfen wie bisher überall platziert werden (s. IsExemptFromReservedZone,
                // dieselbe Ausnahme wie bei Sperrzonen).
                if (!rules.AllowOnPath && !resolvedTile.HasCollision && !IsExemptFromReservedZone(resolvedTile)
                    && decorPathCells is { Count: > 0 }
                    && FootprintTouchesCells(anchorCol, anchorRow, fpW, fpH, decorPathCells)) { rejPath++; continue; }

                // Türbereich freilassen: kein Möbel-Footprint darf eine Türzelle überdecken,
                // außer der Slot ist explizit NearDoor (z.B. Garderobenhalter an der Tür), oder
                // es ist kollisionsfreie FloorFurniture-Deko (z.B. Teppich) — die blockiert die
                // Tür nicht physisch, siehe IsFloorFurnitureNoCollision.
                if (!rules.NearDoor && !IsFloorFurnitureNoCollision(resolvedTile)
                    && FootprintTouchesCells(anchorCol, anchorRow, fpW, fpH, doorCells)) { rejDoor++; continue; }

                // Gap-Zellen sind die einzige Passage durch eine Innenwand — genau wie eine echte
                // Tür/Opening behandeln (pauschal gesperrt, unabhängig von Layer/Kollision).
                // Macht keinen Sinn, dass irgendetwas, auch kollisionsfreie Deko, direkt in
                // einer schmalen Durchgangszelle steht.
                if (!rules.NearDoor && gapCells is { Count: > 0 }
                    && FootprintTouchesCells(anchorCol, anchorRow, fpW, fpH, gapCells))
                { rejDoor++; continue; }

                if (openingGroups is { Count: > 0 } &&
                    !OpeningGroupsAllowPlacement(anchorCol, anchorRow, fpW, fpH, resolvedTile.HasCollision, physicalOccupied, openingGroups)) { rejDoor++; continue; }
                if (resolvedTile.IsHigh && openingGroups is { Count: > 0 }
                    && openingGroups.Any(g => g.Any(c =>
                        c.Item1 >= anchorCol && c.Item1 < anchorCol + fpW &&
                        c.Item2 >= anchorRow && c.Item2 < anchorRow + fpH)))
                    { rejDoor++; continue; }

                // Fensterschutz:
                // - Standard: IsHigh/IsMedium dürfen keine Fensterzellen berühren.
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

                if (resolvedTile.HasCollision
                    && !RoomRemainsConnected(anchorCol, anchorRow, fpW, fpH, roomCells, physicalOccupied, entryCells, innerWallKeys, protectedCells))
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
        var backExpected = BackWallOf(baseTile);
        return (backExpected.HasValue && wallDirs.Contains(backExpected.Value))
            ? backExpected.Value
            : wallDirs.OrderByDescending(d => d).First();
    }

    private static (TileDefinition tile, string orient, Direction wallDir)? ResolveVariantForCell(
        TileDefinition baseTile,
        (int col, int row) cell,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        IReadOnlyDictionary<string, TileDefinition> allTiles,
        PlacementRules rules,
        string? requiredColor = null,
        string? requiredMaterial = null)
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
            && !AllowedOrientsMatch(baseTile, neededOrient))
            return null; // neededOrient ist für dieses Tile nicht erlaubt → Zelle ablehnen

        // Prüfe ob baseTile selbst schon passt (richtiger Orient + passendes Aspektverhältnis)
        if (OrientMatches(baseTile, neededOrient)
            && MatchesAlignment(baseTile, wallDir, rules.WallAlignment))
            return (baseTile, neededOrient, wallDir);

        // AllowedOrients enthält neededOrient explizit → Tile ist symmetrisch/multi-direktional
        // und kann in dieser Orientierung verwendet werden (z.B. 1×2-Regal mit allowedOrients=[W,E])
        if (baseTile.AllowedOrients.Count > 0
            && AllowedOrientsMatch(baseTile, neededOrient)
            && MatchesAlignment(baseTile, wallDir, rules.WallAlignment))
            return (baseTile, neededOrient, wallDir);

        // Suche in VariantGroup nach passender Variante
        if (!string.IsNullOrEmpty(baseTile.VariantGroup))
        {
            var variants = allTiles.Values
                .Where(t => t.VariantGroup == baseTile.VariantGroup
                         && OrientMatches(t, neededOrient))
                .ToList();

            // Color/material lock (from the slot's colorGroupId/materialGroupId) must survive
            // this wall-orientation re-search too, not just the initial candidate pool — without
            // this, two same-VariantGroup cabinets landing on differently-oriented walls could
            // silently resolve to different-colored siblings even though the room's color was
            // already locked in (see PlaceSlot's [COLOR] pre-seed). Narrows first; if nothing
            // matches, falls back to the unfiltered set rather than rejecting the cell outright
            // (mirrors every other color/material filter in this file: "no match → keep pool").
            if (variants.Count > 0 && !string.IsNullOrEmpty(requiredColor))
            {
                var colorMatched = variants.Where(t => t.Colors.Any(c => c.Equals(requiredColor, StringComparison.OrdinalIgnoreCase))).ToList();
                if (colorMatched.Count > 0) variants = colorMatched;
            }
            if (variants.Count > 0 && !string.IsNullOrEmpty(requiredMaterial))
            {
                var materialMatched = variants.Where(t => t.Materials.Any(m => m.Equals(requiredMaterial, StringComparison.OrdinalIgnoreCase))).ToList();
                if (materialMatched.Count > 0) variants = materialMatched;
            }

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
        bool requiredSlot,
        string? requiredColor = null,
        string? requiredMaterial = null)
    {
        if (rules.NearWall)
        {
            var one = ResolveVariantForCell(baseTile, cell, cellWalls, allTiles, rules, requiredColor, requiredMaterial);
            if (!requiredSlot)
                return one.HasValue ? [one.Value] : [];

            var ordered = new List<(TileDefinition tile, string orient, Direction wallDir)>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            var wallDirOpt = ResolveWallDirForCell(baseTile, cell, cellWalls);
            if (!wallDirOpt.HasValue) return one.HasValue ? [one.Value] : [];
            var wallDir = wallDirOpt.Value;

            if (string.IsNullOrEmpty(baseTile.VariantGroup))
                return one.HasValue ? [one.Value] : [];

            // Layer must match too — a shared VariantGroup can legitimately span layers (e.g. a
            // hanging counter's Wallfurniture tile shares its floor counter's VariantGroup so
            // tileGroupId can lock them to matching colors), and without this guard a floor
            // slot's own variant search could pick up a Wallfurniture tile of the same group.
            var groupVariants = allTiles.Values
                .Where(t => t.VariantGroup.Equals(baseTile.VariantGroup, StringComparison.OrdinalIgnoreCase)
                         && t.Layer.Equals(baseTile.Layer, StringComparison.OrdinalIgnoreCase))
                .ToList();

            // Same color/material lock as ResolveVariantForCell's single-result path above —
            // narrows first, falls back to the unfiltered set if nothing matches.
            if (groupVariants.Count > 0 && !string.IsNullOrEmpty(requiredColor))
            {
                var colorMatched = groupVariants.Where(t => t.Colors.Any(c => c.Equals(requiredColor, StringComparison.OrdinalIgnoreCase))).ToList();
                if (colorMatched.Count > 0) groupVariants = colorMatched;
            }
            if (groupVariants.Count > 0 && !string.IsNullOrEmpty(requiredMaterial))
            {
                var materialMatched = groupVariants.Where(t => t.Materials.Any(m => m.Equals(requiredMaterial, StringComparison.OrdinalIgnoreCase))).ToList();
                if (materialMatched.Count > 0) groupVariants = materialMatched;
            }

            var cellWallDirs = cellWalls.TryGetValue(cell, out var dirsAtCell) ? dirsAtCell : new HashSet<Direction>();

            bool AllowedByOwnOrient(TileDefinition t) => t.AllowedOrients.Count == 0
                || t.AllowedOrients.Any(o => o.Equals(t.Orientation, StringComparison.OrdinalIgnoreCase));

            bool BackOnCellWall(TileDefinition t)
            {
                var back = BackWallOf(t);
                return back.HasValue && cellWallDirs.Contains(back.Value);
            }

            Direction CandidateWallDir(TileDefinition t)
            {
                var back = BackWallOf(t);
                // Immer die Rücken-Wandrichtung des Tiles verwenden.
                // Caller stellt sicher dass BackOnCellWall=true ist.
                return back.HasValue ? back.Value : wallDir;
            }

            // 0) Echte Ecke (2 Wandrichtungen): bevorzugt die eigens dafür gedachte diagonale
            //    Variante (Orientation NW/NE/SE/SW), falls die Gruppe eine solche besitzt —
            //    sieht als richtiges Eckstück aus statt einer geraden Theke an nur einer Wand.
            //    BackWall() kennt nur einfache N/S/E/W-Orientierungen, daher separat behandelt.
            if (cellWallDirs.Count == 2 && ComputeCornerOrient(cellWallDirs) is { } cornerOrient)
            {
                var cornerVariants = groupVariants
                    .Where(t => AllowedByOwnOrient(t)
                                && t.Orientation.Equals(cornerOrient, StringComparison.OrdinalIgnoreCase))
                    .ToList();

                foreach (var t in cornerVariants)
                    if (seen.Add(t.TileId))
                        ordered.Add((t, CanonicalOrient(t), wallDir));
            }

            // 1) Präferenz: Rücken liegt auf einer echten Wand der Kandidatenzelle + Alignment passt.
            var strict = groupVariants
                .Where(t => AllowedByOwnOrient(t)
                            && BackOnCellWall(t)
                            && MatchesAlignment(t, CandidateWallDir(t), rules.WallAlignment))
                .OrderBy(t => 0)
                .ThenBy(t => OrientMatches(t, CanonicalOrient(baseTile)) ? 0 : 1)
                .ToList();

            foreach (var t in strict)
                if (seen.Add(t.TileId))
                    ordered.Add((t, CanonicalOrient(t), CandidateWallDir(t)));

            // 2) Last-resort: Rücken an echter Wand MUSS erhalten bleiben, nur WallAlignment relaxen.
            //    Varianten ohne Wandkontakt (z.B. Dusche in SE-Ecke ohne N/W-Wand) werden
            //    NICHT aufgenommen – physisch falsches Möbel vermeiden.
            var relaxed = groupVariants
                .Where(t => AllowedByOwnOrient(t) && BackOnCellWall(t))
                .OrderBy(t => 0)
                .ThenBy(t => OrientMatches(t, CanonicalOrient(baseTile)) ? 0 : 1)
                .ToList();

            foreach (var t in relaxed)
                if (seen.Add(t.TileId))
                    ordered.Add((t, CanonicalOrient(t), CandidateWallDir(t)));

            return ordered;
        }

        // Ohne NearWall: Für rotierbare VariantGroups alle Orientierungsvarianten prüfen,
        // damit 1×2/2×1-Slots (z.B. Badewanne in Ecken) nicht an einer Zufallsvariante hängen.
        if (string.IsNullOrEmpty(baseTile.VariantGroup))
            return [(baseTile, CanonicalOrient(baseTile), Direction.N)];

        var variants = allTiles.Values
            .Where(t => t.VariantGroup.Equals(baseTile.VariantGroup, StringComparison.OrdinalIgnoreCase)
                     && t.Layer.Equals(baseTile.Layer, StringComparison.OrdinalIgnoreCase))
            .Where(t => t.AllowedOrients.Count == 0
                     || t.AllowedOrients.Any(o => o.Equals(t.Orientation, StringComparison.OrdinalIgnoreCase)))
            .OrderBy(t => OrientMatches(t, CanonicalOrient(baseTile)) ? 0 : 1)
            .Select(t => (t, CanonicalOrient(t), Direction.N))
            .ToList();

        if (variants.Count > 0) return variants;

        // Fallback: Alle Varianten der Gruppe durch AllowedOrients rausgefiltert
        // (z.B. orientation="E" aber allowedOrients=["W"]).
        // baseTile nur zurückgeben wenn seine eigene Orientation durch AllowedOrients erlaubt ist –
        // verhindert dass ein widersprüchlich konfiguriertes Tile ungefiltert landet.
        if (baseTile.AllowedOrients.Count == 0
            || baseTile.AllowedOrients.Any(o => o.Equals(baseTile.Orientation, StringComparison.OrdinalIgnoreCase)))
            return [(baseTile, CanonicalOrient(baseTile), Direction.N)];

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
        HashSet<(int, int)>? softOccupied = null,
        HashSet<(int, int)>? blockedFrontCells = null,
        HashSet<string>? innerWallKeys = null,
        TileDefinition? tile = null,
        HashSet<(int, int)>? floorLayerOccupied = null,
        HashSet<(int, int)>? stairEndCells = null,
        HashSet<(int, int)>? narrowCells = null)
    {
        // FloorFurniture-Deko ohne Kollision (z.B. Teppich) darf trotzdem in der "Zelle vor
        // dem Möbel muss frei bleiben"-Zone eines anderen Slots liegen (siehe IsFloorFurnitureNoCollision).
        bool exemptFromFrontBlock = tile is not null && IsFloorFurnitureNoCollision(tile);

        // Stair landings (the 2 end cells of a 5-cell stair span, see ComputeStairCells) stay
        // walkable floor, so FloorOverlay/FloorFurniture tiles (rugs, floor decor) may still be
        // placed there — but anything else (chairs, cabinets, lamps, ...) may not. Layer-only
        // check (unlike exemptFromFrontBlock above, deliberately not collision-gated): a rug
        // WITH collision would still count as floor-layer here.
        bool isFloorLayerTile = tile is not null &&
            (tile.Layer.Equals("FloorOverlay", StringComparison.OrdinalIgnoreCase) ||
             tile.Layer.Equals("FloorFurniture", StringComparison.OrdinalIgnoreCase));

        // Ein solches Teppich-artiges Tile liegt auf dem Boden UNTER anderen Möbeln (Stühle,
        // Tische, ...) — es darf also Zellen überlappen, die ein Nicht-FloorFurniture-Slot
        // (z.B. ein Stuhl) belegt, solange dort nicht schon ein anderes FloorFurniture-Tile
        // liegt. floorLayerOccupied != null aktiviert diese engere, layer-genaue Prüfung
        // anstelle des pauschalen `occupied`-Sets.
        bool useFloorLayerOccupied = exemptFromFrontBlock && floorLayerOccupied is not null;

        // 1-wide necks/corridors (see NarrowAreaDetector): only wall-mounted or floor-layer
        // tiles may go there, regardless of collision — anything else would block the passage.
        bool narrowExempt = tile is not null && IsNarrowExempt(tile);

        for (int r = 0; r < fpH; r++)
            for (int c = 0; c < fpW; c++)
            {
                var cell = (col + c, row + r);
                if (!roomCells.Contains(cell)) return false;
                if (useFloorLayerOccupied)
                {
                    // floorLayerOccupied already captures every FloorFurniture-layer occupant
                    // (hard- or soft-blocked alike, see PlaceSlot's placement loop) — that's the
                    // precise "is the floor itself already spoken for" check a floor-decor tile
                    // needs, so it replaces BOTH occupied and softOccupied here rather than only
                    // occupied: a non-floor-layer slot's softBlocks (e.g. a cabinet) must not
                    // block a rug from lying underneath it any more than a hard block would.
                    if (floorLayerOccupied!.Contains(cell)) return false;
                }
                else
                {
                    if (occupied.Contains(cell)) return false;
                    if (softOccupied?.Contains(cell) == true) return false;
                }
                if (!exemptFromFrontBlock && blockedFrontCells?.Contains(cell) == true) return false;
                if (!isFloorLayerTile && stairEndCells?.Contains(cell) == true) return false;
                if (!narrowExempt && narrowCells?.Contains(cell) == true) return false;
            }
        // Reject if any inner wall edge runs through the interior of the footprint
        if (innerWallKeys is { Count: > 0 })
        {
            for (int r = 0; r < fpH; r++)
                for (int c = 1; c < fpW; c++)  // vertical edges between columns
                    if (innerWallKeys.Contains($"V:{col + c},{row + r}")) return false;
            for (int r = 1; r < fpH; r++)
                for (int c = 0; c < fpW; c++)  // horizontal edges between rows
                    if (innerWallKeys.Contains($"H:{col + c},{row + r}")) return false;
        }
        return true;
    }

    /// <summary>
    /// Prüft, ob ein Kandidat-Tile die Eigenschafts-Anforderungen erfüllt, die andere Slots
    /// per CellRequiredProperties auf den Footprint-Zellen hinterlegt haben (siehe
    /// LayoutPlacementState.CellPropertyGates / PlaceSlot's cellPropertyGates).
    /// Jede berührte Zelle mit Anforderungen verlangt, dass ALLE ihre Properties erfüllt sind.
    /// </summary>
    private static bool SatisfiesCellPropertyGates(
        int col, int row, int fpW, int fpH, TileDefinition tile,
        Dictionary<(int, int), HashSet<string>>? gates)
    {
        if (gates is null || gates.Count == 0) return true;
        for (int r = 0; r < fpH; r++)
            for (int c = 0; c < fpW; c++)
                if (gates.TryGetValue((col + c, row + r), out var required)
                    && !required.All(p => GetBoolProperty(tile, p)))
                    return false;
        return true;
    }

    /// <summary>
    /// Sperrzonen (z.B. "Car"-Stellplatz) dürfen trotzdem von wandmontierten Möbeln oder
    /// bodenauflagenartigen Deko-Objekten genutzt werden, solange diese keine Kollision haben
    /// (z.B. Werkzeugregal über dem Auto, Ölfleck-Deko auf dem Boden).
    /// </summary>
    private static bool IsExemptFromReservedZone(TileDefinition tile) =>
        !tile.HasCollision &&
        (tile.Layer.StartsWith("Wall", StringComparison.OrdinalIgnoreCase) ||
         tile.Layer.Equals("FloorFurniture", StringComparison.OrdinalIgnoreCase));

    /// <summary>Tiles allowed on narrow cells: any Wall* layer, FloorFurniture or FloorOverlay.</summary>
    private static bool IsNarrowExempt(TileDefinition tile) =>
        tile.Layer.StartsWith("Wall", StringComparison.OrdinalIgnoreCase) ||
        tile.Layer.Equals("FloorFurniture", StringComparison.OrdinalIgnoreCase) ||
        tile.Layer.Equals("FloorOverlay", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// FloorFurniture-Deko ohne Kollision (z.B. Teppich) darf trotzdem in der "Zelle vor
    /// dem Möbel muss frei bleiben"-Zone eines anderen Slots liegen (BlocksFrontCell).
    /// </summary>
    private static bool IsFloorFurnitureNoCollision(TileDefinition tile) =>
        !tile.HasCollision && tile.Layer.Equals("FloorFurniture", StringComparison.OrdinalIgnoreCase);

    // =========================================================================
    // Post-placement path avoidance (UsePostPlacementPathAvoidance)
    // =========================================================================

    /// <summary>
    /// Freistehende Deko = kein AnchorRule (nicht an ein Kollisions-Möbel gekoppelt, z.B.
    /// Lampe→Nachttisch oder Spiegel→Waschbecken bleiben dadurch in der Struktur-Phase)
    /// UND alle passenden Tiles sind kollisionsfrei. Solche Slots werden bei aktivem
    /// UsePostPlacementPathAvoidance erst NACH allen Struktur-Möbeln platziert.
    /// </summary>
    private static bool IsFreestandingDecorSlot(RoomTypeSlot slot, IReadOnlyDictionary<string, TileDefinition> allTiles, string roomTypeName)
    {
        if (slot.AnchorRules is { Count: > 0 }) return false;
        var candidates = FilterTiles(allTiles, slot, roomTypeName);
        return candidates.Count > 0 && candidates.All(t => !t.HasCollision);
    }

    /// <summary>
    /// Berechnet einen realen Laufweg durch den bereits mit Struktur-Möbeln befüllten Raum,
    /// um freistehende Deko davon fernzuhalten (s. RoomTypeConfig.UsePostPlacementPathAvoidance).
    /// ≥2 erreichbare Türzellen: Kette von Kürzeste-Wege (BFS) zwischen aufeinanderfolgenden
    /// Türen. Genau 1 Tür: Flood-Fill ab der Tür, Weg zur am weitesten entfernten erreichbaren
    /// Zelle. Keine erreichbare Tür: leeres Ergebnis (keine zusätzliche Einschränkung).
    /// </summary>
    private static HashSet<(int, int)> ComputePostPlacementPathCells(
        HashSet<(int, int)> roomCells,
        HashSet<(int, int)> doorCells,
        HashSet<(int, int)> physicalOccupied)
    {
        var passable = new HashSet<(int, int)>(roomCells);
        passable.ExceptWith(physicalOccupied);
        if (passable.Count == 0)
            return [];

        var doors = doorCells.Where(passable.Contains).Distinct().ToList();
        if (doors.Count == 0)
            return [];

        if (doors.Count == 1)
            return FloodFillFarthestPath(doors[0], passable);

        var pathSet = new HashSet<(int, int)>();
        for (int i = 0; i < doors.Count - 1; i++)
            foreach (var cell in BfsShortestPath(doors[i], doors[i + 1], passable))
                pathSet.Add(cell);
        return pathSet;
    }

    private static readonly int[] Bfs4Dx = [-1, 1, 0, 0];
    private static readonly int[] Bfs4Dy = [0, 0, -1, 1];

    private static HashSet<(int, int)> FloodFillFarthestPath((int, int) start, HashSet<(int, int)> passable)
    {
        var dist = new Dictionary<(int, int), int> { [start] = 0 };
        var prev = new Dictionary<(int, int), (int, int)>();
        var queue = new Queue<(int, int)>();
        queue.Enqueue(start);

        while (queue.Count > 0)
        {
            var cur = queue.Dequeue();
            for (int d = 0; d < 4; d++)
            {
                var nb = (cur.Item1 + Bfs4Dx[d], cur.Item2 + Bfs4Dy[d]);
                if (!passable.Contains(nb) || dist.ContainsKey(nb)) continue;
                dist[nb] = dist[cur] + 1;
                prev[nb] = cur;
                queue.Enqueue(nb);
            }
        }

        if (dist.Count <= 1)
            return [];

        var farthest = dist.OrderByDescending(kv => kv.Value).First().Key;
        var path = new HashSet<(int, int)>();
        var node = farthest;
        while (!node.Equals(start)) { path.Add(node); node = prev[node]; }
        path.Add(start);
        return path;
    }

    private static List<(int, int)> BfsShortestPath((int, int) start, (int, int) goal, HashSet<(int, int)> passable)
    {
        if (start.Equals(goal)) return [start];

        var prev = new Dictionary<(int, int), (int, int)>();
        var visited = new HashSet<(int, int)> { start };
        var queue = new Queue<(int, int)>();
        queue.Enqueue(start);

        while (queue.Count > 0)
        {
            var cur = queue.Dequeue();
            if (cur.Equals(goal))
            {
                var path = new List<(int, int)>();
                var node = goal;
                while (!node.Equals(start)) { path.Add(node); node = prev[node]; }
                path.Add(start);
                path.Reverse();
                return path;
            }

            for (int d = 0; d < 4; d++)
            {
                var nb = (cur.Item1 + Bfs4Dx[d], cur.Item2 + Bfs4Dy[d]);
                if (!passable.Contains(nb) || visited.Contains(nb)) continue;
                visited.Add(nb);
                prev[nb] = cur;
                queue.Enqueue(nb);
            }
        }

        return [];
    }

    /// <summary>Prüft ob ein Kandidat-Tile an dieser Position durch eine Sperrzone blockiert wird.</summary>
    private static bool BlockedByReservedZone(
        int col, int row, int fpW, int fpH, TileDefinition tile,
        HashSet<(int, int)>? reservedZoneCells) =>
        reservedZoneCells is { Count: > 0 } &&
        FootprintTouchesCells(col, row, fpW, fpH, reservedZoneCells) &&
        !IsExemptFromReservedZone(tile);

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
    /// Zellen direkt vor der Vorderseite des Footprints (gemäß Orientierung).
    /// orient = Blickrichtung des Möbels, z.B. "S" → Zellen unterhalb des Footprints.
    /// </summary>
    private static List<(int, int)> FrontCells(int col, int row, int fpW, int fpH, string orient) => orient switch
    {
        "N" => Enumerable.Range(0, fpW).Select(c => (col + c, row - 1)).ToList(),
        "S" => Enumerable.Range(0, fpW).Select(c => (col + c, row + fpH)).ToList(),
        "W" => Enumerable.Range(0, fpH).Select(r => (col - 1, row + r)).ToList(),
        "E" => Enumerable.Range(0, fpH).Select(r => (col + fpW, row + r)).ToList(),
        _   => [],
    };

    private static bool ViolatesWindowPlacement(
        int col, int row, int fpW, int fpH,
        TileDefinition tile, string placedOrient,
        HashSet<(int, int)> windowCells)
    {
        if (windowCells.Count == 0) return false;

        var localEdge = NormalizeEdge(tile.WindowBlockedEdge);
        if (localEdge is not null)
        {
            var worldEdge = RotateEdge(localEdge, CanonicalOrient(tile), placedOrient);
            return FootprintTouchesEdge(col, row, fpW, fpH, windowCells, worldEdge);
        }

        // High furniture blocks the window entirely; medium-height furniture (e.g. a picture
        // hung at bedtable height) sits too low for a full-height window but still collides
        // with a windowsill, so it's blocked the same way.
        return (tile.IsHigh || tile.IsMedium) && FootprintTouchesCells(col, row, fpW, fpH, windowCells);
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
    /// Every footprint cell on the back edge (the side facing <paramref name="wallDir"/>) must be
    /// backed — FootprintTouchesWallDir only needs ONE, so a 1×2 piece could stick out past the
    /// end of a wall with its second half "in mid air". Backed = a real wall face, or, for pieces
    /// that aren't wall-mounted, an open boundary into another room (archway / Opening edge):
    /// the neighbour beyond is not part of this room. A neighbour inside this room (wall ends,
    /// inner-wall gap) is never backed. Floor-layer decor (rugs) is exempt.
    /// </summary>
    private static bool FootprintFullyBacked(int col, int row, int fpW, int fpH, Direction wallDir,
        TileDefinition tile, Dictionary<(int, int), HashSet<Direction>> cellWalls, HashSet<(int, int)> roomCells)
    {
        if (tile.Layer.Equals("FloorFurniture", StringComparison.OrdinalIgnoreCase)
            || tile.Layer.Equals("FloorOverlay", StringComparison.OrdinalIgnoreCase))
            return true;
        bool wallMounted = tile.Layer.StartsWith("Wall", StringComparison.OrdinalIgnoreCase);

        var (edge, dc, dr) = wallDir switch
        {
            Direction.N => (Enumerable.Range(col, fpW).Select(c => (c, row)), 0, -1),
            Direction.S => (Enumerable.Range(col, fpW).Select(c => (c, row + fpH - 1)), 0, 1),
            Direction.W => (Enumerable.Range(row, fpH).Select(r => (col, r)), -1, 0),
            Direction.E => (Enumerable.Range(row, fpH).Select(r => (col + fpW - 1, r)), 1, 0),
            _           => (Enumerable.Empty<(int, int)>(), 0, 0),
        };
        foreach (var (c, r) in edge)
        {
            if (cellWalls.TryGetValue((c, r), out var dirs) && dirs.Contains(wallDir)) continue;
            if (wallMounted || roomCells.Contains((c + dc, r + dr))) return false;
        }
        return true;
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
    /// Synthesizes the compound corner orientation (NW/NE/SW/SE) a true corner cell's two
    /// wall directions correspond to — tile-definitions convention: orientation=NW means the
    /// tile sits flush in the room's NW corner (touches both the north and west walls).
    /// Returns null if the given directions don't form one of the four valid corners.
    /// </summary>
    private static string? ComputeCornerOrient(HashSet<Direction> wallDirs)
    {
        bool n = wallDirs.Contains(Direction.N), s = wallDirs.Contains(Direction.S);
        bool e = wallDirs.Contains(Direction.E), w = wallDirs.Contains(Direction.W);
        return (n, s, e, w) switch
        {
            (true, false, false, true) => "NW",
            (true, false, true, false) => "NE",
            (false, true, false, true) => "SW",
            (false, true, true, false) => "SE",
            _ => null,
        };
    }

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

    /// <summary>Opposite cardinal direction. Corner (NW/NE/SE/SW) and unknown values pass through unchanged.</summary>
    private static string Opposite(string orient) => orient switch
    {
        "N" => "S",
        "S" => "N",
        "E" => "W",
        "W" => "E",
        _   => orient,
    };

    /// <summary>
    /// A tile's Orientation/AllowedOrients translated into this tool's internal (facing-direction)
    /// convention, regardless of which convention they were actually authored in. Everything
    /// downstream of tile selection (FrontCells, anchor rotation, head/foot offsets, etc.) works
    /// exclusively with this canonical value — only the small set of tile-selection/matching call
    /// sites need to be aware of TileDefinition.UseFacingOrientation at all.
    /// </summary>
    private static string CanonicalOrient(TileDefinition t) =>
        t.UseFacingOrientation ? t.Orientation : Opposite(t.Orientation);

    private static bool OrientMatches(TileDefinition t, string canonicalDesired) =>
        CanonicalOrient(t).Equals(canonicalDesired, StringComparison.OrdinalIgnoreCase);

    private static bool AllowedOrientsMatch(TileDefinition t, string canonicalDesired) => t.UseFacingOrientation
        ? t.AllowedOrients.Any(o => o.Equals(canonicalDesired, StringComparison.OrdinalIgnoreCase))
        : t.AllowedOrients.Any(o => Opposite(o).Equals(canonicalDesired, StringComparison.OrdinalIgnoreCase));

    /// <summary>Wall at the back of a tile, honoring its UseFacingOrientation convention.</summary>
    private static Direction? BackWallOf(TileDefinition t) => t.UseFacingOrientation
        ? BackWall(t.Orientation)
        : (Enum.TryParse<Direction>(t.Orientation, true, out var d) ? d : null);

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
    private static string? ResolveFacingAnchorOrient(string position, int aw, int ah, string anchorOrient)
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
            "frontOfAnchor" => anchorOrient switch { "N" => "S", "S" => "N", "E" => "W", "W" => "E", _ => null },
            "behindAnchor"  => anchorOrient switch { "N" => "N", "S" => "S", "E" => "E", "W" => "W", _ => null },
            "leftOfAnchor"  => anchorOrient switch { "N" => "E", "S" => "W", "E" => "S", "W" => "N", _ => null },
            "rightOfAnchor" => anchorOrient switch { "N" => "W", "S" => "E", "E" => "N", "W" => "S", _ => null },
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
            // Orientierung-relative Positionen
            "frontOfAnchor" => anchorOrient switch
            {
                "N" => ((int, int)?)(ac + (aw - depW) / 2, ar - depH),
                "S" => ((int, int)?)(ac + (aw - depW) / 2, ar + ah),
                "E" => ((int, int)?)(ac + aw, ar + (ah - depH) / 2),
                "W" => ((int, int)?)(ac - depW, ar + (ah - depH) / 2),
                _   => null,
            },
            "behindAnchor" => anchorOrient switch
            {
                "N" => ((int, int)?)(ac + (aw - depW) / 2, ar + ah),
                "S" => ((int, int)?)(ac + (aw - depW) / 2, ar - depH),
                "E" => ((int, int)?)(ac - depW, ar + (ah - depH) / 2),
                "W" => ((int, int)?)(ac + aw, ar + (ah - depH) / 2),
                _   => null,
            },
            // Corner cases (CCW: the tile continues whichever of its two walls lies counter-
            // clockwise). Case keys previously swapped diagonally (SE/NW, SW/NE) versus what
            // their own comments described — verified against the comments and fixed here.
            "leftOfAnchor" => anchorOrient switch
            {
                "N"  => ((int, int)?)(ac - depW, ar + (ah - depH) / 2),          // WEST
                "S"  => ((int, int)?)(ac + aw, ar + (ah - depH) / 2),            // EAST
                "E"  => ((int, int)?)(ac + (aw - depW) / 2, ar - depH),          // NORTH
                "W"  => ((int, int)?)(ac + (aw - depW) / 2, ar + ah),            // SOUTH
                "NW" => ((int, int)?)(ac + (aw - depW) / 2, ar + ah),            // SOUTH (NW corner → arm south along W wall)
                "NE" => ((int, int)?)(ac - depW, ar + (ah - depH) / 2),          // WEST  (NE corner → arm west along N wall)
                "SE" => ((int, int)?)(ac + (aw - depW) / 2, ar - depH),          // NORTH (SE corner → arm north along E wall)
                "SW" => ((int, int)?)(ac + aw, ar + (ah - depH) / 2),            // EAST  (SW corner → arm east along S wall)
                _    => null,
            },
            // Corner cases (CW: the OTHER wall from leftOfAnchor's — e.g. used to anchor a
            // straight counter run continuing away from the corner in the opposite direction).
            "rightOfAnchor" => anchorOrient switch
            {
                "N"  => ((int, int)?)(ac + aw, ar + (ah - depH) / 2),
                "S"  => ((int, int)?)(ac - depW, ar + (ah - depH) / 2),
                "E"  => ((int, int)?)(ac + (aw - depW) / 2, ar + ah),
                "W"  => ((int, int)?)(ac + (aw - depW) / 2, ar - depH),
                "NW" => ((int, int)?)(ac + aw, ar + (ah - depH) / 2),            // EAST  (continues N wall)
                "NE" => ((int, int)?)(ac + (aw - depW) / 2, ar + ah),            // SOUTH (continues E wall)
                "SE" => ((int, int)?)(ac - depW, ar + (ah - depH) / 2),          // WEST  (continues S wall)
                "SW" => ((int, int)?)(ac + (aw - depW) / 2, ar - depH),          // NORTH (continues W wall)
                _    => null,
            },
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
    /// Findet Kandidaten an der gegenueberliegenden Wand in Blickrichtung des Ankers.
    /// Kandidaten werden center-out ueber die Frontkante des Ankers geprueft.
    /// Inner walls act as boundaries — the walk stops at an inner wall edge.
    /// </summary>
    private static IEnumerable<(int col, int row)> ComputeOppositeWallCandidates(
        int ac, int ar, int aw, int ah,
        string anchorOrient,
        int depW, int depH,
        int minDist, int maxDist,
        HashSet<(int col, int row)> roomCells,
        HashSet<string>? innerWallKeys = null)
    {
        Direction? facingDir = anchorOrient switch
        {
            "N" => Direction.N,
            "S" => Direction.S,
            "E" => Direction.E,
            "W" => Direction.W,
            _   => null,
        };
        if (!facingDir.HasValue) yield break;

        var seen = new HashSet<(int, int)>();
        foreach (var lane in EnumerateOppositeWallLanes(ac, ar, aw, ah, facingDir.Value))
        {
            int c = lane.startCol;
            int r = lane.startRow;
            int dist = 1;

            while (roomCells.Contains((c, r)))
            {
                var next = facingDir.Value switch
                {
                    Direction.N => (c, r - 1),
                    Direction.S => (c, r + 1),
                    Direction.E => (c + 1, r),
                    Direction.W => (c - 1, r),
                    _           => (c, r),
                };

                // Treat inner walls the same as room boundaries — stop the walk
                string? innerEdgeKey = innerWallKeys is null ? null : facingDir.Value switch
                {
                    Direction.N => $"H:{c},{r}",
                    Direction.S => $"H:{c},{r + 1}",
                    Direction.E => $"V:{c + 1},{r}",
                    Direction.W => $"V:{c},{r}",
                    _           => null,
                };
                bool hitInnerWall = innerEdgeKey != null && innerWallKeys!.Contains(innerEdgeKey);

                if (!roomCells.Contains(next) || hitInnerWall)
                {
                    if (dist >= minDist && dist <= maxDist)
                    {
                        var anchor = ComputeWallAnchor((c, r), facingDir.Value, depW, depH);
                        if (seen.Add(anchor))
                            yield return anchor;
                    }
                    break;
                }

                c = next.Item1;
                r = next.Item2;
                dist++;
                if (dist > maxDist) break;
            }
        }
    }

    private static IEnumerable<(int startCol, int startRow)> EnumerateOppositeWallLanes(
        int ac, int ar, int aw, int ah, Direction facingDir)
    {
        if (facingDir is Direction.N or Direction.S)
        {
            int centerCol = ac + (aw - 1) / 2;
            foreach (var col in CenterOutRange(ac, aw, centerCol))
            {
                int startRow = facingDir == Direction.N ? ar - 1 : ar + ah;
                yield return (col, startRow);
            }
            yield break;
        }

        int centerRow = ar + (ah - 1) / 2;
        foreach (var row in CenterOutRange(ar, ah, centerRow))
        {
            int startCol = facingDir == Direction.W ? ac - 1 : ac + aw;
            yield return (startCol, row);
        }
    }

    private static IEnumerable<int> CenterOutRange(int start, int length, int center)
    {
        if (length <= 0) yield break;
        yield return center;
        for (int delta = 1; delta < length; delta++)
        {
            int left = center - delta;
            int right = center + delta;
            if (left >= start) yield return left;
            if (right < start + length) yield return right;
        }
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

    private static List<HashSet<(int col, int row)>> SplitIntoComponents(HashSet<(int col, int row)> cells)
    {
        var remaining  = new HashSet<(int, int)>(cells);
        var components = new List<HashSet<(int, int)>>();
        while (remaining.Count > 0)
        {
            var seed      = remaining.First();
            var component = new HashSet<(int, int)> { seed };
            var queue     = new Queue<(int, int)>();
            queue.Enqueue(seed);
            while (queue.Count > 0)
            {
                var (cc, cr) = queue.Dequeue();
                foreach (var next in new[] { (cc, cr - 1), (cc, cr + 1), (cc - 1, cr), (cc + 1, cr) })
                {
                    if (remaining.Contains(next) && component.Add(next))
                        queue.Enqueue(next);
                }
            }
            foreach (var c in component) remaining.Remove(c);
            components.Add(component);
        }
        return components;
    }

    private static HashSet<(int col, int row)> GetRoomCells(Floor floor, int roomIndex1Based, int? anchorCol = null, int? anchorRow = null)
    {
        var cells = new HashSet<(int, int)>();
        for (int r = 0; r < floor.RoomGrid.Length; r++)
            for (int c = 0; c < floor.RoomGrid[r].Length; c++)
                if (floor.RoomGrid[r][c] == roomIndex1Based) cells.Add((c, r));

        if (!anchorCol.HasValue || !anchorRow.HasValue)
            return cells;

        var anchor = (anchorCol.Value, anchorRow.Value);
        if (!cells.Contains(anchor))
            return [];

        // Return only the connected component containing the selected anchor cell.
        var component = new HashSet<(int, int)> { anchor };
        var queue = new Queue<(int col, int row)>();
        queue.Enqueue(anchor);

        while (queue.Count > 0)
        {
            var (cc, cr) = queue.Dequeue();
            foreach (var next in new[] { (cc, cr - 1), (cc, cr + 1), (cc - 1, cr), (cc + 1, cr) })
            {
                if (!cells.Contains(next) || !component.Add(next))
                    continue;
                queue.Enqueue(next);
            }
        }

        return component;
    }

    private const int StairSpan = 5;

    /// <summary>
    /// Splits a floor's stair footprints into the 3 middle cells (structural stair treads —
    /// blocked for ANY furniture, any layer) and the 2 end cells (the landings — walkable
    /// floor, so only non-floor-layer furniture is blocked there; a rug/floor overlay may
    /// still sit on a landing). Mirrors PathfinderService.BuildStairBlockedCells's span
    /// computation (own floor's stairs + the floor below's, whose stairwell opening pokes
    /// through onto this floor) and StairSpan/dir convention, but split by role instead of
    /// treating the whole span as one uniform block.
    /// </summary>
    private static (HashSet<(int, int)> mid, HashSet<(int, int)> ends) ComputeStairCells(
        Floor floor, Building building, int floorIndex)
    {
        var mid  = new HashSet<(int, int)>();
        var ends = new HashSet<(int, int)>();

        void AddSpan(FloorObject obj)
        {
            for (int i = 0; i < StairSpan; i++)
            {
                int cx = obj.Dir == Direction.W ? obj.X + i : obj.X;
                int cy = obj.Dir == Direction.N ? obj.Y + i : obj.Y;
                (i == 0 || i == StairSpan - 1 ? ends : mid).Add((cx, cy));
            }
        }

        foreach (var obj in floor.Objects)
            if (obj.Type == FloorObjectType.Stairs) AddSpan(obj);

        if (floorIndex > 0)
            foreach (var obj in building.Floors[floorIndex - 1].Objects)
                if (obj.Type == FloorObjectType.Stairs) AddSpan(obj);

        return (mid, ends);
    }

    private static Dictionary<(int, int), HashSet<Direction>> ComputeWallDirections(
        HashSet<(int, int)> roomCells, Floor floor, HashSet<(int, int)>? voidCells = null)
    {
        // A cell bordering roomCells with nothing beyond it is normally a real wall — except
        // when that "nothing" is actually a stair-tread notch carved out of roomCells (see
        // ComputeStairCells), which is open stairwell space, not a wall face. Without this
        // exemption, wall-mounted furniture (pictures, lamps, ...) would treat the edge of the
        // stairwell as a legitimate wall to hang on.
        bool IsWallBoundary((int, int) neighbor) =>
            !roomCells.Contains(neighbor) && (voidCells is null || !voidCells.Contains(neighbor));

        var result = new Dictionary<(int, int), HashSet<Direction>>();
        foreach (var (col, row) in roomCells)
        {
            var dirs = new HashSet<Direction>();
            if (IsWallBoundary((col,     row - 1))) dirs.Add(Direction.N);
            if (IsWallBoundary((col,     row + 1))) dirs.Add(Direction.S);
            if (IsWallBoundary((col - 1, row    ))) dirs.Add(Direction.W);
            if (IsWallBoundary((col + 1, row    ))) dirs.Add(Direction.E);
            if (dirs.Count > 0) result[(col, row)] = dirs;
        }

        // Inner walls add wall faces inside the room (create corners for CornerOnly placement rules).
        // Cell1 = north/west neighbour → sees wall to its south (H) or east (V).
        // Cell2 = south/east neighbour → sees wall to its north (H) or west (V).
        foreach (var edge in floor.Edges.Where(e => e.Type == FloorObjectType.InnerWall))
        {
            var c1 = (edge.Cell1Col, edge.Cell1Row);
            var c2 = (edge.Cell2Col, edge.Cell2Row);
            if (roomCells.Contains(c1))
            {
                if (!result.TryGetValue(c1, out var d1)) { d1 = []; result[c1] = d1; }
                d1.Add(edge.IsHorizontal ? Direction.S : Direction.E);
            }
            if (roomCells.Contains(c2))
            {
                if (!result.TryGetValue(c2, out var d2)) { d2 = []; result[c2] = d2; }
                d2.Add(edge.IsHorizontal ? Direction.N : Direction.W);
            }
        }

        // Opening edges (archways) are NOT backed by a real wall segment — unlike Door, which
        // still implies a wall (with a door-shaped gap) behind it. Retract any direction added
        // above purely from roomCells adjacency if that boundary is actually an Opening,
        // otherwise wall-anchored placement logic treats an archway-adjacent cell as if it had
        // a solid wall at its back (breaks orientation for wall-hugging furniture chains, e.g.
        // an L-shape kitchen counter run touching an archway).
        foreach (var edge in floor.Edges.Where(e => e.Type == FloorObjectType.Opening))
        {
            var c1 = (edge.Cell1Col, edge.Cell1Row);
            var c2 = (edge.Cell2Col, edge.Cell2Row);
            if (roomCells.Contains(c1) && result.TryGetValue(c1, out var d1))
                d1.Remove(edge.IsHorizontal ? Direction.S : Direction.E);
            if (roomCells.Contains(c2) && result.TryGetValue(c2, out var d2))
                d2.Remove(edge.IsHorizontal ? Direction.N : Direction.W);
        }

        // Several callers key off cellWalls.ContainsKey(cell) alone (NearWall pool filters,
        // FootprintTouchesWall) rather than checking the HashSet's Count — an empty-but-present
        // entry would still read as "this cell has a wall" to them. Drop now-empty entries left
        // behind by the Opening retraction above so a cell whose only boundary was an archway is
        // indistinguishable from an interior cell to every consumer, not just the ones that
        // already defensively check Count == 0.
        foreach (var cell in result.Where(kv => kv.Value.Count == 0).Select(kv => kv.Key).ToList())
            result.Remove(cell);

        return result;
    }

    private static HashSet<(int, int)> GetEdgeCells(
        Floor floor, HashSet<(int, int)> roomCells, params FloorObjectType[] types)
    {
        var result = new HashSet<(int, int)>();
        foreach (var edge in floor.Edges.Where(e => types.Contains(e.Type)))
        {
            if (roomCells.Contains((edge.Cell1Col, edge.Cell1Row))) result.Add((edge.Cell1Col, edge.Cell1Row));
            if (roomCells.Contains((edge.Cell2Col, edge.Cell2Row))) result.Add((edge.Cell2Col, edge.Cell2Row));
        }
        return result;
    }

    /// <summary>
    /// Returns cells that form the only passages through inner walls (gap cells).
    /// A gap cell sits on an edge that is NOT an inner wall but is adjacent (same orientation,
    /// neighbouring position) to one that IS. Both cells on either side of that gap edge
    /// are returned so furniture cannot seal the passage from either direction.
    /// </summary>
    private static HashSet<(int, int)> ComputeInnerWallGapCells(
        HashSet<(int, int)> roomCells,
        HashSet<string> innerWallKeys)
    {
        var gapCells = new HashSet<(int, int)>();

        foreach (var (col, row) in roomCells)
        {
            // Horizontal edge H:col,row (north face of (col,row), south face of (col,row-1))
            if (!innerWallKeys.Contains($"H:{col},{row}"))
            {
                if (innerWallKeys.Contains($"H:{col - 1},{row}") ||
                    innerWallKeys.Contains($"H:{col + 1},{row}"))
                {
                    gapCells.Add((col, row));
                    if (roomCells.Contains((col, row - 1))) gapCells.Add((col, row - 1));
                }
            }

            // Vertical edge V:col,row (west face of (col,row), east face of (col-1,row))
            if (!innerWallKeys.Contains($"V:{col},{row}"))
            {
                if (innerWallKeys.Contains($"V:{col},{row - 1}") ||
                    innerWallKeys.Contains($"V:{col},{row + 1}"))
                {
                    gapCells.Add((col, row));
                    if (roomCells.Contains((col - 1, row))) gapCells.Add((col - 1, row));
                }
            }
        }

        return gapCells;
    }

    /// <summary>
    /// Returns the edge keys of gap edges themselves (the one open edge in an otherwise-walled
    /// run — same pinch-point detection as ComputeInnerWallGapCells, but returning the edge
    /// key rather than the adjacent cells). Used by ComputeMainSubRoom to treat a narrow
    /// single-cell opening as still splitting the room into separate sub-rooms for main-
    /// furniture placement preference, even though the opening keeps the room walkable.
    /// </summary>
    private static HashSet<string> ComputeGapEdgeKeys(
        HashSet<(int, int)> roomCells,
        HashSet<string> innerWallKeys)
    {
        var gapEdgeKeys = new HashSet<string>();

        foreach (var (col, row) in roomCells)
        {
            if (!innerWallKeys.Contains($"H:{col},{row}")
                && (innerWallKeys.Contains($"H:{col - 1},{row}") || innerWallKeys.Contains($"H:{col + 1},{row}")))
                gapEdgeKeys.Add($"H:{col},{row}");

            if (!innerWallKeys.Contains($"V:{col},{row}")
                && (innerWallKeys.Contains($"V:{col},{row - 1}") || innerWallKeys.Contains($"V:{col},{row + 1}")))
                gapEdgeKeys.Add($"V:{col},{row}");
        }

        return gapEdgeKeys;
    }

    /// <summary>
    /// Gruppiert Öffnungskanten (Opening) nach dem externen Raum, zu dem sie führen.
    /// Jede Gruppe entspricht einem anderen Zielraum → jede Gruppe benötigt ≥1 freie Raumzelle.
    /// Eine L-förmige Öffnung zu zwei verschiedenen Räumen erzeugt zwei unabhängige Gruppen.
    /// </summary>
    private static List<HashSet<(int, int)>> ComputeOpeningGroups(
        Floor floor,
        HashSet<(int, int)> roomCells)
    {
        var byExternalRoom = new Dictionary<int, HashSet<(int, int)>>();

        // Door objects (e.g. a wide garage door) act as openings too, not just
        // unmodeled gaps in the auto-generated boundary wall.
        foreach (var edge in floor.Edges.Where(e => e.Type == FloorObjectType.Opening || e.Type == FloorObjectType.Door))
        {
            var c1 = (edge.Cell1Col, edge.Cell1Row);
            var c2 = (edge.Cell2Col, edge.Cell2Row);
            bool c1In = roomCells.Contains(c1);
            bool c2In = roomCells.Contains(c2);

            // Edge doesn't touch this room — skip to avoid creating empty groups
            if (!c1In && !c2In) continue;

            // Determine the group key from whichever cell is OUTSIDE this room
            int extKey;
            if (!c1In)
            {
                var (oc, or) = c1;
                extKey = (or >= 0 && or < floor.RoomGrid.Length &&
                          oc >= 0 && oc < floor.RoomGrid[or].Length)
                    ? floor.RoomGrid[or][oc] : -1;
            }
            else if (!c2In)
            {
                var (oc, or) = c2;
                extKey = (or >= 0 && or < floor.RoomGrid.Length &&
                          oc >= 0 && oc < floor.RoomGrid[or].Length)
                    ? floor.RoomGrid[or][oc] : -1;
            }
            else continue; // both cells inside the room — not a boundary opening, skip

            if (!byExternalRoom.TryGetValue(extKey, out var group))
            {
                group = new HashSet<(int, int)>();
                byExternalRoom[extKey] = group;
            }
            if (c1In) group.Add(c1);
            if (c2In) group.Add(c2);
        }

        return byExternalRoom.Values.ToList();
    }

    /// <summary>
    /// Ermittelt die dominante "nach draußen"-Richtung einer Opening-Gruppe: für jede Zelle
    /// der Gruppe wird geprüft, welche der 4 Nachbarn NICHT zu roomCells gehört; die häufigste
    /// solche Richtung gewinnt. Gibt (0,0) zurück wenn keine Zelle einen Außennachbarn hat.
    /// </summary>
    private static (int dc, int dr) DetermineOutwardDir(HashSet<(int, int)> group, HashSet<(int, int)> roomCells)
    {
        (int dc, int dr)[] dirs = [(-1, 0), (1, 0), (0, -1), (0, 1)];
        var counts = new Dictionary<(int, int), int>();
        foreach (var (c, r) in group)
            foreach (var (dc, dr) in dirs)
                if (!roomCells.Contains((c + dc, r + dr)))
                    counts[(dc, dr)] = counts.GetValueOrDefault((dc, dr)) + 1;

        if (counts.Count == 0) return (0, 0);
        return counts.OrderByDescending(kv => kv.Value).First().Key;
    }

    /// <summary>
    /// Berechnet automatisch erkannte Sperrzonen (z.B. "Car"-Stellplatz vor einem breiten
    /// Garagentor) aus den Regeln des Raumtyps und den bereits berechneten Opening-Groups.
    /// Breite der Zone ergibt sich aus der Breite der auslösenden Öffnung (optional gekappt
    /// via MaxWidth); Tiefe ist die konfigurierte Regel-Tiefe, ggf. bis zum Raumrand gekappt.
    /// </summary>
    private static (HashSet<(int, int)> cells, List<ReservedZonePlacement> placements) ComputeReservedZones(
        List<ReservedZoneRule> rules,
        int floorIndex,
        int roomIndex1Based,
        HashSet<(int, int)> roomCells,
        List<HashSet<(int, int)>> openingGroups,
        List<string> log)
    {
        var allCells   = new HashSet<(int, int)>();
        var placements = new List<ReservedZonePlacement>();

        foreach (var rule in rules)
        {
            if (rule.Depth <= 0) continue;

            foreach (var group in openingGroups)
            {
                if (group.Count < rule.MinOpeningWidth) continue;

                var (outDc, outDr) = DetermineOutwardDir(group, roomCells);
                if (outDc == 0 && outDr == 0)
                {
                    log.Add($"  [SKIP reserved zone] '{rule.Label}': opening group has no outward-facing cell.");
                    continue;
                }
                var (inDc, inDr) = (-outDc, -outDr);

                // outDr != 0 (Öffnung liegt an einer Nord/Süd-Wand) → Öffnung erstreckt sich
                // horizontal (Spalten variieren); outDc != 0 → Öffnung erstreckt sich vertikal
                // (Zeilen variieren).
                bool spanIsCol = outDr != 0;

                var spanToCross = new Dictionary<int, int>();
                foreach (var (c, r) in group)
                {
                    int span  = spanIsCol ? c : r;
                    int cross = spanIsCol ? r : c;
                    spanToCross[span] = cross; // consistent wall line expected; last write wins
                }

                int spanMin = spanToCross.Keys.Min();
                int spanMax = spanToCross.Keys.Max();

                if (rule.MaxWidth is { } maxW && spanMax - spanMin + 1 > maxW)
                {
                    int trim = (spanMax - spanMin + 1) - maxW;
                    spanMin += trim / 2;
                    spanMax  = spanMin + maxW - 1;
                }

                var spanValues = spanToCross.Keys.Where(s => s >= spanMin && s <= spanMax).ToList();
                if (spanValues.Count == 0)
                {
                    log.Add($"  [SKIP reserved zone] '{rule.Label}': no span cells left after MaxWidth clipping.");
                    continue;
                }

                var zoneCells = new HashSet<(int, int)>();
                int achievedDepth = 0;
                for (int depth = 1; depth <= rule.Depth; depth++)
                {
                    var layer = new List<(int, int)>();
                    bool layerValid = true;
                    foreach (var span in spanValues)
                    {
                        int cross = spanToCross[span];
                        // depth=1 is the room cell adjacent to the opening itself (offset 0),
                        // not one step further in — off-by-one shifted the whole zone inward.
                        var cell = spanIsCol
                            ? (span, cross + inDr * (depth - 1))
                            : (cross + inDc * (depth - 1), span);
                        if (!roomCells.Contains(cell)) { layerValid = false; break; }
                        layer.Add(cell);
                    }
                    if (!layerValid) break;
                    zoneCells.UnionWith(layer);
                    achievedDepth = depth;
                }

                if (achievedDepth == 0)
                {
                    log.Add($"  [SKIP reserved zone] '{rule.Label}': room too shallow for depth {rule.Depth}.");
                    continue;
                }
                if (achievedDepth < rule.Depth)
                    log.Add($"  [CLIP reserved zone] '{rule.Label}': depth clipped from {rule.Depth} to {achievedDepth} (room boundary).");

                int colMin = zoneCells.Min(c => c.Item1), colMax = zoneCells.Max(c => c.Item1);
                int rowMin = zoneCells.Min(c => c.Item2), rowMax = zoneCells.Max(c => c.Item2);
                placements.Add(new ReservedZonePlacement(
                    floorIndex, roomIndex1Based, colMin, rowMin,
                    colMax - colMin + 1, rowMax - rowMin + 1, rule.Label));
                allCells.UnionWith(zoneCells);
                log.Add($"  [RESERVED ZONE] '{rule.Label}': {zoneCells.Count} cells at ({colMin},{rowMin}) {colMax - colMin + 1}x{rowMax - rowMin + 1}");
            }
        }

        return (allCells, placements);
    }

    /// <summary>
    /// Prüft ob nach einer simulierten Platzierung in jeder Opening-Gruppe noch mindestens
    /// eine Zelle frei (begehbar) bleibt. Gibt false zurück wenn irgendeine Gruppe vollständig
    /// blockiert wäre. Prüft physicalOccupied (tatsächliche Kollision/Begehbarkeit), nicht
    /// occupied (Footprint-Stacking-Regeln) — ein Slot mit BlocksPlacement=false/SoftBlocks=true
    /// (z.B. eine Theke, auf der ein Waschbecken sitzen darf) landet nie in occupied, blockiert
    /// aber trotzdem physisch den Durchgang, wenn sein Tile HasCollision=true ist.
    /// </summary>
    private static bool OpeningGroupsAllowPlacement(
        int anchorCol, int anchorRow, int fpW, int fpH,
        bool candidateHasCollision,
        HashSet<(int, int)> physicalOccupied,
        List<HashSet<(int, int)>> openingGroups)
    {
        foreach (var group in openingGroups)
        {
            bool anyFree = false;
            foreach (var (c, r) in group)
            {
                if (physicalOccupied.Contains((c, r))) continue;
                // Covered by the candidate footprint? Only counts against the group's "stay
                // walkable" budget if this candidate actually has collision — a non-colliding
                // item (e.g. a rug) landing here doesn't block anyone from walking through.
                if (candidateHasCollision && c >= anchorCol && c < anchorCol + fpW &&
                    r >= anchorRow && r < anchorRow + fpH) continue;
                anyFree = true;
                break;
            }
            if (!anyFree) return false;
        }
        return true;
    }

    /// <summary>
    /// Berechnet den Hauptbereich (main sub-room) eines Raums, wenn Innenwände ihn unterteilen.
    /// Gibt null zurück wenn keine Innenwände vorhanden (ganzer Raum = Hauptbereich).
    /// Priorisierung: meiste Türzellen DESC, dann meiste Raumzellen DESC.
    /// </summary>
    private static HashSet<(int, int)>? ComputeMainSubRoom(
        HashSet<(int, int)> roomCells,
        HashSet<string> innerWallKeys,
        HashSet<(int, int)> doorCells)
    {
        if (innerWallKeys.Count == 0) return null;

        // A wall run with only a narrow (single-cell) pinch-point opening still keeps the room
        // walkable (see ComputeInnerWallGapCells/RoomRemainsConnected, which correctly treat it
        // as passable), but for "which area is the primary/main sub-room" purposes it should
        // still count as a split — a nook connected to the rest of the room by one narrow
        // opening reads as its own distinct area, not part of the main room.
        var gapEdgeKeys = ComputeGapEdgeKeys(roomCells, innerWallKeys);

        var remaining  = new HashSet<(int, int)>(roomCells);
        var components = new List<HashSet<(int, int)>>();

        while (remaining.Count > 0)
        {
            var seed      = remaining.First();
            var component = new HashSet<(int, int)> { seed };
            var queue     = new Queue<(int, int)>();
            queue.Enqueue(seed);

            while (queue.Count > 0)
            {
                var (cc, cr) = queue.Dequeue();
                foreach (var (nc, nr) in new[] { (cc, cr - 1), (cc, cr + 1), (cc - 1, cr), (cc + 1, cr) })
                {
                    if (!remaining.Contains((nc, nr)) || component.Contains((nc, nr))) continue;
                    string edgeKey = nc == cc
                        ? $"H:{cc},{Math.Max(cr, nr)}"
                        : $"V:{Math.Max(cc, nc)},{cr}";
                    if (innerWallKeys.Contains(edgeKey) || gapEdgeKeys.Contains(edgeKey)) continue;
                    component.Add((nc, nr));
                    queue.Enqueue((nc, nr));
                }
            }

            foreach (var c in component) remaining.Remove(c);
            components.Add(component);
        }

        return components
            .OrderByDescending(c => c.Count)
            .ThenByDescending(c => c.Count(cell => doorCells.Contains(cell)))
            .First();
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
    /// BFS über alle roomCells, die nicht in occupiedCells liegen (walkable), ausgehend von
    /// einer Türzelle (garantiert erreichbar vom Eingang) falls vorhanden, sonst der ersten
    /// walkable Zelle. Inner walls blockieren die Traversierung über ihre Kante.
    /// Rückgabe: die erreichten Zellen (Teilmenge von walkable); walkable selbst wird per
    /// out-Parameter zurückgegeben, da Aufrufer meist beides brauchen
    /// (z.B. visited.Count == walkable.Count für den reinen Connectivity-Check).
    /// </summary>
    private static HashSet<(int, int)> ComputeReachableCells(
        HashSet<(int, int)> roomCells,
        HashSet<(int, int)> occupiedCells,
        HashSet<(int, int)> doorCells,
        HashSet<string>? innerWallKeys,
        out HashSet<(int, int)> walkable)
    {
        walkable = new HashSet<(int, int)>(roomCells.Count);
        foreach (var cell in roomCells)
            if (!occupiedCells.Contains(cell))
                walkable.Add(cell);

        var visited = new HashSet<(int, int)>(walkable.Count);
        if (walkable.Count == 0) return visited;

        var start = default((int, int));
        bool found = false;
        foreach (var d in doorCells)
        {
            if (walkable.Contains(d)) { start = d; found = true; break; }
        }
        if (!found) start = walkable.First();

        // BFS über 4-Nachbarschaft (N/S/E/W) – Bewegung in PZ ist rein orthogonal.
        var queue = new Queue<(int, int)>();
        queue.Enqueue(start);
        visited.Add(start);

        while (queue.Count > 0)
        {
            var (cc, cr) = queue.Dequeue();
            foreach (var (nc, nr) in new (int, int)[]
                { (cc, cr - 1), (cc, cr + 1), (cc - 1, cr), (cc + 1, cr) })
            {
                // NOTE: must only touch `visited` AFTER the wall check below passes. Marking a
                // cell visited here (even via a side-effecting Add) before checking the wall
                // would falsely count a wall-blocked neighbor as reached the first time it's
                // discovered, before any real path gets a chance to reach it legitimately.
                if (!walkable.Contains((nc, nr)) || visited.Contains((nc, nr))) continue;

                // Skip step if an inner wall seals the shared edge between (cc,cr) and (nc,nr)
                if (innerWallKeys != null)
                {
                    string edgeKey;
                    if (nc == cc)      // moving north/south — horizontal edge
                        edgeKey = $"H:{cc},{Math.Max(cr, nr)}";
                    else               // moving east/west — vertical edge
                        edgeKey = $"V:{Math.Max(cc, nc)},{cr}";
                    if (innerWallKeys.Contains(edgeKey)) continue;
                }

                visited.Add((nc, nr));
                queue.Enqueue((nc, nr));
            }
        }

        return visited;
    }

    /// <summary>True if any orthogonal (N/S/E/W) neighbor of cell is in set.</summary>
    private static bool HasOrthogonalNeighborIn((int, int) cell, HashSet<(int, int)> set)
    {
        var (c, r) = cell;
        return set.Contains((c, r - 1)) || set.Contains((c, r + 1))
            || set.Contains((c - 1, r)) || set.Contains((c + 1, r));
    }

    /// <summary>
    /// Bestimmt, welche bereits belegten (physicalOccupied) Zellen VOR einer Kandidaten-
    /// Platzierung mindestens eine begehbar-erreichbare Nachbarzelle hatten ("geschützt").
    /// Wird von RoomRemainsConnected genutzt, um zu verhindern, dass eine neue Platzierung
    /// den letzten begehbaren Zugang zu einem bereits platzierten Möbelstück verschließt –
    /// nur bereits geschützte Zellen werden geprüft, damit ein Möbelstück, das schon vorher
    /// (z.B. durch sein eigenes Footprint) keinen freien Nachbarn hatte, nicht fälschlich
    /// einer späteren, unbeteiligten Platzierung angelastet wird.
    /// Wird einmal pro FindFreeCell/EnumerateFreePlacementCandidates-Aufruf berechnet (nicht
    /// pro Kandidat), da occupiedCells sich erst zwischen PlaceSlot-Aufrufen ändert.
    /// </summary>
    private static HashSet<(int, int)> ComputeProtectedCells(
        HashSet<(int, int)> roomCells,
        HashSet<(int, int)> occupiedCells,
        HashSet<(int, int)> doorCells,
        HashSet<string>? innerWallKeys)
    {
        var baselineVisited = ComputeReachableCells(roomCells, occupiedCells, doorCells, innerWallKeys, out _);
        var protectedCells = new HashSet<(int, int)>();
        foreach (var oc in occupiedCells)
            if (HasOrthogonalNeighborIn(oc, baselineVisited))
                protectedCells.Add(oc);
        return protectedCells;
    }

    /// <summary>
    /// Prüft ob nach simulierter Platzierung des Footprints alle begehbaren Raumzellen
    /// noch zusammenhängend erreichbar sind, UND ob jede zuvor geschützte (bereits belegte)
    /// Zelle aus protectedCells weiterhin mindestens eine begehbar-erreichbare Nachbarzelle hat.
    /// Verhindert sowohl dass Möbel mit Kollision Raumbereiche abschneiden (z.B. ein Bett das
    /// in einem nicht-rechteckigen Raum eine Ecke isoliert), als auch dass eine neue Platzierung
    /// den letzten Zugang zu einem bereits platzierten Möbelstück versperrt (z.B. eine Badewanne,
    /// die durch eine später platzierte Kommode unerreichbar wird).
    /// </summary>
    private static bool RoomRemainsConnected(
        int col, int row, int fpW, int fpH,
        HashSet<(int, int)> roomCells,
        HashSet<(int, int)> occupied,
        HashSet<(int, int)> doorCells,
        HashSet<string>? innerWallKeys = null,
        HashSet<(int, int)>? protectedCells = null)
    {
        // Simuliere: occupied nach Platzierung dieses Footprints
        var tempOccupied = new HashSet<(int, int)>(occupied);
        for (int r = 0; r < fpH; r++)
            for (int c = 0; c < fpW; c++)
                tempOccupied.Add((col + c, row + r));

        var visited = ComputeReachableCells(roomCells, tempOccupied, doorCells, innerWallKeys, out var walkable);
        if (walkable.Count == 0) return true; // Raum komplett voll – kein Connectivity-Check nötig

        // Alle Tür-/Opening-Zellen müssen weiterhin gegenseitig erreichbar bleiben – verhindert,
        // dass eine Platzierung den Raum in zwei durch unterschiedliche Türen erschlossene
        // Bereiche zerschneidet.
        foreach (var d in doorCells)
            if (walkable.Contains(d) && !visited.Contains(d))
                return false;

        // Jede sonstige neu abgeschnittene Zelle muss real begehbarer Bodenraum bleiben — nur
        // eine winzige türlose Nische (maximal MaxTolerableIsolatedCells Zellen, z.B. eine
        // einzelne Ecke hinter einem neu platzierten Schrank) wird toleriert. Eine größere
        // isolierte Fläche (mehrere Zellen) bleibt weiterhin verboten, auch ohne Tür/Möbel darin —
        // das war der eigentliche Bug: zu locker gefasst hätte jede leere Fläche ohne Tür oder
        // Möbel unbegrenzt abgeschnitten werden dürfen.
        const int MaxTolerableIsolatedCells = 1;
        int isolated = walkable.Count - visited.Count;
        if (isolated > MaxTolerableIsolatedCells) return false;

        // Zuvor geschützte, bereits belegte Zellen (z.B. eine platzierte Badewanne) müssen
        // weiterhin mindestens eine begehbar-erreichbare Nachbarzelle haben.
        if (protectedCells is { Count: > 0 })
            foreach (var pc in protectedCells)
                if (!HasOrthogonalNeighborIn(pc, visited))
                    return false;

        return true;
    }
}



