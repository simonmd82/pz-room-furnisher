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
    private readonly IRoomTypeConfigService _roomTypeCfg;

    public BuildingController(ITbxParserService parser, IPathfinderService pathfinder, IRoomTypeConfigService roomTypeCfg)
    {
        _parser = parser;
        _pathfinder = pathfinder;
        _roomTypeCfg = roomTypeCfg;
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
            // Auto-compute paths for every floor using room-specific PathStyle.
            for (int fi = 0; fi < building.Floors.Count; fi++)
            {
                foreach (var ri in GetRoomIndicesOnFloor(building, fi))
                {
                    var style = ResolvePathStyle(building, ri);
                    _pathfinder.ComputeRoomPath(building, fi, ri, null, style);
                }
            }
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
            foreach (var ri in GetRoomIndicesOnFloor(req.Building, req.FloorIndex))
            {
                var style = ResolvePathStyle(req.Building, ri);
                _pathfinder.ComputeRoomPath(req.Building, req.FloorIndex, ri, req.Seed, style);
            }
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
            var style = ResolvePathStyle(req.Building, req.RoomIndex1Based);
            var cells = _pathfinder.ComputeRoomPath(req.Building, req.FloorIndex, req.RoomIndex1Based, req.Seed, style);
            return Ok(cells);
        }
        catch (Exception ex) { return BadRequest(ex.Message); }
    }

    private static IEnumerable<int> GetRoomIndicesOnFloor(Building building, int floorIndex)
    {
        if (floorIndex < 0 || floorIndex >= building.Floors.Count)
            return Enumerable.Empty<int>();

        return building.Floors[floorIndex]
            .RoomGrid
            .SelectMany(row => row)
            .Where(ri => ri > 0)
            .Distinct();
    }

    private string ResolvePathStyle(Building building, int roomIndex1Based)
    {
        if (roomIndex1Based < 1 || roomIndex1Based > building.Rooms.Count)
            return "wall";

        var room = building.Rooms[roomIndex1Based - 1];
        var all = _roomTypeCfg.GetAll();

        var key = all.Keys.FirstOrDefault(k => k.Equals(room.InternalName, StringComparison.OrdinalIgnoreCase))
               ?? all.Keys.FirstOrDefault(k => k.Equals(room.Name, StringComparison.OrdinalIgnoreCase));

        if (key is null)
            return "wall";

        var style = all[key].PathStyle;
        return string.IsNullOrWhiteSpace(style) ? "wall" : style;
    }
}
