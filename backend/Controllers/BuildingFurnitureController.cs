using backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace backend.Controllers;

[ApiController]
[Route("api/bfurniture")]
public class BuildingFurnitureController : ControllerBase
{
    private const string BfFileName = "BuildingFurniture.txt";

    private readonly IBuildingFurnitureService _bf;
    private readonly ITileConfigService _cfg;

    public BuildingFurnitureController(IBuildingFurnitureService bf, ITileConfigService cfg)
    {
        _bf  = bf;
        _cfg = cfg;
    }

    // ── Path ─────────────────────────────────────────────────────────────────

    [HttpGet("path")]
    public IActionResult GetPath() =>
        Ok(new { path = Path.GetDirectoryName(_bf.FilePath) ?? "", isValid = _bf.IsConfigured });

    [HttpPost("path")]
    public IActionResult SetPath([FromBody] SetBfPathRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Path))
            return BadRequest("Path must not be empty.");

        var norm = req.Path.Replace('/', Path.DirectorySeparatorChar)
                           .Replace('\\', Path.DirectorySeparatorChar);

        // The setting is the folder; a pasted path to the file itself is accepted too.
        var folder = Path.GetFileName(norm).Equals(BfFileName, StringComparison.OrdinalIgnoreCase) && !Directory.Exists(norm)
            ? Path.GetDirectoryName(norm) ?? norm
            : norm;
        var file = Path.Combine(folder, BfFileName);

        if (!System.IO.File.Exists(file))
            return BadRequest($"{BfFileName} not found in: {folder}");

        _bf.SetFilePath(file);
        return Ok(new { path = folder, isValid = true });
    }

    // ── Groups ────────────────────────────────────────────────────────────────

    [HttpGet("groups")]
    public IActionResult GetGroups([FromQuery] string setId = "vanilla")
    {
        if (!_bf.IsConfigured)
            return Ok(new { configured = false, groups = Array.Empty<object>() });

        var defs = _cfg.GetAllForSet(setId);
        return Ok(new { configured = true, groups = _bf.GetGroupSummaries(defs) });
    }

    [HttpGet("groups/{index:int}")]
    public IActionResult GetGroupDetail(int index)
    {
        if (!_bf.IsConfigured) return NotFound();
        var detail = _bf.GetGroupDetail(index);
        return detail is null ? NotFound() : Ok(detail);
    }
}

public record SetBfPathRequest(string Path);

