using backend.Models;

namespace backend.Services;

public partial class FurnishingGeneratorService
{
    private const string LightSwitchGroup  = "Lightswitch";
    private const string LightSwitchSlotId = "light_switch";

    // Cell → lower-case layer of the switches placed in the current room component (null = none).
    // Thread-static so WallFaceTaken/HighCellTaken cover grids, layouts and slots alike.
    [ThreadStatic] private static Dictionary<(int, int), (string Layer, string? Side)>? t_switchCells;

    private readonly record struct SwitchSpot(int Col, int Row, Direction Wall, bool Left);

    private static (int dc, int dr) Step(Direction d) => d switch
    {
        Direction.N => (0, -1),
        Direction.S => (0, 1),
        Direction.W => (-1, 0),
        _           => (1, 0),
    };

    private static Direction Opposite(Direction d) => d switch
    {
        Direction.N => Direction.S,
        Direction.S => Direction.N,
        Direction.W => Direction.E,
        _           => Direction.W,
    };

    private static Direction[] AlongWall(Direction wall) =>
        wall is Direction.N or Direction.S ? [Direction.W, Direction.E] : [Direction.N, Direction.S];

    /// <summary>
    /// Which sprite has its switch at the given end of the wall. Taken from the tile art: the
    /// "left" tiles sit at the east end of a N wall, south of a W wall, north of an E wall and
    /// west of a S wall; the "right" tiles at the opposite ends.
    /// </summary>
    private static bool IsLeftSwitch(Direction wall, Direction end) => (wall, end) is
        (Direction.N, Direction.E) or (Direction.W, Direction.S) or (Direction.E, Direction.N) or (Direction.S, Direction.W);

