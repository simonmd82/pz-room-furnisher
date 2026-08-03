@echo off
:: Node/npm suchen
set "NPM="
if exist "C:\Program Files\nodejs\npm.cmd" set "NPM=C:\Program Files\nodejs\npm.cmd"
if "%NPM%"=="" (
    echo FEHLER: npm nicht gefunden!
    pause
    exit /b 1
)
echo Verwende npm: %NPM%

:: Laufwerk mappen falls nicht vorhanden
if not exist "Y:\" net use Y: "\\Simonas\home" /persistent:no

cd /d "Y:\Project Zomboid\VSCode\pz-room-furnisher\PZ-Room-Furnisher\frontend"
echo Starte Frontend auf http://localhost:5173 ...
"%NPM%" run dev
pause
