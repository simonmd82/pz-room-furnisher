<#
.SYNOPSIS
  Builds self-contained release packages of PZ Room Furnisher for Windows and Linux.

.DESCRIPTION
  1. Builds the frontend and copies it into backend/wwwroot.
  2. Publishes the backend self-contained for each target runtime.
  3. Zips each publish output into dist/PzRoomFurnisher-<rid>.zip.

.PARAMETER Rids
  Runtime identifiers to build. Defaults to win-x64 and linux-x64.

.PARAMETER Version
  App version stamped into the backend (shown in repro bundles). Defaults to the csproj <Version>.

.EXAMPLE
  ./build-release.ps1
  ./build-release.ps1 -Rids win-x64
  ./build-release.ps1 -Version 0.2.0
#>
param(
    [string[]]$Rids = @('win-x64', 'linux-x64'),
    [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$frontendDir = Join-Path $root 'frontend'
$backendProj = Join-Path $root 'backend/backend.csproj'
$wwwroot = Join-Path $root 'backend/wwwroot'
$distDir = Join-Path $root 'dist'

Write-Host "==> Building frontend"
Push-Location $frontendDir
try {
    npm ci
    npm run build
}
finally {
    Pop-Location
}

if (Test-Path $wwwroot) {
    Remove-Item $wwwroot -Recurse -Force
}
Copy-Item (Join-Path $frontendDir 'dist') $wwwroot -Recurse

if (Test-Path $distDir) {
    Remove-Item $distDir -Recurse -Force
}
New-Item -ItemType Directory -Path $distDir | Out-Null

foreach ($rid in $Rids) {
    Write-Host "==> Publishing backend for $rid"
    $publishDir = Join-Path $distDir $rid

    $versionArgs = if ($Version) { @("-p:Version=$Version") } else { @() }
    dotnet publish $backendProj `
        -c Release `
        -r $rid `
        --self-contained true `
        -p:PublishSingleFile=false `
        @versionArgs `
        -o $publishDir

    $zipPath = Join-Path $distDir "PzRoomFurnisher-$rid.zip"
    Write-Host "==> Zipping $zipPath"
    Compress-Archive -Path (Join-Path $publishDir '*') -DestinationPath $zipPath -Force
}

Write-Host "==> Done. Packages in $distDir"