    /// <summary>
    /// Places the room component's light switches before any furniture: a random number from 1 up
    /// to one per door, each on the door's wall in a neighbouring cell. Returns the used cells.
    /// Colour exclusions and room-type tags deliberately don't apply (pass the unfiltered catalog).
    /// </summary>
    private static Dictionary<(int, int), (string Layer, string? Side)> PlaceLightSwitches(
        Floor floor, int floorIndex, HashSet<(int, int)> roomCells,
        Dictionary<(int, int), HashSet<Direction>> cellWalls,
        IReadOnlyDictionary<string, TileDefinition> catalog, Random rng,
        int roomIndex1Based, int? selectionAnchorCol, int? selectionAnchorRow,
        List<PlacedFurnitureItem> placements, List<string> log)
    {
        var used = new Dictionary<(int, int), (string Layer, string? Side)>();

        var tiles = catalog.Values
            .Where(t => t.Group.Equals(LightSwitchGroup, StringComparison.OrdinalIgnoreCase))
            .OrderBy(t => t.Id, StringComparer.Ordinal)
            .ToList();
        List<TileDefinition> TilesFor(SwitchSpot spot) => tiles
            .Where(t => t.Orientation.Equals(spot.Wall.ToString(), StringComparison.OrdinalIgnoreCase)
                     && t.VariantGroup.Contains(spot.Left ? "left" : "right", StringComparison.OrdinalIgnoreCase))
            .ToList();
        if (tiles.Count == 0)
        {
            log.Add($"  [SWITCH] no enabled tile in category '{LightSwitchGroup}', room stays without");
            return used;
        }

        var openFaces = floor.Edges
            .Where(e => e.Type is FloorObjectType.Door or FloorObjectType.Window or FloorObjectType.Opening)
            .Select(e => e.EdgeKey)
            .ToHashSet();

        static string FaceKey(int col, int row, Direction wall) => wall switch
        {
            Direction.N => $"H:{col},{row}",
            Direction.S => $"H:{col},{row + 1}",
            Direction.W => $"V:{col},{row}",
            _           => $"V:{col + 1},{row}",
        };
        bool Usable(SwitchSpot s) =>
            !used.ContainsKey((s.Col, s.Row))
            && roomCells.Contains((s.Col, s.Row))
            && cellWalls.TryGetValue((s.Col, s.Row), out var walls) && walls.Contains(s.Wall)
            && !openFaces.Contains(FaceKey(s.Col, s.Row, s.Wall))
            && TilesFor(s).Count > 0;

        bool TryPlace(List<SwitchSpot> spots)
        {
            var usable = spots.Where(Usable).ToList();
            if (usable.Count == 0) return false;
            var spot = usable[rng.Next(usable.Count)];
            var options = TilesFor(spot);
            var tile = options[rng.Next(options.Count)];
            var tileId = tile.TileLayout.FirstOrDefault()?.FirstOrDefault(id => !string.IsNullOrEmpty(id)) ?? tile.Id;
            placements.Add(new PlacedFurnitureItem(floorIndex, spot.Col, spot.Row, tileId, tile.Layer, spot.Wall.ToString(),
                LightSwitchSlotId, roomIndex1Based, selectionAnchorCol, selectionAnchorRow,
                WallSide: WallSideOf(tile), HighPiece: tile.IsHigh));
            used[(spot.Col, spot.Row)] = (tile.Layer.ToLowerInvariant(), WallSideOf(tile));
            log.Add($"  [SWITCH] '{tileId}' orient '{spot.Wall}' at ({spot.Col},{spot.Row})");
            return true;
        }

        // The sides of an edge inside this room component: the cell and the wall the edge is on.
        List<(int col, int row, Direction wall)> Sides(WallEdge e)
        {
            var sides = new List<(int, int, Direction)>(2);
            if (roomCells.Contains((e.Cell1Col, e.Cell1Row)))
                sides.Add((e.Cell1Col, e.Cell1Row, e.IsHorizontal ? Direction.S : Direction.E));
            if (roomCells.Contains((e.Cell2Col, e.Cell2Row)))
                sides.Add((e.Cell2Col, e.Cell2Row, e.IsHorizontal ? Direction.N : Direction.W));
            return sides;
        }

        // Same wall, one cell further along it, switch at the end touching the door.
        static List<SwitchSpot> BesideEntrance(List<(int col, int row, Direction wall)> sides) =>
            sides.SelectMany(s => AlongWall(s.wall).Select(toward =>
            {
                var (dc, dr) = Step(toward);
                return new SwitchSpot(s.col + dc, s.row + dr, s.wall, IsLeftSwitch(s.wall, Opposite(toward)));
            })).ToList();

        // Door in a corner: the crossing wall of the door's own cell, switch at the end nearest the door.
        static List<SwitchSpot> OnCrossingWall(List<(int col, int row, Direction wall)> sides) =>
            sides.SelectMany(s => AlongWall(s.wall).Select(wall =>
                new SwitchSpot(s.col, s.row, wall, IsLeftSwitch(wall, s.wall)))).ToList();

        var doors = floor.Edges.Where(e => e.Type == FloorObjectType.Door).Select(Sides).Where(s => s.Count > 0).ToList();
        var openings = floor.Edges.Where(e => e.Type == FloorObjectType.Opening).Select(Sides).Where(s => s.Count > 0).ToList();

        // Fisher-Yates, so which door gets the guaranteed switch varies by seed.
        for (int i = doors.Count - 1; i > 0; i--)
        {
            int j = rng.Next(i + 1);
            (doors[i], doors[j]) = (doors[j], doors[i]);
        }
        int wanted = doors.Count > 1 ? rng.Next(1, doors.Count + 1) : 1;

        // Guaranteed switch: first spot type that has anywhere to go.
        int firstDoor = doors.FindIndex(d => TryPlace(BesideEntrance(d)));
        bool placedAny = firstDoor >= 0
            || doors.Any(d => TryPlace(OnCrossingWall(d)))
            || openings.Any(o => TryPlace(BesideEntrance(o)))
            || openings.Any(o => TryPlace(OnCrossingWall(o)))
            || TryPlace(cellWalls
                .OrderBy(kv => kv.Key.Item2).ThenBy(kv => kv.Key.Item1)
                .SelectMany(kv => kv.Value.OrderBy(d => d).Select(wall =>
                    new SwitchSpot(kv.Key.Item1, kv.Key.Item2, wall, rng.Next(2) == 0)))
                .ToList());
        if (!placedAny)
        {
            log.Add("  [SWITCH] no free wall spot, room stays without");
            return used;
        }

        // Extra switches only beside further doors.
        int placed = 1;
        for (int i = firstDoor + 1; firstDoor >= 0 && i < doors.Count && placed < wanted; i++)
            if (TryPlace(BesideEntrance(doors[i]))) placed++;

        return used;
    }
}
