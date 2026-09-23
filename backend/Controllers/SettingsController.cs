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

    /// <summary>Returns the list of known materials.</summary>
    [HttpGet("materials")]
    public IActionResult GetMaterials() => Ok(_svc.GetKnownMaterials());

    /// <summary>Replaces the list of known materials.</summary>
    [HttpPut("materials")]
    public IActionResult SetMaterials([FromBody] List<string>? materials)
    {
        if (materials is null) return BadRequest("Body must be a JSON array of strings.");
        _svc.SetKnownMaterials(materials.Where(m => !string.IsNullOrWhiteSpace(m)).Distinct().ToList());
        return Ok(_svc.GetKnownMaterials());
    }

    /// <summary>Returns the list of known colors.</summary>
    [HttpGet("colors")]
    public IActionResult GetColors() => Ok(_svc.GetKnownColors());

    /// <summary>Replaces the list of known colors.</summary>
    [HttpPut("colors")]
    public IActionResult SetColors([FromBody] List<string>? colors)
    {
        if (colors is null) return BadRequest("Body must be a JSON array of strings.");
        _svc.SetKnownColors(colors.Where(c => !string.IsNullOrWhiteSpace(c)).Distinct().ToList());
        return Ok(_svc.GetKnownColors());
    }
}
