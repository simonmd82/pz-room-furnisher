using System.Text.Json;
using backend.Models;

namespace backend.Services;

public interface ITileLibraryService
{
    bool   IsConfigured { get; }
    string TilesPath    { get; }
    void   SetTilesPath(string path);
    IReadOnlyList<TileSheetInfo> GetSheets();
    string? GetSheetPath(string name);
}

public class TileLibraryService : ITileLibraryService
{
    private const int DefaultSpriteW = 128;
    private const int DefaultSpriteH = 256;

    private readonly string _settingsFile;
    private string _tilesPath = string.Empty;
    private List<TileSheetInfo>? _cache;

    public TileLibraryService(IWebHostEnvironment env)
    {
        _settingsFile = Path.Combine(env.ContentRootPath, "Data", "settings.json");
        Load();
    }

    public bool   IsConfigured => Directory.Exists(_tilesPath);
    public string TilesPath    => _tilesPath;

    public void SetTilesPath(string path)
    {
        _tilesPath = path;
        _cache     = null;
        Save();
    }

    public IReadOnlyList<TileSheetInfo> GetSheets()
    {
        if (_cache is not null) return _cache;
        if (!IsConfigured) return [];

        _cache = Directory
            .EnumerateFiles(_tilesPath, "*.png", SearchOption.TopDirectoryOnly)
            .OrderBy(f => f)
            .Select(BuildInfo)
            .OfType<TileSheetInfo>()
            .ToList();

        return _cache;
    }

    public string? GetSheetPath(string name)
    {
        if (!IsConfigured) return null;
        var p = Path.Combine(_tilesPath, name + ".png");
        return File.Exists(p) ? p : null;
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    private static TileSheetInfo? BuildInfo(string filePath)
    {
        try
        {
            var (w, h) = ReadPngSize(filePath);
            if (w <= 0 || h <= 0) return null;
            int cols = Math.Max(1, w / DefaultSpriteW);
            int rows = Math.Max(1, h / DefaultSpriteH);
            return new TileSheetInfo
            {
                Name         = Path.GetFileNameWithoutExtension(filePath),
                SpriteWidth  = DefaultSpriteW,
                SpriteHeight = DefaultSpriteH,
                SheetWidth   = w,
                SheetHeight  = h,
                Columns      = cols,
                Rows         = rows,
                SpriteCount  = cols * rows,
            };
        }
        catch { return null; }
    }

    /// Reads width/height from PNG IHDR without any external library.
    private static (int w, int h) ReadPngSize(string path)
    {
        Span<byte> buf = stackalloc byte[24];
        using var fs = File.OpenRead(path);
        if (fs.Read(buf) < 24) return (0, 0);
        ReadOnlySpan<byte> sig = [137, 80, 78, 71, 13, 10, 26, 10];
        if (!buf[..8].SequenceEqual(sig)) return (0, 0);
        int w = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
        int h = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
        return (w, h);
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_settingsFile)) return;
            using var doc = JsonDocument.Parse(File.ReadAllText(_settingsFile));
            if (doc.RootElement.TryGetProperty("tilesPath", out var el))
                _tilesPath = el.GetString() ?? string.Empty;
        }
        catch { /* ignore */ }
    }

    private void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_settingsFile)!);
        File.WriteAllText(_settingsFile,
            JsonSerializer.Serialize(new { tilesPath = _tilesPath },
                new JsonSerializerOptions { WriteIndented = true }));
    }
}

