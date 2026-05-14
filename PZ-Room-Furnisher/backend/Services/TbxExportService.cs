using System.Text;
using backend.Models;

namespace backend.Services;

public interface ITbxExportService
{
    /// <summary>
    /// Reconstructs a TBX XML string from a Building + new furniture placements.
    /// Original structure (tile_entries, rooms, doors/windows/stairs, attributes) is
    /// preserved via TbxMetadata; furniture is written as user_tiles + layer matrices.
    /// </summary>
    string Export(Building building, List<PlacedFurnitureItem> placements);
}

public class TbxExportService : ITbxExportService
{
    // Bekannte Layer in der gewünschten Exportreihenfolge
    private static readonly string[] KnownLayerOrder =
        ["FloorFurniture", "Furniture", "Furniture2", "WallFurniture"];

    public string Export(Building building, List<PlacedFurnitureItem> placements)
    {
        // ── 1. user_tiles-Liste aufbauen (1-basiert, Reihenfolge des Auftretens) ──
        var userTiles   = new List<string>();
        var tileToIndex = new Dictionary<string, int>(StringComparer.Ordinal);

        int GetOrAddIndex(string tileId)
        {
            if (!tileToIndex.TryGetValue(tileId, out var idx))
            {
                userTiles.Add(tileId);
                idx = userTiles.Count; // 1-basiert
                tileToIndex[tileId] = idx;
            }
            return idx;
        }

        // ── 2. Layer-Matrizen aus Placements erzeugen ──────────────────────────
        // TBX-Konvention (aus Referenzdatei abgeleitet):
        //   tile layer-Matrizen: (height+1) Zeilen × (width+1) Spalten
        //   rooms / attributes:   height     Zeilen × width      Spalten
        int layerRows  = building.Height + 1;
        int layerCols  = building.Width  + 1;
        int attribRows = building.Height;
        int attribCols = building.Width;

        var layerMatrices = new Dictionary<int, Dictionary<string, int[][]>>();
        foreach (var floor in building.Floors.OrderBy(f => f.Index))
            layerMatrices[floor.Index] = new Dictionary<string, int[][]>(StringComparer.Ordinal);

        foreach (var p in placements)
        {
            var idx       = GetOrAddIndex(p.TileId);
            var layerName = string.IsNullOrEmpty(p.Layer) ? "Furniture" : p.Layer;

            if (!layerMatrices.TryGetValue(p.FloorIndex, out var floorLayers))
            {
                floorLayers = new Dictionary<string, int[][]>(StringComparer.Ordinal);
                layerMatrices[p.FloorIndex] = floorLayers;
            }

            if (!floorLayers.TryGetValue(layerName, out var matrix))
            {
                matrix = Enumerable.Range(0, layerRows).Select(_ => new int[layerCols]).ToArray();
                floorLayers[layerName] = matrix;
            }

            if (p.Row >= 0 && p.Row < layerRows && p.Col >= 0 && p.Col < layerCols)
                matrix[p.Row][p.Col] = idx;
        }

        // ── 3. XML aufbauen ───────────────────────────────────────────────────
        var sb = new StringBuilder();
        sb.AppendLine("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");

        // <building …> mit stabiler Attributreihenfolge:
        // 1) version (falls vorhanden), 2) width/height, 3) restliche Root-Attribute.
        sb.Append("<building");
        if (building.Tbx.RootAttributes.TryGetValue("version", out var versionVal) && !string.IsNullOrEmpty(versionVal))
            sb.Append($" version=\"{Esc(versionVal)}\"");
        sb.Append($" width=\"{building.Width}\" height=\"{building.Height}\"");
        foreach (var (key, val) in building.Tbx.RootAttributes)
        {
            if (key.Equals("version", StringComparison.OrdinalIgnoreCase)) continue;
            sb.Append($" {key}=\"{Esc(val)}\"");
        }
        sb.AppendLine(">");

        // tile_entry-Blöcke (Original-Reihenfolge erhalten)
        foreach (var block in building.Tbx.TileEntries)
        {
            sb.AppendLine($" <tile_entry category=\"{Esc(block.Category)}\">");
            foreach (var te in block.Tiles)
            {
                var offsetPart = string.IsNullOrEmpty(te.Offset) ? "" : $" offset=\"{Esc(te.Offset)}\"";
                sb.AppendLine($"  <tile enum=\"{Esc(te.Enum)}\" tile=\"{Esc(te.Tile)}\"{offsetPart}/>");
            }
            sb.AppendLine(" </tile_entry>");
        }

        // user_tiles
        if (userTiles.Count > 0)
        {
            sb.AppendLine(" <user_tiles>");
            foreach (var t in userTiles)
                sb.AppendLine($"  <tile tile=\"{Esc(t)}\"/>");
            sb.AppendLine(" </user_tiles>");
        }
        else
        {
            sb.AppendLine(" <user_tiles/>");
        }

        // used_tiles (Originalwerte unverändert)
        if (building.Tbx.UsedTiles.Count > 0)
            sb.AppendLine($" <used_tiles>{string.Join(" ", building.Tbx.UsedTiles)}</used_tiles>");

        // used_furniture
        sb.AppendLine($" <used_furniture>{Esc(building.Tbx.UsedFurnitureRaw)}</used_furniture>");

        // room-Definitionen
        foreach (var room in building.Rooms)
        {
            sb.AppendLine(
                $" <room Name=\"{Esc(room.Name)}\" InternalName=\"{Esc(room.InternalName)}\"" +
                $" Color=\"{Esc(room.Color)}\"" +
                $" InteriorWall=\"{room.InteriorWall}\" InteriorWallTrim=\"{room.InteriorWallTrim}\"" +
                $" Floor=\"{room.FloorTile}\" GrimeFloor=\"{room.GrimeFloor}\"" +
                $" GrimeWall=\"{room.GrimeWall}\" Ceiling=\"{room.Ceiling}\"/>");
        }

        // floors
        foreach (var floor in building.Floors.OrderBy(f => f.Index))
        {
            sb.AppendLine(" <floor>");

            // Objects (doors, windows, stairs, …)
            // RawAttributes ZUERST ausgeben (Original hat z.B. FrameTile vor x)
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

                sb.Append($"  <object type=\"{typeStr}\"");
                foreach (var (k, v) in obj.RawAttributes)
                    sb.Append($" {k}=\"{Esc(v)}\"");
                sb.Append($" x=\"{obj.X}\" y=\"{obj.Y}\" dir=\"{obj.Dir}\" Tile=\"{Esc(obj.Tile)}\"");
                sb.AppendLine("/>");
            }

            // rooms-Grid
            sb.AppendLine("  <rooms>");
            for (int i = 0; i < floor.RoomGrid.Length; i++)
                sb.AppendLine(FormatMatrixRow(floor.RoomGrid[i], i < floor.RoomGrid.Length - 1));
            sb.AppendLine("  </rooms>");

            // attributes-Grid: importierten Wert exakt übernehmen;
            // Fallback = leere height × width Matrix
            var attribGrid = floor.AttributesGrid.Length > 0
                ? floor.AttributesGrid
                : Enumerable.Range(0, attribRows).Select(_ => new int[attribCols]).ToArray();
            sb.AppendLine("  <attributes>");
            for (int i = 0; i < attribGrid.Length; i++)
                sb.AppendLine(FormatMatrixRow(attribGrid[i], i < attribGrid.Length - 1));
            sb.AppendLine("  </attributes>");

            // Möbel-Layer-Matrizen (nur belegte Layer ausgeben)
            layerMatrices.TryGetValue(floor.Index, out var floorLayers2);
            floorLayers2 ??= [];

            var layerNames = KnownLayerOrder
                .Concat(floorLayers2.Keys.Where(k => !KnownLayerOrder.Contains(k)))
                .Where(floorLayers2.ContainsKey);

            foreach (var layerName in layerNames)
            {
                var matrix = floorLayers2[layerName];
                sb.AppendLine($"  <tiles layer=\"{layerName}\">");
                for (int i = 0; i < matrix.Length; i++)
                    sb.AppendLine(FormatMatrixRow(matrix[i], i < matrix.Length - 1));
                sb.AppendLine("  </tiles>");
            }

            sb.AppendLine(" </floor>");
        }

        sb.AppendLine("</building>");
        return sb.ToString();
    }

    private static string Esc(string s) =>
        s.Replace("&", "&amp;")
         .Replace("\"", "&quot;")
         .Replace("<", "&lt;")
         .Replace(">", "&gt;");

    private static string FormatMatrixRow(int[] row, bool includeTrailingComma) =>
        includeTrailingComma ? string.Join(",", row) + "," : string.Join(",", row);
}




