using System.Text;
using backend.Models;

namespace backend.Services;

public interface ITbxExportService
{
    /// <summary>
    /// Reconstructs a TBX XML string from a Building + new furniture placements.
    /// All original objects (doors, windows, stairs, …) are preserved via OriginalType.
    /// </summary>
    string Export(Building building, List<PlacedFurnitureItem> placements);
}

public class TbxExportService : ITbxExportService
{
    public string Export(Building building, List<PlacedFurnitureItem> placements)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"<building width=\"{building.Width}\" height=\"{building.Height}\">");

        // ── Rooms ─────────────────────────────────────────────────────────────
        foreach (var room in building.Rooms)
        {
            sb.AppendLine(
                $"  <room Name=\"{Esc(room.Name)}\" InternalName=\"{Esc(room.InternalName)}\"" +
                $" Color=\"{Esc(room.Color)}\"" +
                $" InteriorWall=\"{room.InteriorWall}\" InteriorWallTrim=\"{room.InteriorWallTrim}\"" +
                $" Floor=\"{room.FloorTile}\" GrimeFloor=\"{room.GrimeFloor}\"" +
                $" GrimeWall=\"{room.GrimeWall}\" Ceiling=\"{room.Ceiling}\"/>");
        }

        // ── Floors ────────────────────────────────────────────────────────────
        foreach (var floor in building.Floors.OrderBy(f => f.Index))
        {
            sb.AppendLine("  <floor>");

            // Room grid
            sb.AppendLine("    <rooms>");
            foreach (var row in floor.RoomGrid)
                sb.AppendLine("      " + string.Join(",", row));
            sb.AppendLine("    </rooms>");

            // Original objects (doors, windows, stairs, pre-existing furniture, …)
            foreach (var obj in floor.Objects)
            {
                var typeStr = !string.IsNullOrEmpty(obj.OriginalType)
                    ? obj.OriginalType
                    : obj.Type switch
                    {
                        FloorObjectType.Door   => "door",
                        FloorObjectType.Window => "window",
                        FloorObjectType.Stairs => "stairs",
                        _                      => "furniture",
                    };
                sb.AppendLine(
                    $"    <object type=\"{typeStr}\" x=\"{obj.X}\" y=\"{obj.Y}\"" +
                    $" dir=\"{obj.Dir}\" Tile=\"{Esc(obj.Tile)}\"/>");
            }

            // New furniture placements for this floor
            foreach (var p in placements.Where(p => p.FloorIndex == floor.Index))
            {
                sb.AppendLine(
                    $"    <object type=\"furniture\" x=\"{p.Col}\" y=\"{p.Row}\"" +
                    $" dir=\"{p.Orient}\" Tile=\"{Esc(p.TileId)}\"/>");
            }

            sb.AppendLine("  </floor>");
        }

        sb.AppendLine("</building>");
        return sb.ToString();
    }

    private static string Esc(string s) =>
        s.Replace("&", "&amp;")
         .Replace("\"", "&quot;")
         .Replace("<", "&lt;")
         .Replace(">", "&gt;");
}

