using System.Diagnostics;
using System.Text.Json.Serialization;
using backend.Services;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers()
    .AddJsonOptions(opts =>
    {
        // Serialize enums as strings so the frontend gets "Door"/"Window"/"N"/"W" etc.
        opts.JsonSerializerOptions.Converters.Add(new JsonStringEnumConverter());
    });
builder.Services.AddOpenApi();

builder.Services.AddScoped<ITbxParserService, TbxParserService>();
builder.Services.AddSingleton<ITileLibraryService, TileLibraryService>();
builder.Services.AddSingleton<ITileConfigService, TileConfigService>();
builder.Services.AddSingleton<IBuildingFurnitureService, BuildingFurnitureService>();
builder.Services.AddSingleton<IRoomTypeConfigService, RoomTypeConfigService>();
builder.Services.AddSingleton<ISettingsService, SettingsService>();
builder.Services.AddSingleton<IRugCatalogService, RugCatalogService>();
builder.Services.AddSingleton<IWallFurnitureClassificationService, WallFurnitureClassificationService>();
builder.Services.AddSingleton<IPathfinderService, PathfinderService>();
builder.Services.AddSingleton<IFurnishingGeneratorService, FurnishingGeneratorService>();
builder.Services.AddSingleton<ITileUsageService, TileUsageService>();
builder.Services.AddSingleton<ITbxExportService, TbxExportService>();

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy
            .WithOrigins("http://localhost:5173")
            .AllowAnyHeader()
            .AllowAnyMethod();
    });
});

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
    app.UseCors();
}
else
{
    if (Directory.Exists(app.Environment.WebRootPath))
    {
        app.UseDefaultFiles();
        app.UseStaticFiles();
    }

    var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();
    lifetime.ApplicationStarted.Register(() =>
    {
        var url = app.Urls.FirstOrDefault() ?? "http://localhost:5000";
        try
        {
            if (OperatingSystem.IsWindows())
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            else if (OperatingSystem.IsLinux())
                Process.Start("xdg-open", url);
        }
        catch
        {
            // Best-effort only — user can still open the URL manually.
        }
    });
}

app.MapControllers();

if (!app.Environment.IsDevelopment())
{
    app.MapFallbackToFile("index.html");
}

app.Run();
