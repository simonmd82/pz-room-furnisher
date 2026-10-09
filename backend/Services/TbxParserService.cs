using System.Xml.Linq;
using backend.Models;

namespace backend.Services;

public interface ITbxParserService
{
    Building Parse(Stream stream);
}

public class TbxParserService : ITbxParserService
{
    private readonly IWallFurnitureClassificationService _wallFurnitureSvc;

    public TbxParserService(IWallFurnitureClassificationService wallFurnitureSvc)
    {
        _wallFurnitureSvc = wallFurnitureSvc;
    }

    public Building Parse(Stream stream)
    {
        var doc = XDocument.Load(stream);
        var root = doc.Root ?? throw new InvalidDataException("Invalid TBX file: no root element.");

        var building = new Building
        {
            Width  = int.Parse(root.Attribute("width")?.Value  ?? "0"),
            Height = int.Parse(root.Attribute("height")?.Value ?? "0"),
        };

        // ── TBX Roundtrip-Metadaten ───────────────────────────────────────────

        // Root-Attribute außer width/height in TbxMetadata übernehmen
        foreach (var attr in root.Attributes())
        {
            if (attr.Name.LocalName is "width" or "height") continue;
            building.Tbx.RootAttributes[attr.Name.LocalName] = attr.Value;
        }

        // tile_entry-Blöcke (Reihenfolge beibehalten – "floors" kommt mehrfach)
        foreach (var entryEl in root.Elements("tile_entry"))
        {
            var block = new TbxTileEntryBlock
            {
                Category = entryEl.Attribute("category")?.Value ?? string.Empty,
            };
            foreach (var tileEl in entryEl.Elements("tile"))
            {
                block.Tiles.Add(new TbxTileEntry
                {
                    Enum   = tileEl.Attribute("enum")?.Value   ?? string.Empty,
                    Tile   = tileEl.Attribute("tile")?.Value   ?? string.Empty,
                    Offset = tileEl.Attribute("offset")?.Value ?? string.Empty,
                });
            }
            building.Tbx.TileEntries.Add(block);
        }

        // Root-level furniture-Blöcke (z.B. layer="Walls") – wandmontierte Türen/
        // Fenster/Bögen, die als generische Möbel-Platzierung statt als normales
        // type="door"/"window"-Objekt kodiert sind. Reihenfolge beibehalten:
        // FurnitureTiles="N" (siehe unten) ist ein 0-basierter Index in diese Liste.
        foreach (var furnitureEl in root.Elements("furniture"))
        {
            var block = new TbxFurnitureBlock
            {
                Layer   = furnitureEl.Attribute("layer")?.Value ?? string.Empty,
                Corners = furnitureEl.Attribute("corners")?.Value == "true",
            };
            foreach (var entryEl in furnitureEl.Elements("entry"))
            {
                var entry = new TbxFurnitureEntry
                {
                    Orient = entryEl.Attribute("orient")?.Value ?? string.Empty,
                    Grime  = entryEl.Attribute("grime")?.Value == "true",
                };
                foreach (var tileEl in entryEl.Elements("tile"))
                {
                    entry.Tiles.Add(new TbxFurnitureTile
                    {
                        X    = ParseInt(tileEl.Attribute("x")?.Value),
                        Y    = ParseInt(tileEl.Attribute("y")?.Value),
                        Name = tileEl.Attribute("name")?.Value ?? string.Empty,
                    });
                }
                block.Entries.Add(entry);
            }
            building.Tbx.FurnitureBlocks.Add(block);
        }

        // user_tiles – geordnete Möbel-Tile-Liste (1-basierter Index durch Listenposition)
        var userTilesEl = root.Element("user_tiles");
        if (userTilesEl != null)
        {
            foreach (var tileEl in userTilesEl.Elements("tile"))
            {
                var tileName = tileEl.Attribute("tile")?.Value ?? string.Empty;
                if (!string.IsNullOrEmpty(tileName))
                    building.Tbx.UserTiles.Add(tileName);
            }
        }

        // used_tiles – Raum-/Basisstruktur-Indizes
        var usedTilesEl = root.Element("used_tiles");
        if (usedTilesEl != null)
        {
            building.Tbx.UsedTiles = (usedTilesEl.Value ?? string.Empty)
                .Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(v => int.TryParse(v, out var n) ? n : -1)
                .Where(n => n >= 0)
                .ToList();
        }

        // used_furniture – aktuell roh beibehalten
        var usedFurnitureEl = root.Element("used_furniture");
        if (usedFurnitureEl != null)
            building.Tbx.UsedFurnitureRaw = usedFurnitureEl.Value ?? string.Empty;

        // Parse rooms (order matters — index 1 = first room element)
        foreach (var roomEl in root.Elements("room"))
        {
            building.Rooms.Add(new Room
            {
                Name            = roomEl.Attribute("Name")?.Value            ?? string.Empty,
                InternalName    = roomEl.Attribute("InternalName")?.Value    ?? string.Empty,
                Color           = roomEl.Attribute("Color")?.Value           ?? "128 128 128",
                InteriorWall    = ParseInt(roomEl.Attribute("InteriorWall")?.Value),
                InteriorWallTrim= ParseInt(roomEl.Attribute("InteriorWallTrim")?.Value),
                FloorTile       = ParseInt(roomEl.Attribute("Floor")?.Value),
                GrimeFloor      = ParseInt(roomEl.Attribute("GrimeFloor")?.Value),
                GrimeWall       = ParseInt(roomEl.Attribute("GrimeWall")?.Value),
                Ceiling         = ParseInt(roomEl.Attribute("Ceiling")?.Value),
            });
        }

        // Wall-furniture classification store (fetched once, not per floor) + a
        // per-building accumulator for the distinct candidates found while parsing.
        var wallFurnitureClassifications = _wallFurnitureSvc.GetAll();
        var wallFurnitureCandidates = new Dictionary<string, WallFurnitureCandidate>();

        // Parse floors
        int floorIndex = 0;
        foreach (var floorEl in root.Elements("floor"))
        {
            var floor = new Floor { Index = floorIndex++ };

            // Room grid
            var roomsEl = floorEl.Element("rooms");
            if (roomsEl != null)
                floor.RoomGrid = ParseGrid(roomsEl.Value);

            // Attributes grid (optional – leer = alles 0)
            var attribEl = floorEl.Element("attributes");
            if (attribEl != null)
                floor.AttributesGrid = ParseGrid(attribEl.Value);

            // Tile-Layer-Matrizen (FloorFurniture, Furniture, Furniture2, WallFurniture, …)
            foreach (var layerEl in floorEl.Elements("tiles"))
            {
                var layerName = layerEl.Attribute("layer")?.Value ?? string.Empty;
                if (!string.IsNullOrEmpty(layerName))
                    floor.TileLayers[layerName] = ParseGrid(layerEl.Value);
            }

            // Objects (doors, windows, stairs, …)
            foreach (var obj in floorEl.Elements("object"))
            {
                var typeStr = obj.Attribute("type")?.Value ?? string.Empty;
                var dirStr  = obj.Attribute("dir")?.Value  ?? "N";

                // Bekannte Kernfelder nicht in RawAttributes doppelt ablegen
                var knownAttribs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                    { "type", "x", "y", "dir", "Tile" };
                var rawAttribs = obj.Attributes()
                    .Where(a => !knownAttribs.Contains(a.Name.LocalName))
                    .ToDictionary(a => a.Name.LocalName, a => a.Value);

                floor.Objects.Add(new FloorObject
                {
                    Type = typeStr.ToLowerInvariant() switch
                    {
                        "door"    => FloorObjectType.Door,
                        "window"  => FloorObjectType.Window,
                        "stairs"  => FloorObjectType.Stairs,
                        _         => FloorObjectType.Other
                    },
                    OriginalType   = typeStr,
                    X              = ParseInt(obj.Attribute("x")?.Value),
                    Y              = ParseInt(obj.Attribute("y")?.Value),
                    Dir            = Enum.TryParse<Direction>(dirStr, true, out var dir) ? dir : Direction.N,
                    Tile           = obj.Attribute("Tile")?.Value ?? string.Empty,
                    RawAttributes  = rawAttribs,
                });
            }

            // Compute WallEdges from doors and windows.
            // Each door/window lives on the shared edge between two adjacent cells,
            // so we store both cell references for the furniture-placement system.
            foreach (var obj in floor.Objects)
            {
                if (obj.Type != FloorObjectType.Door && obj.Type != FloorObjectType.Window)
                    continue;

                var geom = ResolveEdgeGeometry(obj.Dir, obj.X, obj.Y);
                if (geom is null) continue;

                floor.Edges.Add(new WallEdge
                {
                    EdgeKey      = $"{(geom.Value.IsHorizontal ? "H" : "V")}:{geom.Value.EdgeCol},{geom.Value.EdgeRow}",
                    Type         = obj.Type,
                    IsHorizontal = geom.Value.IsHorizontal,
                    EdgeCol      = geom.Value.EdgeCol,
                    EdgeRow      = geom.Value.EdgeRow,
                    Cell1Col     = geom.Value.Cell1Col, Cell1Row = geom.Value.Cell1Row,
                    Cell2Col     = geom.Value.Cell2Col, Cell2Row = geom.Value.Cell2Row,
                });
            }

            // Resolve wall-mounted "furniture" placements (doors/windows/arches placed
            // via type="furniture" + FurnitureTiles index instead of type="door"/"window")
            // against the user's persisted classification store.
            ResolveWallFurniture(floor, building.Tbx.FurnitureBlocks, wallFurnitureClassifications, wallFurnitureCandidates);
            ResolvePaintedWallTiles(floor, building.Tbx.UserTiles, wallFurnitureClassifications, wallFurnitureCandidates);

            // Compute WallEdges from explicit wall objects (type="wall").
            // dir=N: vertical wall (west face of cells), length extends south (y increases).
            // dir=W: horizontal wall (north face of cells), length extends east (x increases).
            // InteriorTile=0 → Opening (gap in room-boundary wall).
            // InteriorTile>0 → InnerWall (free-standing wall within a room).
            // Exception: walls built from a commercial wall set (often whole-glass shop
            // fronts) are listed for review and take their classified type instead.
            foreach (var wallObj in floor.Objects.Where(o => o.OriginalType.Equals("wall", StringComparison.OrdinalIgnoreCase)))
            {
                int interiorTile = int.TryParse(
                    wallObj.RawAttributes.GetValueOrDefault("InteriorTile", "0"), out var it) ? it : 0;
                int length = int.TryParse(
                    wallObj.RawAttributes.GetValueOrDefault("length", "1"), out var wl) ? wl : 1;

                var edgeType = interiorTile == 0 ? FloorObjectType.Opening : FloorObjectType.InnerWall;

                var commercialTile = ResolveCommercialWallObject(
                    wallObj, building.Tbx.TileEntries, wallFurnitureClassifications, wallFurnitureCandidates);
                if (commercialTile is not null
                    && ClassificationToEdgeType(wallFurnitureClassifications.GetValueOrDefault(commercialTile)) is { } classified)
                    edgeType = classified;

                for (int i = 0; i < length; i++)
                {
                    bool wIsHorizontal;
                    int wEdgeCol, wEdgeRow, wc1Col, wc1Row, wc2Col, wc2Row;

                    if (wallObj.Dir == Direction.N)
                    {
                        // Vertical wall, west face of cells, extends south (y increases)
                        wEdgeCol = wallObj.X; wEdgeRow = wallObj.Y + i;
                        wIsHorizontal = false;
                        wc1Col = wEdgeCol - 1; wc1Row = wEdgeRow;
                        wc2Col = wEdgeCol;     wc2Row = wEdgeRow;
                    }
                    else // Direction.W
                    {
                        // Horizontal wall, north face of cells, extends east (x increases)
                        wEdgeCol = wallObj.X + i; wEdgeRow = wallObj.Y;
                        wIsHorizontal = true;
                        wc1Col = wEdgeCol; wc1Row = wEdgeRow - 1;
                        wc2Col = wEdgeCol; wc2Row = wEdgeRow;
                    }

                    floor.Edges.Add(new WallEdge
                    {
                        EdgeKey           = $"{(wIsHorizontal ? "H" : "V")}:{wEdgeCol},{wEdgeRow}",
                        Type              = edgeType,
                        IsHorizontal      = wIsHorizontal,
                        EdgeCol           = wEdgeCol,  EdgeRow          = wEdgeRow,
                        Cell1Col          = wc1Col,    Cell1Row         = wc1Row,
                        Cell2Col          = wc2Col,    Cell2Row         = wc2Row,
                        InteriorTileIndex = interiorTile,
                    });
                }
            }

            building.Floors.Add(floor);
        }

        building.WallFurnitureCandidates = [.. wallFurnitureCandidates.Values];

        // ── Stair waypoints (computed once here, stored per floor) ─────────────
        const int StairSpan = 5;
        for (int fi = 0; fi < building.Floors.Count; fi++)
        {
            var fl = building.Floors[fi];
            foreach (var obj in fl.Objects)
            {
                if (obj.Type != FloorObjectType.Stairs) continue;

                // Ascending entry = LAST cell of span on this floor
                int ei    = StairSpan - 1;
                int acCol = obj.Dir == Direction.W ? obj.X + ei : obj.X;
                int acRow = obj.Dir == Direction.N ? obj.Y + ei : obj.Y;
                fl.StairWaypoints.Add(new StairWaypoint
                {
                    Col = acCol, Row = acRow,
                    WaypointType = StairWaypointType.Ascending
                });

                // Descending entry = FIRST cell of span on the floor ABOVE
                if (fi + 1 < building.Floors.Count)
                    building.Floors[fi + 1].StairWaypoints.Add(new StairWaypoint
                    {
                        Col = obj.X, Row = obj.Y,
                        WaypointType = StairWaypointType.Descending
                    });
            }
        }

        return building;
    }

