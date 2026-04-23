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
builder.Services.AddSingleton<IPathfinderService, PathfinderService>();

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
}

app.UseCors();
app.MapControllers();

app.Run();
