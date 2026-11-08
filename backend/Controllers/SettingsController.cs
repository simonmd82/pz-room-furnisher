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

    /// <summary>Returns the list of known Picture/Poster themes.</summary>
    [HttpGet("themes")]
    public IActionResult GetThemes() => Ok(_svc.GetKnownThemes());

    /// <summary>Replaces the list of known themes.</summary>
    [HttpPut("themes")]
    public IActionResult SetThemes([FromBody] List<string>? themes)
    {
        if (themes is null) return BadRequest("Body must be a JSON array of strings.");
        _svc.SetKnownThemes(themes.Where(t => !string.IsNullOrWhiteSpace(t)).Distinct().ToList());
        return Ok(_svc.GetKnownThemes());
    }

    /// <summary>Returns the categories whose tiles carry themes (e.g. Picture, Poster).</summary>
    [HttpGet("themed-categories")]
    public IActionResult GetThemedCategories() => Ok(_svc.GetThemedCategories());

    /// <summary>Replaces the list of themed categories (empty = theming off).</summary>
    [HttpPut("themed-categories")]
    public IActionResult SetThemedCategories([FromBody] List<string>? categories)
    {
        if (categories is null) return BadRequest("Body must be a JSON array of strings.");
        _svc.SetThemedCategories(categories.Where(c => !string.IsNullOrWhiteSpace(c)).Distinct(StringComparer.OrdinalIgnoreCase).ToList());
        return Ok(_svc.GetThemedCategories());
    }

    /// <summary>Returns colour → hue (degrees, null = neutral) used for colour harmony.</summary>
    [HttpGet("color-hues")]
    public IActionResult GetColorHues() => Ok(_svc.GetColorHues());

    /// <summary>Replaces the colour → hue map.</summary>
    [HttpPut("color-hues")]
    public IActionResult SetColorHues([FromBody] Dictionary<string, int?>? hues)
    {
        if (hues is null) return BadRequest("Body must be a JSON object of colour → hue (number or null).");
        _svc.SetColorHues(hues);
        return Ok(_svc.GetColorHues());
    }
}
