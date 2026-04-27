using System.Xml.Linq;
using backend.Models;

namespace backend.Services;

public interface ITbxParserService
{
    Building Parse(Stream stream);
}

public class TbxParserService : ITbxParserService
{
    public Building Parse(Stream stream)
    {
        var doc = XDocument.Load(stream);
        var root = doc.Root ?? throw new InvalidDataException("Invalid TBX file: no root element.");

        var building = new Building
        {
            Width  = int.Parse(root.Attribute("width")?.Value  ?? "0"),
            Height = int.Parse(root.Attribute("height")?.Value ?? "0"),
        };

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

        // Parse floors
        int floorIndex = 0;
        foreach (var floorEl in root.Elements("floor"))
        {
            var floor = new Floor { Index = floorIndex++ };

            // Room grid
            var roomsEl = floorEl.Element("rooms");
            if (roomsEl != null)
                floor.RoomGrid = ParseGrid(roomsEl.Value);

            // Objects (doors, windows, stairs, …)
            foreach (var obj in floorEl.Elements("object"))
            {
                var typeStr = obj.Attribute("type")?.Value ?? string.Empty;
                var dirStr  = obj.Attribute("dir")?.Value  ?? "N";

                floor.Objects.Add(new FloorObject
                {
                    Type = typeStr.ToLowerInvariant() switch
                    {
                        "door"    => FloorObjectType.Door,
                        "window"  => FloorObjectType.Window,
                        "stairs"  => FloorObjectType.Stairs,
                        _         => FloorObjectType.Other
                    },
                    OriginalType = typeStr,
                    X    = ParseInt(obj.Attribute("x")?.Value),
                    Y    = ParseInt(obj.Attribute("y")?.Value),
                    Dir  = Enum.TryParse<Direction>(dirStr, true, out var dir) ? dir : Direction.N,
                    Tile = obj.Attribute("Tile")?.Value ?? string.Empty,
                });
            }

            // Compute WallEdges from doors and windows.
            // Each door/window lives on the shared edge between two adjacent cells,
            // so we store both cell references for the furniture-placement system.
            foreach (var obj in floor.Objects)
            {
                if (obj.Type != FloorObjectType.Door && obj.Type != FloorObjectType.Window)
                    continue;

                // Resolve which canonical edge key and which two cells share it
                bool isHorizontal;
                int edgeCol, edgeRow, c1Col, c1Row, c2Col, c2Row;

                switch (obj.Dir)
                {
                    case Direction.N: // north wall of cell (X,Y) = south wall of cell (X, Y-1)
                        isHorizontal = true;
                        edgeCol = obj.X; edgeRow = obj.Y;
                        c1Col = obj.X; c1Row = obj.Y - 1;   // cell above
                        c2Col = obj.X; c2Row = obj.Y;        // this cell
                        break;
                    case Direction.S: // south wall of (X,Y) = north wall of (X, Y+1)
                        isHorizontal = true;
                        edgeCol = obj.X; edgeRow = obj.Y + 1;
                        c1Col = obj.X; c1Row = obj.Y;
                        c2Col = obj.X; c2Row = obj.Y + 1;
                        break;
                    case Direction.W: // west wall of (X,Y) = east wall of (X-1, Y)
                        isHorizontal = false;
                        edgeCol = obj.X; edgeRow = obj.Y;
                        c1Col = obj.X - 1; c1Row = obj.Y;   // cell to the left
                        c2Col = obj.X;     c2Row = obj.Y;
                        break;
                    case Direction.E: // east wall of (X,Y) = west wall of (X+1, Y)
                        isHorizontal = false;
                        edgeCol = obj.X + 1; edgeRow = obj.Y;
                        c1Col = obj.X;     c1Row = obj.Y;
                        c2Col = obj.X + 1; c2Row = obj.Y;   // cell to the right
                        break;
                    default: continue;
                }

                floor.Edges.Add(new WallEdge
                {
                    EdgeKey      = $"{(isHorizontal ? "H" : "V")}:{edgeCol},{edgeRow}",
                    Type         = obj.Type,
                    IsHorizontal = isHorizontal,
                    EdgeCol      = edgeCol,
                    EdgeRow      = edgeRow,
                    Cell1Col     = c1Col, Cell1Row = c1Row,
                    Cell2Col     = c2Col, Cell2Row = c2Row,
                });
            }

            building.Floors.Add(floor);
        }

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

