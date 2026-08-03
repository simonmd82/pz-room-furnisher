using backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace backend.Controllers;

[ApiController]
[Route("api/bfurniture")]
public class BuildingFurnitureController : ControllerBase
{
    private readonly IBuildingFurnitureService _bf;

    public BuildingFurnitureController(IBuildingFurnitureService bf) => _bf = bf;

    // ── Path ─────────────────────────────────────────────────────────────────

    [HttpGet("path")]
    public IActionResult GetPath() =>
        Ok(new { path = _bf.FilePath, isValid = _bf.IsConfigured });

    [HttpPost("path")]
    public IActionResult SetPath([FromBody] SetBfPathRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Path))
            return BadRequest("Path must not be empty.");

        var norm = req.Path.Replace('/', Path.DirectorySeparatorChar)
                           .Replace('\\', Path.DirectorySeparatorChar);

        if (!System.IO.File.Exists(norm))
            return BadRequest($"File not found: {norm}");

        _bf.SetFilePath(norm);
        return Ok(new { path = norm, isValid = true });
    }

    // ── Groups ────────────────────────────────────────────────────────────────

    [HttpGet("groups")]
    public IActionResult GetGroups()
    {
        if (!_bf.IsConfigured)
            return Ok(new { configured = false, groups = Array.Empty<object>() });

        return Ok(new { configured = true, groups = _bf.GetGroupSummaries() });
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

