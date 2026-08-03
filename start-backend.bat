@echo off
:: Dotnet suchen
set "DOTNET="
if exist "C:\Users\simon\.dotnet\dotnet.exe" set "DOTNET=C:\Users\simon\.dotnet\dotnet.exe"
if "%DOTNET%"=="" if exist "C:\Program Files\dotnet\dotnet.exe" set "DOTNET=C:\Program Files\dotnet\dotnet.exe"
if "%DOTNET%"=="" (
    echo FEHLER: dotnet.exe nicht gefunden!
    pause
    exit /b 1
)
echo Verwende dotnet: %DOTNET%

:: Laufwerk mappen falls nicht vorhanden
if not exist "Y:\" net use Y: "\\Simonas\home" /persistent:no

cd /d "Y:\Project Zomboid\VSCode\pz-room-furnisher\PZ-Room-Furnisher\backend"
echo Starte Backend auf http://localhost:5000 ...
"%DOTNET%" watch run
pause
