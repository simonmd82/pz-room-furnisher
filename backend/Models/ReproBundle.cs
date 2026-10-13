using backend.Services;

namespace backend.Models;

/// <summary>What a furnish run produced, stored in a repro bundle so a replay can be compared against it.</summary>
public record ReproExpected(
    List<PlacedFurnitureItem>   Placements,
    List<ReservedZonePlacement> ReservedZones,
    List<string>                Log);

/// <summary>
/// Everything needed to replay one furnish run on another machine: the exact request (building
/// incl. its stored walking paths, room selections in order, seed, density) plus the room-type,
/// tile and rug config it ran against. Tiles/rugs are lists in the original dictionary iteration
/// order, so rebuilding them reproduces the same iteration order in the generator.
/// </summary>
public record ReproBundle(
    int                                FormatVersion,
    string                             AppVersion,
    DateTime                           CreatedUtc,
    string                             FileName,
    FurnishRequest                     Request,
    Dictionary<string, RoomTypeConfig> RoomTypes,
    List<TileDefinition>               Tiles,
    List<RugDefinition>                Rugs,
    ReproExpected                      Expected);

public record ReproExportRequest(
    FurnishRequest Request,
    string         FileName,
    ReproExpected  Expected);

public record ReproReplayResult(
    FurnishResult Result,
    string        AppVersion);