    // -----------------------------------------------------------------------

    private readonly record struct EdgeGeometry(
        bool IsHorizontal, int EdgeCol, int EdgeRow,
        int Cell1Col, int Cell1Row, int Cell2Col, int Cell2Row);

    /// <summary>
    /// Resolves which canonical wall edge (and the two cells sharing it) a
    /// door/window/wall-furniture placement at (x,y) facing <paramref name="dir"/>
    /// sits on. Shared by the normal door/window loop and ResolveWallFurniture so
    /// the geometry only lives in one place.
    /// </summary>
    private static EdgeGeometry? ResolveEdgeGeometry(Direction dir, int x, int y) => dir switch
    {
        Direction.N => new EdgeGeometry(true, x, y, x, y - 1, x, y),           // north wall of (x,y) = south wall of (x,y-1)
        Direction.S => new EdgeGeometry(true, x, y + 1, x, y, x, y + 1),       // south wall of (x,y) = north wall of (x,y+1)
        Direction.W => new EdgeGeometry(false, x, y, x - 1, y, x, y),          // west wall of (x,y) = east wall of (x-1,y)
        Direction.E => new EdgeGeometry(false, x + 1, y, x, y, x + 1, y),      // east wall of (x,y) = west wall of (x+1,y)
        _           => null,
    };

