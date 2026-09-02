namespace backend.Models;

/// <summary>Summary of a group – for the initial list (lightweight).</summary>
public class BfGroupSummary
{
    public int    Index      { get; set; }
    public string Label      { get; set; } = string.Empty;
    public int    PieceCount { get; set; }
    public int    EntryCount { get; set; }
    /// <summary>Number of this group's entries that already have a matching TileDefinition configured.</summary>
    public int    ConfiguredCount { get; set; }
}

/// <summary>Full group with all pieces – loaded on demand.</summary>
public class BfGroupDetail
{
    public string           Label  { get; set; } = string.Empty;
    public List<BfPieceDto> Pieces { get; set; } = [];
}

public class BfPieceDto
{
    public string?          Layer   { get; set; }
    public List<BfEntryDto> Entries { get; set; } = [];
}

public class BfEntryDto
{
    public string             Orient     { get; set; } = "N";
    public string             RootTileId { get; set; } = string.Empty;
    /// <summary>[row][col] → tileId (empty string = unoccupied)</summary>
    public List<List<string>> TileLayout { get; set; } = [[""]];
}

// ── Internal parsed representation ───────────────────────────────────────────

internal class BfGroup
{
    public string             Label   { get; set; } = string.Empty;
    public List<BfPiece>      Pieces  { get; set; } = [];
}

internal class BfPiece
{
    public string?         Layer   { get; set; }
    public List<BfEntry>   Entries { get; set; } = [];
}

internal class BfEntry
{
    public string                       Orient { get; set; } = "N";
    /// <summary>Key = "col,row", Value = tileId</summary>
    public Dictionary<string, string>   Cells  { get; set; } = [];

    public string RootTileId =>
        Cells.TryGetValue("0,0", out var id) ? id : Cells.Values.FirstOrDefault() ?? "";

    /// <summary>Converts col,row cell map to [row][col] tileLayout.</summary>
    public List<List<string>> ToTileLayout()
    {
        if (Cells.Count == 0) return [[""]];

        int maxCol = 0, maxRow = 0;
        foreach (var key in Cells.Keys)
        {
            var p = key.Split(',');
            if (int.TryParse(p[0], out int c)) maxCol = Math.Max(maxCol, c);
            if (int.TryParse(p[1], out int r)) maxRow = Math.Max(maxRow, r);
        }

        var layout = Enumerable.Range(0, maxRow + 1)
            .Select(_ => Enumerable.Repeat(string.Empty, maxCol + 1).ToList())
            .ToList();

        foreach (var (key, tileId) in Cells)
        {
            var p = key.Split(',');
            if (int.TryParse(p[0], out int c) && int.TryParse(p[1], out int r))
                layout[r][c] = tileId;
        }
        return layout;
    }
}
