using backend.Models;
using backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace backend.Controllers;

[ApiController]
[Route("api/roomtypes")]
public class RoomTypeController : ControllerBase
{
    private readonly IRoomTypeConfigService _svc;
    public RoomTypeController(IRoomTypeConfigService svc) => _svc = svc;

    [HttpGet]
    public IActionResult GetAll() => Ok(_svc.GetAll());

    [HttpPut("{roomType}")]
    public IActionResult Upsert(string roomType, [FromBody] RoomTypeConfig cfg)
    {
        cfg.RoomType = roomType;
        _svc.Upsert(cfg);
        return Ok(cfg);
    }

    [HttpDelete("{roomType}")]
    public IActionResult Delete(string roomType)
    {
        _svc.Delete(roomType);
        return NoContent();
    }

    [HttpGet("default-status")]
    public IActionResult GetDefaultStatus() => Ok(new
    {
        hasDefault  = _svc.HasDefault(),
        hasSnapshot = _svc.HasSnapshot(),
    });

    [HttpPost("restore-default")]
    public IActionResult RestoreDefault()
    {
        try { _svc.RestoreDefault(); return Ok(); }
        catch (FileNotFoundException ex) { return NotFound(ex.Message); }
    }

    [HttpPost("save-snapshot")]
    public IActionResult SaveSnapshot()
    {
        _svc.SaveSnapshot();
        return Ok();
    }

    [HttpPost("restore-snapshot")]
    public IActionResult RestoreSnapshot()
    {
        try { _svc.RestoreSnapshot(); return Ok(); }
        catch (FileNotFoundException ex) { return NotFound(ex.Message); }
    }
}
