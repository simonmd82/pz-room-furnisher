using System.Text;
using System.Xml;
using System.Xml.Linq;
using backend.Models;

namespace backend.Services;

public interface ITbxExportService
{
    /// <summary>
    /// Writes a TBX with the furniture placements added. When the original file text is
    /// available (TbxMetadata.SourceXml) that document is patched in place; otherwise the XML
    /// is reconstructed from the parsed model (lossy — kept only as a fallback).
    /// </summary>
    string Export(Building building, List<PlacedFurnitureItem> placements);
}

public class TbxExportService : ITbxExportService
{
    // Bekannte Layer in der gewünschten Exportreihenfolge
    private static readonly string[] KnownLayerOrder =
        ["FloorFurniture", "Furniture", "Furniture2", "WallFurniture"];

    // TileZed's per-floor tile layer names; used to normalise casing ("Wallfurniture" → "WallFurniture").
    private static readonly string[] TileZedLayers =
    [
        "Floor", "FloorOverlay", "FloorOverlay2", "FloorOverlay3", "FloorOverlay4",
        "Vegetation", "FloorFurniture", "Furniture", "Furniture2", "Furniture3", "Furniture4",
        "Walls", "WallTrim", "Walls2", "WallTrim2", "RoofCap", "RoofCap2",
        "WallOverlay", "WallOverlay2", "WallFurniture", "WallFurniture2", "WallFurniture3", "WallFurniture4",
        "Frames", "Doors", "Curtains", "Curtains2", "Curtains3", "Curtains4",
    ];

    // When a cell of a layer is already taken (painted in the original, or another placement),
    // the tile moves on to the next layer of the same family instead of overwriting it.
    private static readonly string[][] LayerFamilies =
    [
        ["Furniture", "Furniture2", "Furniture3", "Furniture4"],
        ["WallFurniture", "WallFurniture2", "WallFurniture3", "WallFurniture4"],
        ["WallOverlay", "WallOverlay2"],
        ["Curtains", "Curtains2", "Curtains3", "Curtains4"],
    ];

    public string Export(Building building, List<PlacedFurnitureItem> placements) =>
        string.IsNullOrEmpty(building.Tbx.SourceXml)
            ? ExportReconstructed(building, placements)
            : ExportPatched(building, placements);

    private static string CanonicalLayer(string layer)
    {
        if (string.IsNullOrEmpty(layer)) return "Furniture";
        return TileZedLayers.FirstOrDefault(l => l.Equals(layer, StringComparison.OrdinalIgnoreCase)) ?? layer;
    }

    private static IEnumerable<string> LayerCandidates(string layer)
    {
        var family = LayerFamilies.FirstOrDefault(f => f.Contains(layer));
        return family is null ? [layer] : family.SkipWhile(l => l != layer);
    }

