using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using backend.Models;

namespace backend.Services;

public interface IBuildingFurnitureService
{
    bool   IsConfigured { get; }
    string FilePath     { get; }
    void   SetFilePath(string path);
    List<BfGroupSummary>  GetGroupSummaries(IReadOnlyDictionary<string, TileDefinition> configuredTiles);
    BfGroupDetail?        GetGroupDetail(int index);
}

public class BuildingFurnitureService : IBuildingFurnitureService
{
    private readonly string _settingsKey = "bfFilePath";
    private readonly string _settingsFile;
    private string _filePath = string.Empty;
    private List<BfGroup>? _cache;

    public BuildingFurnitureService(IWebHostEnvironment env)
    {
        // Machine-local path, kept separate from settings.json (which ships with the app).
        _settingsFile = Path.Combine(env.ContentRootPath, "Data", "local-settings.json");
        Load();
    }

    public bool   IsConfigured => File.Exists(_filePath);
    public string FilePath     => _filePath;

    public void SetFilePath(string path)
    {
        _filePath = path;
        _cache    = null;
        Save();
    }

    public List<BfGroupSummary> GetGroupSummaries(IReadOnlyDictionary<string, TileDefinition> configuredTiles)
    {
        var groups = EnsureParsed();
        return groups.Select((g, i) => new BfGroupSummary
        {
            Index      = i,
            Label      = g.Label,
            PieceCount = g.Pieces.Count,
            EntryCount = g.Pieces.Sum(p => p.Entries.Count),
            ConfiguredCount = g.Pieces.Sum(p => p.Entries.Count(e => IsEntryConfigured(e, configuredTiles))),
        }).ToList();
    }

    private static bool IsEntryConfigured(BfEntry entry, IReadOnlyDictionary<string, TileDefinition> configuredTiles)
    {
        var layout = entry.ToTileLayout();
        int cols = layout.Count > 0 ? (layout[0]?.Count ?? 1) : 1;
        int rows = layout.Count;
        var id = TileDefinition.ComputeId(entry.RootTileId, cols, rows);
        return configuredTiles.ContainsKey(id);
    }

    public BfGroupDetail? GetGroupDetail(int index)
    {
        var groups = EnsureParsed();
        if (index < 0 || index >= groups.Count) return null;

        var g = groups[index];
        return new BfGroupDetail
        {
            Label  = g.Label,
            Pieces = g.Pieces.Select(p => new BfPieceDto
            {
                Layer   = p.Layer,
                Entries = p.Entries.Select(e => new BfEntryDto
                {
                    Orient     = e.Orient,
                    RootTileId = e.RootTileId,
                    TileLayout = e.ToTileLayout(),
                }).ToList(),
            }).ToList(),
        };
    }

    // ── Parser ────────────────────────────────────────────────────────────────

    private List<BfGroup> EnsureParsed()
    {
        if (_cache is not null) return _cache;
        if (!IsConfigured)     return _cache = [];

        _cache = ParseFile(_filePath);
        return _cache;
    }

    private static readonly Regex _cellPattern = new(@"^(\d+),(\d+)\s*=\s*(.+)$", RegexOptions.Compiled);

    private static List<BfGroup> ParseFile(string path)
    {
        var lines  = File.ReadAllLines(path);
        var groups = new List<BfGroup>();
        int i      = 0;

        while (i < lines.Length)
        {
            var line = lines[i].Trim();
            if (line == "group")
            {
                i++;
                if (i < lines.Length && lines[i].Trim() == "{")
                {
                    i++;
                    groups.Add(ParseGroup(lines, ref i));
                }
            }
            else i++;
        }
        return groups;
    }

    private static BfGroup ParseGroup(string[] lines, ref int i)
    {
        var group = new BfGroup();
        while (i < lines.Length && lines[i].Trim() != "}")
        {
            var line = lines[i].Trim();
            if (line.StartsWith("label"))
            {
                group.Label = Value(line);
                i++;
            }
            else if (line == "furniture")
            {
                i++;
                if (i < lines.Length && lines[i].Trim() == "{")
                {
                    i++;
                    group.Pieces.Add(ParsePiece(lines, ref i));
                }
            }
            else i++;
        }
        if (i < lines.Length) i++; // consume }
        return group;
    }

    private static BfPiece ParsePiece(string[] lines, ref int i)
    {
        var piece = new BfPiece();
        while (i < lines.Length && lines[i].Trim() != "}")
        {
            var line = lines[i].Trim();
            if (line.StartsWith("layer"))
            {
                piece.Layer = Value(line);
                i++;
            }
            else if (line == "entry")
            {
                i++;
                if (i < lines.Length && lines[i].Trim() == "{")
                {
                    i++;
                    piece.Entries.Add(ParseEntry(lines, ref i));
                }
            }
            else i++;
        }
        if (i < lines.Length) i++; // consume }
        return piece;
    }

    private static BfEntry ParseEntry(string[] lines, ref int i)
    {
        var entry = new BfEntry();
        while (i < lines.Length && lines[i].Trim() != "}")
        {
            var line = lines[i].Trim();
            if (line.StartsWith("orient"))
            {
                entry.Orient = Value(line);
                i++;
            }
            else
            {
                var m = _cellPattern.Match(line);
                if (m.Success)
                {
                    var key   = $"{m.Groups[1].Value},{m.Groups[2].Value}"; // "col,row"
                    var tileId = m.Groups[3].Value.Trim();
                    entry.Cells[key] = tileId;
                }
                i++;
            }
        }
        if (i < lines.Length) i++; // consume }
        return entry;
    }

    private static string Value(string line)
    {
        var idx = line.IndexOf('=');
        return idx >= 0 ? line[(idx + 1)..].Trim() : string.Empty;
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    private void Load()
    {
        try
        {
            if (!File.Exists(_settingsFile)) return;
            using var doc = JsonDocument.Parse(File.ReadAllText(_settingsFile));
            if (doc.RootElement.TryGetProperty(_settingsKey, out var el))
                _filePath = el.GetString() ?? string.Empty;
        }
        catch { /* ignore */ }
    }

    private void Save()
    {
        try
        {
            JsonNode root = new JsonObject();
            if (File.Exists(_settingsFile))
            {
                try { root = JsonNode.Parse(File.ReadAllText(_settingsFile)) ?? new JsonObject(); }
                catch { root = new JsonObject(); }
            }
            root[_settingsKey] = _filePath;

            Directory.CreateDirectory(Path.GetDirectoryName(_settingsFile)!);
            File.WriteAllText(_settingsFile,
                root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { /* ignore */ }
    }
}
