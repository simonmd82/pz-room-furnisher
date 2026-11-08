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
    private readonly ITileUsageService   _usage;

    public TileLibraryController(ITileLibraryService lib, ITileConfigService cfg, ITileUsageService usage)
    {
        _lib   = lib;
        _cfg   = cfg;
        _usage = usage;
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
    public IActionResult GetSheets([FromQuery] string setId = "vanilla")
    {
        if (!_lib.IsConfigured)
            return Ok(new { configured = false, sheets = Array.Empty<object>() });

        var defs = _cfg.GetAllForSet(setId);
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

    // ── Distinct groups from tile definitions ─────────────────────────────

    [HttpGet("groups")]
    public IActionResult GetGroups()
    {
        var groups = _cfg.GetAll().Values
            .Select(d => d.Group)
            .Where(g => !string.IsNullOrWhiteSpace(g))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(g => g, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return Ok(groups);
    }

    // ── Distinct colors from tile definitions ─────────────────────────────

    [HttpGet("colors")]
    public IActionResult GetColors()
    {
        var colors = _cfg.GetAll().Values
            .SelectMany(d => d.Colors)
            .Where(c => !string.IsNullOrWhiteSpace(c))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(c => c, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return Ok(colors);
    }

    // ── Tile definitions ─────────────────────────────────────────────────

    /// <summary>
    /// No setId: merged view across every known set (for rendering/lookup, e.g. the building grid).
    /// With setId: raw definitions of exactly that set (for editing it in the Tile Browser).
    /// </summary>
    [HttpGet("config")]
    public IActionResult GetConfig([FromQuery] string? setId = null) =>
        Ok(setId is null ? _cfg.GetAll() : _cfg.GetAllForSet(setId));

    [HttpPut("config/{id}")]
    public IActionResult Upsert(string id, [FromBody] TileDefinition def, [FromQuery] string setId = "vanilla")
    {
        def.Id = id;
        try { _cfg.Upsert(def, setId); }
        catch (ArgumentException ex) { return BadRequest(ex.Message); }
        return Ok(def);
    }

    [HttpDelete("config/{id}")]
    public IActionResult Delete(string id, [FromQuery] string setId = "vanilla")
    {
        _cfg.Delete(id, setId);
        return NoContent();
    }

    /// <summary>Every tile definition of every set, with the room-type slots that can pick it.</summary>
    [HttpGet("usage")]
    public IActionResult GetUsage() => Ok(_usage.GetUsage());

    [HttpGet("config/export")]
    public IActionResult Export([FromQuery] string setId = "vanilla")
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(_cfg.ExportJson(setId));
        return File(bytes, "application/json", $"{setId}-tile-definitions.json");
    }

    [HttpPost("config/import")]
    public async Task<IActionResult> Import(IFormFile file, [FromQuery] string setId = "vanilla")
    {
        using var sr = new System.IO.StreamReader(file.OpenReadStream());
        try { _cfg.ImportJson(await sr.ReadToEndAsync(), setId); }
        catch (ArgumentException ex) { return BadRequest(ex.Message); }
        return Ok(new { imported = true });
    }

    // ── Config sets ──────────────────────────────────────────────────────

    [HttpGet("config-sets")]
    public IActionResult GetConfigSets() => Ok(_cfg.GetSets());

    [HttpPost("config-sets")]
    public IActionResult CreateConfigSet([FromBody] CreateConfigSetRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Name))
            return BadRequest("Name must not be empty.");
        return Ok(_cfg.CreateSet(req.Name, req.Description ?? string.Empty));
    }

    [HttpPut("config-sets/{id}")]
    public IActionResult UpdateConfigSet(string id, [FromBody] UpdateConfigSetRequest req)
    {
        try { return Ok(_cfg.SetSetMeta(id, req.Name, req.Description, req.Enabled)); }
        catch (ArgumentException ex) { return NotFound(ex.Message); }
    }

    [HttpDelete("config-sets/{id}")]
    public IActionResult DeleteConfigSet(string id)
    {
        try { _cfg.DeleteSet(id); }
        catch (InvalidOperationException ex) { return BadRequest(ex.Message); }
        return NoContent();
    }
}

public record SetPathRequest(string Path);
public record CreateConfigSetRequest(string Name, string? Description);
public record UpdateConfigSetRequest(string? Name, string? Description, bool? Enabled);


