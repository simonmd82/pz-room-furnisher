using backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class BuildingController : ControllerBase
{
    private readonly ITbxParserService _parser;

    public BuildingController(ITbxParserService parser)
    {
        _parser = parser;
    }

    /// <summary>
    /// Upload a .tbx file and receive the parsed building structure as JSON.
    /// </summary>
    [HttpPost("upload")]
    [RequestSizeLimit(10 * 1024 * 1024)] // 10 MB max
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
            return Ok(building);
        }
        catch (Exception ex)
        {
            return BadRequest($"Failed to parse TBX file: {ex.Message}");
        }
    }
}

