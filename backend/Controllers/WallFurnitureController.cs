using backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace backend.Controllers;

[ApiController]
[Route("api/wallfurniture")]
public class WallFurnitureController : ControllerBase
{
    private readonly IWallFurnitureClassificationService _svc;
    public WallFurnitureController(IWallFurnitureClassificationService svc) => _svc = svc;

    /// <summary>Returns the full tile-name → classification map.</summary>
    [HttpGet("classifications")]
    public IActionResult GetClassifications() => Ok(_svc.GetAll());

    /// <summary>Upserts a single tile's classification.</summary>
    [HttpPost("classifications")]
    public IActionResult SetClassification([FromBody] SetWallFurnitureClassificationRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.TileName))
            return BadRequest("Tile name must not be empty.");
        if (string.IsNullOrWhiteSpace(req.Classification))
            return BadRequest("Classification must not be empty.");

        _svc.Set(req.TileName, req.Classification);
        return Ok(_svc.GetAll());
    }
}

public record SetWallFurnitureClassificationRequest(string TileName, string Classification);
