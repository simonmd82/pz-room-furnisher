using backend.Models;
using backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class BuildingController : ControllerBase
{
    private readonly ITbxParserService _parser;
    private readonly IPathfinderService _pathfinder;

    public BuildingController(ITbxParserService parser, IPathfinderService pathfinder)
    {
        _parser = parser;
        _pathfinder = pathfinder;
    }

    /// <summary>
    /// Upload a .tbx file and receive the parsed building structure as JSON.
    /// Paths are automatically computed for all rooms on floor 0.
    /// </summary>
    [HttpPost("upload")]
    [RequestSizeLimit(10 * 1024 * 1024)]
    public IActionResult Upload(IFormFile file)
    {
        if (file == null || file.Length == 0)
            return BadRequest("No file provided.");

        if (!file.FileName.EndsWith(".tbx", StringComparison.OrdinalIgnoreCase))
            return BadRequest("Only .tbx files are supported.");

        try
        {
            using var stream = file.OpenReadStream();
            var building = _parser.Parse(stream);
            // Auto-compute paths for every floor
            for (int fi = 0; fi < building.Floors.Count; fi++)
                _pathfinder.ComputePaths(building, fi);
            return Ok(building);
        }
        catch (Exception ex)
        {
            return StatusCode(400, $"Failed to parse TBX file: {ex.Message}\n{ex.StackTrace}");
        }
    }

    public record RecomputePathsRequest(Building Building, int FloorIndex, int? Seed);
    public record RecomputeRoomPathRequest(Building Building, int FloorIndex, int RoomIndex1Based, int? Seed);

    /// <summary>Recompute paths for all rooms on a given floor.</summary>
    [HttpPost("recompute-paths")]
    public IActionResult RecomputePaths([FromBody] RecomputePathsRequest req)
    {
        try
        {
            _pathfinder.ComputePaths(req.Building, req.FloorIndex, req.Seed);
            return Ok(req.Building.Rooms);
        }
        catch (Exception ex) { return BadRequest(ex.Message); }
    }

    /// <summary>Recompute path for a single room (used by "regenerate" button).</summary>
    [HttpPost("recompute-room-path")]
    public IActionResult RecomputeRoomPath([FromBody] RecomputeRoomPathRequest req)
    {
        try
        {
            var cells = _pathfinder.ComputeRoomPath(req.Building, req.FloorIndex, req.RoomIndex1Based, req.Seed);
            return Ok(cells);
        }
        catch (Exception ex) { return BadRequest(ex.Message); }
    }
}