    /// <summary>
    /// Resolves type="furniture" placements (wall-mounted doors/windows/arches
    /// authored via TileZed's generic furniture mechanism instead of a normal
    /// type="door"/"window" object) against the persisted classification store,
    /// synthesizing WallEdges for classified sub-tiles and collecting every
    /// distinct entry (classified or not) into <paramref name="candidates"/> for
    /// the frontend's review panel. Multi-tile entries are classified per
    /// individual tile — a 2-wide arch can have e.g. its left tile set to Window
    /// and its right tile set to Door, since some tilesets place visually similar
    /// door/window tiles right next to each other in the same entry.
    /// </summary>
    private static void ResolveWallFurniture(
        Floor floor,
        List<TbxFurnitureBlock> furnitureBlocks,
        Dictionary<string, string> classifications,
        Dictionary<string, WallFurnitureCandidate> candidates)
    {
        foreach (var obj in floor.Objects)
        {
            if (!obj.OriginalType.Equals("furniture", StringComparison.OrdinalIgnoreCase))
                continue;
            if (!int.TryParse(obj.RawAttributes.GetValueOrDefault("FurnitureTiles"), out var blockIndex))
                continue;
            if (blockIndex < 0 || blockIndex >= furnitureBlocks.Count)
                continue;

            var block = furnitureBlocks[blockIndex];
            if (!Enum.TryParse<Direction>(obj.RawAttributes.GetValueOrDefault("orient", "N"), true, out var orient))
                orient = Direction.N;

            // <furniture> blocks key entries by short orient codes (W/N/NW), unlike
            // tile_entry categories which use long enum names (West/North). A wall
            // segment only has 2 physical axes, so S/E placements reuse the N/W entry.
            var entryKey = orient is Direction.W or Direction.E ? "W" : "N";
            var entry = block.Entries.FirstOrDefault(e => e.Orient == entryKey);
            if (entry is null || entry.Tiles.Count == 0) continue;

            var validTiles = entry.Tiles.Where(t => !string.IsNullOrEmpty(t.Name)).ToList();
            if (validTiles.Count == 0) continue;

            var signature = ComputeWallFurnitureSignature(block);
            if (!candidates.TryGetValue(signature, out var candidate))
            {
                candidate = new WallFurnitureCandidate
                {
                    Signature = signature,
                    Tiles = validTiles.Select(t => new WallFurnitureTileCandidate
                    {
                        Name           = t.Name,
                        Classification = classifications.GetValueOrDefault(t.Name),
                    }).ToList(),
                };
                candidates[signature] = candidate;
            }
            candidate.Count++;

            // A multi-tile entry's sub-tiles run along the wall's own axis: N/S-type
            // entries offset in x (a horizontally-spanning wall), W/E-type entries
            // offset in y (a vertically-spanning wall) — each sub-tile therefore
            // occupies a different grid cell and is resolved/classified independently.
            bool offsetsAlongX = entryKey == "N";
            foreach (var tile in validTiles)
            {
                var resolvedType = ClassificationToEdgeType(classifications.GetValueOrDefault(tile.Name));
                if (resolvedType is null) continue;

                int tileX = obj.X + (offsetsAlongX ? tile.X : 0);
                int tileY = obj.Y + (offsetsAlongX ? 0 : tile.Y);

                var geom = ResolveEdgeGeometry(orient, tileX, tileY);
                if (geom is null) continue;

                floor.Edges.Add(new WallEdge
                {
                    EdgeKey      = $"{(geom.Value.IsHorizontal ? "H" : "V")}:{geom.Value.EdgeCol},{geom.Value.EdgeRow}",
                    Type         = resolvedType.Value,
                    IsHorizontal = geom.Value.IsHorizontal,
                    EdgeCol      = geom.Value.EdgeCol,
                    EdgeRow      = geom.Value.EdgeRow,
                    Cell1Col     = geom.Value.Cell1Col, Cell1Row = geom.Value.Cell1Row,
                    Cell2Col     = geom.Value.Cell2Col, Cell2Row = geom.Value.Cell2Row,
                });
            }
        }
    }

