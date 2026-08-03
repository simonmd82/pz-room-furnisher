using System.Text;
using backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class FurnishController : ControllerBase
{
    private readonly IFurnishingGeneratorService _generator;
    private readonly ITbxExportService           _exporter;

    public FurnishController(IFurnishingGeneratorService generator, ITbxExportService exporter)
    {
        _generator = generator;
        _exporter  = exporter;
    }

    /// <summary>
    /// Generate furniture placements for the selected rooms.
    /// Returns { placements: [...], log: [...] }.
    /// </summary>
    [HttpPost("generate")]
    public IActionResult Generate([FromBody] FurnishRequest request)
    {
        try { return Ok(_generator.Generate(request)); }
        catch (Exception ex) { return StatusCode(500, $"Generation failed: {ex.Message}\n{ex.StackTrace}"); }
    }

    public record ExportRequest(
        backend.Models.Building           Building,
        List<PlacedFurnitureItem>         Placements,
        string                            OriginalFileName = "building");

    /// <summary>
    /// Rebuild the TBX with placed furniture injected and return it as a download.
    /// The file is named &lt;original&gt;_furnished.tbx.
    /// </summary>
    [HttpPost("export-tbx")]
    public IActionResult ExportTbx([FromBody] ExportRequest req)
    {
        try
        {
            var tbx      = _exporter.Export(req.Building, req.Placements);
            var baseName = Path.GetFileNameWithoutExtension(req.OriginalFileName);
            var fileName = $"{baseName}_furnished.tbx";
            return File(Encoding.UTF8.GetBytes(tbx), "application/xml", fileName);
        }
        catch (Exception ex) { return StatusCode(500, ex.Message); }
    }
}