    /// <summary>
    /// Patches the original document: appends new tile names to user_tiles (existing indices,
    /// which the painted layers refer to, stay valid) and merges the placements into each
    /// floor's tile layers, creating a layer only if the floor doesn't have it yet.
    /// </summary>
    private static string ExportPatched(Building building, List<PlacedFurnitureItem> placements)
    {
        var doc  = XDocument.Parse(building.Tbx.SourceXml, LoadOptions.PreserveWhitespace);
        var root = doc.Root!;
        int layerRows = building.Height + 1, layerCols = building.Width + 1;

        // ── user_tiles: keep the original list, append what's new ──
        var userTilesEl = root.Element("user_tiles");
        if (userTilesEl is null)
        {
            userTilesEl = new XElement("user_tiles");
            var anchor = root.Element("used_tiles") ?? root.Element("used_furniture");
            if (anchor is not null) anchor.AddBeforeSelf(userTilesEl, new XText("\n "));
            else root.Add(new XText(" "), userTilesEl, new XText("\n"));
        }
        var tileIndex = new Dictionary<string, int>(StringComparer.Ordinal);
        int nextIndex = 1;
        foreach (var t in userTilesEl.Elements("tile"))
            tileIndex.TryAdd(t.Attribute("tile")?.Value ?? string.Empty, nextIndex++);
        var newTiles = new List<string>();
        int IndexOf(string tileId)
        {
            if (!tileIndex.TryGetValue(tileId, out var idx))
            {
                tileIndex[tileId] = idx = nextIndex++;
                newTiles.Add(tileId);
            }
            return idx;
        }

        // ── per floor: merge placements into its layer matrices ──
        var floorEls = root.Elements("floor").ToList();
        foreach (var group in placements.GroupBy(p => p.FloorIndex))
        {
            if (group.Key < 0 || group.Key >= floorEls.Count) continue;
            var floorEl = floorEls[group.Key];

            var layers = new Dictionary<string, (XElement El, int[][] Grid)>(StringComparer.OrdinalIgnoreCase);
            foreach (var tilesEl in floorEl.Elements("tiles"))
            {
                var name = tilesEl.Attribute("layer")?.Value;
                if (!string.IsNullOrEmpty(name))
                    layers[name] = (tilesEl, ParseMatrix(tilesEl.Value, layerRows, layerCols));
            }
            var touched = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            (XElement El, int[][] Grid) LayerFor(string name)
            {
                if (layers.TryGetValue(name, out var l)) return l;
                var el = new XElement("tiles", new XAttribute("layer", name));
                var after = floorEl.Elements("tiles").LastOrDefault() ?? floorEl.Elements("attributes").LastOrDefault();
                if (after is not null) after.AddAfterSelf(new XText("\n  "), el);
                else floorEl.Add(new XText("  "), el, new XText("\n "));
                l = (el, Enumerable.Range(0, layerRows).Select(_ => new int[layerCols]).ToArray());
                layers[name] = l;
                return l;
            }

            foreach (var p in group)
            {
                if (p.Row < 0 || p.Row >= layerRows || p.Col < 0 || p.Col >= layerCols) continue;
                int idx = IndexOf(p.TileId);
                var candidates = LayerCandidates(CanonicalLayer(p.Layer)).ToList();

                // Same tile already there (e.g. re-exporting a furnished file) → nothing to do.
                if (candidates.Any(n => layers.TryGetValue(n, out var l) && l.Grid[p.Row][p.Col] == idx))
                    continue;

                var target = candidates.FirstOrDefault(n => !layers.TryGetValue(n, out var l) || l.Grid[p.Row][p.Col] == 0)
                             ?? candidates[^1]; // whole family occupied → last layer, overwriting
                LayerFor(target).Grid[p.Row][p.Col] = idx;
                touched.Add(target);
            }

            foreach (var name in touched)
            {
                var (el, grid) = layers[name];
                el.Value = "\n" + string.Join("\n", grid.Select((row, i) => FormatMatrixRow(row, i < grid.Length - 1))) + "\n";
            }
        }

        foreach (var t in newTiles)
        {
            var last = userTilesEl.Elements("tile").LastOrDefault();
            var el = new XElement("tile", new XAttribute("tile", t));
            if (last is not null) last.AddAfterSelf(new XText("\n  "), el);
            else userTilesEl.Add(new XText("\n  "), el, new XText("\n "));
        }

        var settings = new XmlWriterSettings { Encoding = new UTF8Encoding(false), Indent = false, NewLineHandling = NewLineHandling.None };
        using var ms = new MemoryStream();
        using (var writer = XmlWriter.Create(ms, settings))
            doc.Save(writer);

        // Match TileZed's own output style so untouched lines stay byte-identical to the original.
        return Encoding.UTF8.GetString(ms.ToArray())
            .Replace("<?xml version=\"1.0\" encoding=\"utf-8\"?>", "<?xml version=\"1.0\" encoding=\"UTF-8\"?>")
            .Replace("\" />", "\"/>");
    }

    private static int[][] ParseMatrix(string text, int rows, int cols)
    {
        var grid = Enumerable.Range(0, rows).Select(_ => new int[cols]).ToArray();
        var lines = text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        for (int r = 0; r < Math.Min(rows, lines.Length); r++)
        {
            var vals = lines[r].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            for (int c = 0; c < Math.Min(cols, vals.Length); c++)
                grid[r][c] = int.TryParse(vals[c], out var v) ? v : 0;
        }
        return grid;
    }

    /// <summary>Legacy path for buildings without SourceXml: rebuilds the XML from the parsed model.</summary>
    private string ExportReconstructed(Building building, List<PlacedFurnitureItem> placements)
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




