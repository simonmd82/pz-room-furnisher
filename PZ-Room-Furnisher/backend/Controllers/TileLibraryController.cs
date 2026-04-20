using backend.Models;
using backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace backend.Controllers;

[ApiController]
[Route("api/tiles")]
public class TileLibraryController : ControllerBase
{
    private readonly ITileLibraryService _lib;
    private readonly ITileConfigService  _cfg;

    public TileLibraryController(ITileLibraryService lib, ITileConfigService cfg)
    {
        _lib = lib;
        _cfg = cfg;
    }

    // ── Path ─────────────────────────────────────────────────────────────

    [HttpGet("path")]
    public IActionResult GetPath() =>
        Ok(new { path = _lib.TilesPath, isValid = _lib.IsConfigured });

    [HttpPost("path")]
    public IActionResult SetPath([FromBody] SetPathRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Path))
            return BadRequest("Path must not be empty.");

        // Normalize: accept both / and \ regardless of OS
        var normalized = req.Path.Replace('/', Path.DirectorySeparatorChar)
                                 .Replace('\\', Path.DirectorySeparatorChar)
                                 .TrimEnd(Path.DirectorySeparatorChar);

        if (!Directory.Exists(normalized))
            return BadRequest($"Directory not found: {normalized}");

        _lib.SetTilesPath(normalized);
        return Ok(new { path = normalized, isValid = true });
    }

    // ── Directory browser ─────────────────────────────────────────────────

    [HttpGet("browse")]
    public IActionResult Browse([FromQuery] string? path)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                // Return logical drives
                var drives = DriveInfo.GetDrives()
                    .Where(d => d.IsReady)
                    .Select(d => new
                    {
                        name     = d.Name.TrimEnd('\\', '/'),   // display: "C:"
                        fullPath = d.RootDirectory.FullName,     // browse:  "C:\"
                        isDrive  = true,
                    })
                    .OrderBy(d => d.name);
                return Ok(new { current = (string?)null, parent = (string?)null, entries = drives });
            }

            // Normalize slashes
            var norm = path.Replace('/', Path.DirectorySeparatorChar)
                           .Replace('\\', Path.DirectorySeparatorChar);

            // "C:" → "C:\" so Directory.GetDirectories works
            if (norm.Length == 2 && norm[1] == ':')
                norm += Path.DirectorySeparatorChar;

            if (!Directory.Exists(norm))
                return BadRequest($"Directory not found: {norm}");

            var dirs = Directory.GetDirectories(norm)
                .Select(d => new
                {
                    name     = Path.GetFileName(d),
                    fullPath = d,
                    isDrive  = false,
                })
                .OrderBy(d => d.name, StringComparer.OrdinalIgnoreCase)
                .ToArray();

            // Parent: if at drive root (e.g. "C:\"), go back to drive list
            var parent = Path.GetDirectoryName(norm);
            if (string.IsNullOrEmpty(parent) || parent == norm) parent = null;

            return Ok(new { current = norm, parent, entries = dirs });
        }
        catch (UnauthorizedAccessException)
        {
            var parent = Path.GetDirectoryName(path);
            return Ok(new { current = path, parent, entries = Array.Empty<object>() });
        }
    }

    // ── Sheets ────────────────────────────────────────────────────────────

    [HttpGet("sheets")]
    public IActionResult GetSheets()
    {
        if (!_lib.IsConfigured)
            return Ok(new { configured = false, sheets = Array.Empty<object>() });

        var defs = _cfg.GetAll();
        var sheets = _lib.GetSheets().Select(s =>
        {
            int defined = defs.Keys.Count(k => k.StartsWith(s.Name + "_"));
            return new
            {
                s.Name, s.SpriteWidth, s.SpriteHeight,
                s.SheetWidth, s.SheetHeight, s.Columns, s.Rows, s.SpriteCount,
                DefinedCount = defined,
            };
        });
        return Ok(new { configured = true, sheets });
    }

    [HttpGet("sheet/{name}/image")]
    public IActionResult GetSheetImage(string name)
    {
        var path = _lib.GetSheetPath(name);
        if (path is null) return NotFound();
        return PhysicalFile(path, "image/png");
    }

    // ── Tile definitions ─────────────────────────────────────────────────

    [HttpGet("config")]
    public IActionResult GetConfig() => Ok(_cfg.GetAll());

    [HttpPut("config/{tileId}")]
    public IActionResult Upsert(string tileId, [FromBody] TileDefinition def)
    {
        def.TileId = tileId;
        _cfg.Upsert(def);
        return Ok(def);
    }

    [HttpDelete("config/{tileId}")]
    public IActionResult Delete(string tileId)
    {
        _cfg.Delete(tileId);
        return NoContent();
    }

    [HttpGet("config/export")]
    public IActionResult Export()
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(_cfg.ExportJson());
        return File(bytes, "application/json", "tile-definitions.json");
    }

    [HttpPost("config/import")]
    public async Task<IActionResult> Import(IFormFile file)
    {
        using var sr = new System.IO.StreamReader(file.OpenReadStream());
        _cfg.ImportJson(await sr.ReadToEndAsync());
        return Ok(new { imported = true });
    }
}

public record SetPathRequest(string Path);



