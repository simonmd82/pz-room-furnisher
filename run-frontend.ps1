# Laufwerk sicherstellen
if (-not (Test-Path "Y:\")) {
    net use Y: "\\Simonas\home" /persistent:no | Out-Null
}

$frontendDir = "Y:\Project Zomboid\VSCode\pz-room-furnisher\PZ-Room-Furnisher\frontend"
npm --prefix $frontendDir run dev
