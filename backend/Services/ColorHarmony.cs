using backend.Models;

namespace backend.Services;

/// <summary>
/// Colour-wheel matching for furniture outside a room's colour group. Colours are tag names
/// (e.g. "Red"); their wheel position comes from the settings' colour → hue map, where null
/// or a missing entry means neutral (Black/White/Grey/Beige/Brown/Metal/Mixed…). A colour
/// matches the room's reference hue when it is analogous (≤ 60° away) or complementary
/// (180° ± 30°, which also covers split-complementary). Neutrals match everything.
/// </summary>
public static class ColorHarmony
{
    private const int AnalogousRange     = 60;
    private const int ComplementaryRange = 30;

    public static int? Hue(string color, IReadOnlyDictionary<string, int?> hues) =>
        !string.IsNullOrEmpty(color) && hues.TryGetValue(color, out var h) ? h : null;

    /// <summary>Hue of the first chromatic colour in <paramref name="colors"/>, or null if all are neutral.</summary>
    public static int? FirstChromaticHue(IEnumerable<string> colors, IReadOnlyDictionary<string, int?> hues) =>
        colors.Select(c => Hue(c, hues)).FirstOrDefault(h => h.HasValue);

    public static bool Matches(int refHue, int hue)
    {
        int d = Math.Abs(refHue - hue) % 360;
        if (d > 180) d = 360 - d;
        return d <= AnalogousRange || Math.Abs(d - 180) <= ComplementaryRange;
    }

    /// <summary>True when every chromatic colour of the tile matches (an all-neutral tile always does).</summary>
    public static bool TileMatches(TileDefinition tile, int refHue, IReadOnlyDictionary<string, int?> hues) =>
        tile.Colors.All(c => Hue(c, hues) is not { } h || Matches(refHue, h));

    /// <summary>
    /// Tiles matching <paramref name="refHue"/>; the unchanged list when none does (soft preference,
    /// like the colour-group filter — a slot is never dropped for clashing).
    /// </summary>
    public static List<TileDefinition> Filter(List<TileDefinition> candidates, int refHue,
        IReadOnlyDictionary<string, int?> hues, out bool applied)
    {
        var matching = candidates.Where(t => TileMatches(t, refHue, hues)).ToList();
        applied = matching.Count > 0;
        return applied ? matching : candidates;
    }
}