    /// <summary>Maps a stored wall-furniture classification to the WallEdge type it produces.</summary>
    private static FloorObjectType? ClassificationToEdgeType(string? classification) => classification switch
    {
        "WindowHigh" or "WindowHighLow" => FloorObjectType.Window,
        "Door"                           => FloorObjectType.Door,
        _                                => null, // Ignore / unclassified → stays a plain wall
    };

    /// <summary>
    /// Commercial wall tiles (e.g. "walls_commercial_02_024", a wall section with a
    /// built-in shop window) painted directly into a tile layer (typically WallTrim)
    /// instead of being placed as a door/window object. Each distinct tile becomes
    /// its own single-tile candidate in the wall-furniture review list; classified
    /// placements synthesize a WallEdge just like type="furniture" entries do.
    /// </summary>
    private static void ResolvePaintedWallTiles(
        Floor floor,
        List<string> userTiles,
        Dictionary<string, string> classifications,
        Dictionary<string, WallFurnitureCandidate> candidates)
    {
        var existingEdges = floor.Edges.Select(e => e.EdgeKey).ToHashSet();

        foreach (var grid in floor.TileLayers.Values)
        {
            for (int y = 0; y < grid.Length; y++)
            for (int x = 0; x < grid[y].Length; x++)
            {
                // Layer values are 1-based indices into user_tiles (0 = empty).
                int v = grid[y][x];
                if (v <= 0 || v > userTiles.Count) continue;
                var name = userTiles[v - 1];
                if (!IsCommercialWallTile(name)) continue;

                if (!candidates.TryGetValue(name, out var candidate))
                {
                    candidate = new WallFurnitureCandidate
                    {
                        Signature = name,
                        Tiles = [new WallFurnitureTileCandidate
                        {
                            Name           = name,
                            Classification = classifications.GetValueOrDefault(name),
                        }],
                    };
                    candidates[name] = candidate;
                }
                candidate.Count++;

                var resolvedType = ClassificationToEdgeType(classifications.GetValueOrDefault(name));
                if (resolvedType is null) continue;

                // PZ wall sheets alternate West/North faces: even index = West wall
                // (west edge of the cell), odd index = North wall (north edge).
                var orient = TileIndex(name) % 2 == 0 ? Direction.W : Direction.N;
                var geom = ResolveEdgeGeometry(orient, x, y);
                if (geom is null) continue;

                var edgeKey = $"{(geom.Value.IsHorizontal ? "H" : "V")}:{geom.Value.EdgeCol},{geom.Value.EdgeRow}";
                if (!existingEdges.Add(edgeKey)) continue; // stacked layers / real door object on same edge

                floor.Edges.Add(new WallEdge
                {
                    EdgeKey      = edgeKey,
                    Type         = resolvedType.Value,
                    IsHorizontal = geom.Value.IsHorizontal,
                    EdgeCol      = geom.Value.EdgeCol,
                    EdgeRow      = geom.Value.EdgeRow,
                    Cell1Col     = geom.Value.Cell1Col, Cell1Row = geom.Value.Cell1Row,
                    Cell2Col     = geom.Value.Cell2Col, Cell2Row = geom.Value.Cell2Row,
                });
            }
        }
    }

