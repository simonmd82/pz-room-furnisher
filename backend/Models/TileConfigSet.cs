namespace backend.Models;

/// <summary>
/// Metadata entry for one furniture tile-definition set (vanilla or a mod pack).
/// Persisted in Data/tile-config-sets.json. <see cref="File"/> is relative to the Data/ folder.
/// </summary>
public class TileConfigSetInfo
{
    public string Id          { get; set; } = string.Empty;
    public string Name        { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public bool Enabled       { get; set; } = true;
    public string File        { get; set; } = string.Empty;
}
