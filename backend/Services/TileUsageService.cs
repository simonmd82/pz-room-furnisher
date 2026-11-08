using backend.Models;

namespace backend.Services;

/// <summary>One place a tile definition can be picked by the generator.</summary>
/// <param name="Source">"slot" | "pool" | "poolRequired" | "companion" | "grid"</param>
/// <param name="ViaVariantGroup">Not matched directly, but a sibling of a matched tile in the same
/// VariantGroup (the generator swaps to siblings for orientation/corner variants).</param>
public record TileUsageRef(string RoomType, string Source, string SourceId, string Label, bool ViaVariantGroup);

public record TileUsageEntry(TileDefinition Tile, string SetId, bool SetEnabled, List<TileUsageRef> Usage);

public interface ITileUsageService
{
    /// <summary>Every tile definition of every set, with the room-type slots that can pick it.</summary>
    List<TileUsageEntry> GetUsage();
}

/// <summary>
/// Answers "which tiles can any room type actually use?" with the generator's own slot filter
/// (FurnishingGeneratorService.MatchTiles). Rug slots (RugDefinition catalog) and disabled
/// layout variants are ignored.
/// </summary>
public class TileUsageService : ITileUsageService
{
    private readonly ITileConfigService     _tiles;
    private readonly IRoomTypeConfigService _roomTypes;
    private readonly ISettingsService       _settings;

    public TileUsageService(ITileConfigService tiles, IRoomTypeConfigService roomTypes, ISettingsService settings)
    {
        _settings  = settings;
        _tiles     = tiles;
        _roomTypes = roomTypes;
    }

    public List<TileUsageEntry> GetUsage()
    {
        var allTiles = _tiles.GetAll();
        var themed   = new HashSet<string>(_settings.GetThemedCategories(), StringComparer.OrdinalIgnoreCase);
        var usage    = new Dictionary<string, List<TileUsageRef>>(StringComparer.OrdinalIgnoreCase);

        foreach (var (roomType, config) in _roomTypes.GetAll())
        {
            // Same per-room pre-filter as the generator: RoomTypes empty = everywhere.
            var roomTiles = allTiles
                .Where(kv => kv.Value.RoomTypes.Count == 0
                          || kv.Value.RoomTypes.Any(rt => rt.Equals(roomType, StringComparison.OrdinalIgnoreCase)))
                .ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.OrdinalIgnoreCase);
            var byVariantGroup = roomTiles.Values
                .Where(t => !string.IsNullOrEmpty(t.VariantGroup))
                .GroupBy(t => t.VariantGroup, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.OrdinalIgnoreCase);

            foreach (var (source, sourceId, label, slot) in ProbeSlots(config))
            {
                var direct = FurnishingGeneratorService.MatchTiles(roomTiles, slot, roomType, themed).ToList();
                var directIds = new HashSet<string>(direct.Select(t => t.Id), StringComparer.OrdinalIgnoreCase);
                foreach (var t in direct)
                    Add(usage, t.Id, new TileUsageRef(roomType, source, sourceId, label, false));

                var siblings = direct
                    .Where(t => !string.IsNullOrEmpty(t.VariantGroup))
                    .Select(t => t.VariantGroup)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .SelectMany(vg => byVariantGroup.GetValueOrDefault(vg) ?? [])
                    .Where(t => !directIds.Contains(t.Id));
                foreach (var t in siblings)
                    Add(usage, t.Id, new TileUsageRef(roomType, source, sourceId, label, true));
            }
        }

        var result = new List<TileUsageEntry>();
        foreach (var set in _tiles.GetSets())
            foreach (var t in _tiles.GetAllForSet(set.Id).Values)
                result.Add(new TileUsageEntry(t, set.Id, set.Enabled, usage.GetValueOrDefault(t.Id) ?? []));
        return result;
    }

    private static void Add(Dictionary<string, List<TileUsageRef>> usage, string id, TileUsageRef r)
    {
        if (!usage.TryGetValue(id, out var list)) usage[id] = list = [];
        // One slot can reach a tile both directly and via its group — keep a single ref per slot.
        if (list.Any(x => x.RoomType == r.RoomType && x.SourceId == r.SourceId)) return;
        list.Add(r);
    }

    /// <summary>
    /// Every slot shape the generator can build from a room type, reduced to the fields
    /// MatchTiles reads. Pool/companion slots mirror ExpandPools (always 1x1).
    /// </summary>
    private static IEnumerable<(string Source, string SourceId, string Label, RoomTypeSlot Slot)> ProbeSlots(RoomTypeConfig config)
    {
        foreach (var s in config.Slots.Where(s => s.RugSlot is null))
            yield return ("slot", s.Id, s.Label, s);

        foreach (var grid in config.Grids)
            foreach (var cell in grid.Cells)
            {
                var slot = FurnishingGeneratorService.BuildGridCellSlot(grid, cell);
                yield return ("grid", slot.Id, $"{(string.IsNullOrWhiteSpace(grid.Label) ? grid.Id : grid.Label)} › {slot.Label}", slot);
            }

        foreach (var variant in config.LayoutVariants.Where(v => !v.Disabled))
            foreach (var pool in variant.Pools)
            {
                var poolId = $"{variant.Id}/{pool.Id}";
                yield return ("pool", poolId, pool.Label,
                    Probe(pool.DefaultCategories, pool.RequiredLayer, pool.RequiredProperties, pool.AllowedThemes));

                foreach (var (c, ci) in pool.DefaultCompanions.Select((c, i) => (c, i)))
                    yield return ("companion", $"{poolId}/companion_{ci}", $"{pool.Label} › {c.Label}",
                        Probe(c.AllowedCategories, c.RequiredLayer, c.RequiredProperties, c.AllowedThemes));

                foreach (var (rs, ri) in pool.RequiredSlots.Select((r, i) => (r, i)))
                {
                    var rsId = $"{poolId}/required_{ri}";
                    var layer = string.IsNullOrEmpty(rs.RequiredLayer) ? pool.RequiredLayer : rs.RequiredLayer;
                    yield return ("poolRequired", rsId, $"{pool.Label} › {rs.Label}",
                        Probe(new Dictionary<string, int> { [rs.Category] = rs.Weight }, layer, rs.RequiredProperties, pool.AllowedThemes));

                    foreach (var (c, ci) in rs.Companions.Select((c, i) => (c, i)))
                        yield return ("companion", $"{rsId}/companion_{ci}", $"{pool.Label} › {rs.Label} › {c.Label}",
                            Probe(c.AllowedCategories, c.RequiredLayer, c.RequiredProperties, c.AllowedThemes));
                }
            }
    }

    private static RoomTypeSlot Probe(Dictionary<string, int> categories, string layer, List<string> props, List<string> themes) => new()
    {
        Footprint          = new SlotFootprint { Width = 1, Height = 1, CanRotate = false },
        AllowedCategories  = categories,
        AllowedThemes      = themes,
        RequiredLayer      = layer,
        RequiredProperties = props,
    };
}