    /// <summary>
    /// If a type="wall" object is built from a commercial wall set (its exterior
    /// Tile entry, else its InteriorTile entry), registers the set as a review
    /// candidate — one classifiable sub-tile per face (West / North) — and returns
    /// the tile name actually shown by this wall's orientation. Null otherwise.
    /// Tile / InteriorTile are 1-based indices into the tile_entry list (0 = none).
    /// </summary>
    private static string? ResolveCommercialWallObject(
        FloorObject wallObj,
        List<TbxTileEntryBlock> tileEntries,
        Dictionary<string, string> classifications,
        Dictionary<string, WallFurnitureCandidate> candidates)
    {
        TbxTileEntryBlock? EntryAt(string attr) =>
            int.TryParse(attr == "Tile" ? wallObj.Tile : wallObj.RawAttributes.GetValueOrDefault(attr), out var i)
            && i >= 1 && i <= tileEntries.Count ? tileEntries[i - 1] : null;

        var entry = new[] { EntryAt("Tile"), EntryAt("InteriorTile") }
            .FirstOrDefault(e => e is not null && e.Tiles.Any(t => IsCommercialWallTile(t.Tile)));
        if (entry is null) return null;

        string? TileFor(string enumName) =>
            entry.Tiles.FirstOrDefault(t => t.Enum == enumName && !string.IsNullOrEmpty(t.Tile))?.Tile;
        var faces = new[] { TileFor("West"), TileFor("North") }.OfType<string>().ToList();
        if (faces.Count == 0) return null;

        var signature = string.Join("|", faces.Distinct(StringComparer.Ordinal).OrderBy(n => n, StringComparer.Ordinal));
        if (!candidates.TryGetValue(signature, out var candidate))
        {
            candidate = new WallFurnitureCandidate
            {
                Signature = signature,
                Tiles = faces.Distinct(StringComparer.Ordinal).Select(n => new WallFurnitureTileCandidate
                {
                    Name           = n,
                    Classification = classifications.GetValueOrDefault(n),
                }).ToList(),
            };
            candidates[signature] = candidate;
        }
        candidate.Count++;

        // dir=N is the vertical west-face wall (West tile), dir=W the horizontal north-face wall.
        return wallObj.Dir == Direction.N ? TileFor("West") : TileFor("North");
    }

