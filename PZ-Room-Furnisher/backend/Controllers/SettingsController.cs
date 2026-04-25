using backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace backend.Controllers;

[ApiController]
[Route("api/settings")]
public class SettingsController : ControllerBase
{
    private readonly ISettingsService _svc;
    public SettingsController(ISettingsService svc) => _svc = svc;

    /// <summary>Returns the list of known room-type names.</summary>
    [HttpGet("room-type-names")]
    public IActionResult GetRoomTypeNames() => Ok(_svc.GetKnownRoomTypes());

    /// <summary>Replaces the list of known room-type names.</summary>
    [HttpPut("room-type-names")]
    public IActionResult SetRoomTypeNames([FromBody] List<string>? names)
    {
        if (names is null) return BadRequest("Body must be a JSON array of strings.");
        _svc.SetKnownRoomTypes(names.Where(n => !string.IsNullOrWhiteSpace(n)).Distinct().ToList());
        return Ok(_svc.GetKnownRoomTypes());
    }

    /// <summary>Returns the list of known categories.</summary>
    [HttpGet("categories")]
    public IActionResult GetCategories() => Ok(_svc.GetKnownCategories());

    /// <summary>Replaces the list of known categories.</summary>
    [HttpPut("categories")]
    public IActionResult SetCategories([FromBody] List<string>? categories)
    {
        if (categories is null) return BadRequest("Body must be a JSON array of strings.");
        _svc.SetKnownCategories(categories.Where(c => !string.IsNullOrWhiteSpace(c)).Distinct().ToList());
        return Ok(_svc.GetKnownCategories());
    }
}
