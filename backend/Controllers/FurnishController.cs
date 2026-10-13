using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using backend.Models;
using backend.Services;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class FurnishController : ControllerBase
{
    private static readonly byte[] NdjsonNewline = "\n"u8.ToArray();

    private readonly IFurnishingGeneratorService _generator;
    private readonly ITbxExportService           _exporter;
    private readonly JsonSerializerOptions       _json;
    private readonly IRoomTypeConfigService      _roomTypes;
    private readonly ITileConfigService          _tiles;
    private readonly IRugCatalogService          _rugs;

    public FurnishController(IFurnishingGeneratorService generator, ITbxExportService exporter, IOptions<JsonOptions> jsonOptions,
                             IRoomTypeConfigService roomTypes, ITileConfigService tiles, IRugCatalogService rugs)
    {
        _generator = generator;
        _exporter  = exporter;
        _roomTypes = roomTypes;
        _tiles     = tiles;
        _rugs      = rugs;
        _json      = jsonOptions.Value.JsonSerializerOptions; // same casing/enum handling as normal responses
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

    /// <summary>
    /// Same as <see cref="Generate"/>, but streams progress as NDJSON (one JSON event per line):
    /// <c>start {total}</c>, per room <c>room {…}</c> then <c>roomDone {…, placements, reservedZones, log}</c>,
    /// and finally <c>done</c> or <c>error {message}</c>. Aborting the request stops generation
    /// after the room currently in progress; rooms already streamed stay valid.
    /// </summary>
    [HttpPost("generate-stream")]
    public async Task GenerateStream([FromBody] FurnishRequest request)
    {
        var ct = HttpContext.RequestAborted;
        Response.ContentType = "application/x-ndjson";
        HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

        // Generator runs synchronously on a worker thread; events cross over via the channel.
        var events = Channel.CreateUnbounded<object>(new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });
        events.Writer.TryWrite(new { type = "start", total = request.RoomSelections.Count });

        var work = Task.Run(() =>
        {
            try
            {
                _generator.Generate(request, new ChannelProgress(events.Writer), ct);
                events.Writer.TryWrite(new { type = "done" });
            }
            catch (OperationCanceledException) { /* client aborted */ }
            catch (Exception ex) { events.Writer.TryWrite(new { type = "error", message = ex.Message }); }
            finally { events.Writer.TryComplete(); }
        });

        try
        {
            await foreach (var ev in events.Reader.ReadAllAsync(ct))
            {
                await JsonSerializer.SerializeAsync(Response.Body, ev, ev.GetType(), _json, ct);
                await Response.Body.WriteAsync(NdjsonNewline, ct);
                await Response.Body.FlushAsync(ct);
            }
        }
        catch (OperationCanceledException) { /* client aborted */ }

        await work; // returns at the next room boundary once cancelled
    }

    private sealed class ChannelProgress(ChannelWriter<object> writer) : IFurnishProgress
    {
        public void RoomStarted(int index, int total, RoomSelection sel, string roomName, string? roomType) =>
            writer.TryWrite(new
            {
                type = "room", index, total,
                sel.FloorIndex, sel.RoomIndex1Based, sel.AnchorCol, sel.AnchorRow,
                roomName, roomType,
            });

        public void RoomFinished(int index, int total, RoomSelection sel,
                                 List<PlacedFurnitureItem> placements, List<ReservedZonePlacement> zones,
                                 List<string> log, bool skipped) =>
            writer.TryWrite(new
            {
                type = "roomDone", index, total,
                sel.FloorIndex, sel.RoomIndex1Based, sel.AnchorCol, sel.AnchorRow,
                placements, reservedZones = zones, log, skipped,
            });
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

    // ── Repro bundles ────────────────────────────────────────────────────────

    private const int ReproFormatVersion = 1;

    /// <summary>
    /// Bundle a finished furnish run (request as sent + its result) with the current room-type,
    /// tile and rug config and the app version, returned as a JSON download.
    /// </summary>
    [HttpPost("repro-export")]
    public IActionResult ReproExport([FromBody] ReproExportRequest req)
    {
        var bundle = new ReproBundle(
            ReproFormatVersion, AppInfo.Version, DateTime.UtcNow, req.FileName, req.Request,
            new Dictionary<string, RoomTypeConfig>(_roomTypes.GetAll()),
            _tiles.GetAllEnabled().Values.ToList(),
            _rugs.GetAllEnabled().Values.ToList(),
            req.Expected);
        var baseName = Path.GetFileNameWithoutExtension(string.IsNullOrWhiteSpace(req.FileName) ? "building" : req.FileName);
        var fileName = $"{baseName}_{req.Request.Seed}.pzrf-repro.json";
        return File(JsonSerializer.SerializeToUtf8Bytes(bundle, _json), "application/json", fileName);
    }

    /// <summary>
    /// Re-run a bundle's request against the bundle's own config (local config files are not
    /// read or touched). Returns the fresh result plus the running app version.
    /// </summary>
    [HttpPost("repro-replay")]
    public IActionResult ReproReplay([FromBody] ReproBundle bundle)
    {
        if (bundle.FormatVersion > ReproFormatVersion)
            return BadRequest($"Repro bundle format {bundle.FormatVersion} is newer than supported ({ReproFormatVersion}).");
        try
        {
            var inputs = new GeneratorInputs(
                bundle.RoomTypes,
                ToOrderedDict(bundle.Tiles, t => t.Id),
                ToOrderedDict(bundle.Rugs, r => r.Id));
            var result = _generator.Generate(bundle.Request, inputs: inputs);
            return Ok(new ReproReplayResult(result, AppInfo.Version));
        }
        catch (Exception ex) { return StatusCode(500, $"Replay failed: {ex.Message}\n{ex.StackTrace}"); }
    }

    /// <summary>First-wins by key, in list order — mirrors how the config services built the originals.</summary>
    private static Dictionary<string, T> ToOrderedDict<T>(IEnumerable<T> items, Func<T, string> key)
    {
        var dict = new Dictionary<string, T>();
        foreach (var item in items) dict.TryAdd(key(item), item);
        return dict;
    }
}

