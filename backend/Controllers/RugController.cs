using backend.Models;
using backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace backend.Controllers;

[ApiController]
[Route("api/rugs")]
public class RugController : ControllerBase
{
    private readonly IRugCatalogService _svc;

    public RugController(IRugCatalogService svc)
    {
        _svc = svc;
    }

    [HttpGet]
    public IActionResult GetAll() => Ok(_svc.GetAll());

    [HttpPut("{id}")]
    public IActionResult Upsert(string id, [FromBody] RugDefinition def)
    {
        def.Id = id;
        _svc.Upsert(def);
        return Ok(def);
    }

    [HttpDelete("{id}")]
    public IActionResult Delete(string id)
    {
        _svc.Delete(id);
        return NoContent();
    }
}
