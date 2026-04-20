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

    [HttpGet("slot-sizes")]
    public IActionResult GetSlotSizes() => Ok(_svc.GetSlotSizes());

    [HttpPut("slot-sizes")]
    public IActionResult SaveSlotSizes([FromBody] SlotSizeConfig sizes)
    {
        _svc.SaveSlotSizes(sizes);
        return Ok(sizes);
    }
}