    /// <summary>True for any commercial wall tile, including prefixed sets like "melos_tiles_walls_commercial_05_024".</summary>
    private static bool IsCommercialWallTile(string tileName) =>
        tileName.Contains("walls_commercial_", StringComparison.OrdinalIgnoreCase);

    /// <summary>Trailing sprite index of a tile name ("walls_commercial_02_024" → 24), or 0 if none.</summary>
    private static int TileIndex(string tileName)
    {
        int us = tileName.LastIndexOf('_');
        return us >= 0 && int.TryParse(tileName[(us + 1)..], out var n) ? n : 0;
    }

    /// <summary>
    /// Stable identity key for a furniture block, independent of file, orientation,
    /// or the arbitrary FurnitureTiles index — the sorted set of all tile names the
    /// block references. Two blocks (in the same or different files) that reference
    /// the same tiles share a signature and therefore a classification.
    /// </summary>
    private static string ComputeWallFurnitureSignature(TbxFurnitureBlock block)
    {
        var names = block.Entries
            .SelectMany(e => e.Tiles)
            .Select(t => t.Name)
            .Where(n => !string.IsNullOrEmpty(n))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(n => n, StringComparer.Ordinal);
        return string.Join("|", names);
    }

    private static int[][] ParseGrid(string raw)
    {
        var rows = raw
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(l => l.Length > 0)
            .Select(line =>
                line.Split(',', StringSplitOptions.TrimEntries)
                    .Where(v => v.Length > 0)
                    .Select(v => int.TryParse(v, out var n) ? n : 0)
                    .ToArray()
            )
            .ToArray();
        return rows;
    }

    private static int ParseInt(string? value) =>
        int.TryParse(value, out var n) ? n : 0;
}

