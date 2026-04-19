namespace backend.Models;

/// <summary>
/// Represents a door or window on the shared edge between two adjacent grid cells.
/// Stored bidirectionally so furniture logic can query from either cell side.
/// </summary>
public class WallEdge
{
    /// <summary>
    /// Normalised unique key for this edge.
    /// Format: "H:col,row" → horizontal edge (north wall of row <c>row</c>)
    ///         "V:col,row" → vertical edge   (west wall of col <c>col</c>)
    /// </summary>
    public string EdgeKey { get; set; } = string.Empty;

    public FloorObjectType Type { get; set; }

    /// <summary>
    /// True  = horizontal edge, i.e. sits between row (EdgeRow-1) and row EdgeRow.
    /// False = vertical edge,   i.e. sits between col (EdgeCol-1) and col EdgeCol.
    /// </summary>
    public bool IsHorizontal { get; set; }

    /// <summary>Column index used to locate the edge on the grid.</summary>
    public int EdgeCol { get; set; }

    /// <summary>Row index used to locate the edge on the grid.</summary>
    public int EdgeRow { get; set; }

    // ── Both cells that share this edge ──────────────────────────────────────

    /// <summary>Column of the first cell (north or west neighbour).</summary>
    public int Cell1Col { get; set; }
    /// <summary>Row of the first cell (north or west neighbour).</summary>
    public int Cell1Row { get; set; }

    /// <summary>Column of the second cell (south or east neighbour).</summary>
    public int Cell2Col { get; set; }
    /// <summary>Row of the second cell (south or east neighbour).</summary>
    public int Cell2Row { get; set; }
}

