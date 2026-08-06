<#
  Builds the downloadable Windows local edition of "How's my friend at work doing?"

  Produces a self-contained, single-file build under  publish/win-x64/  plus a zip
  ready to hand to a user. They unzip it, double-click SwimServer.exe, and the app
  opens a browser to a first-run setup page for their FAA SWIM SCDS credentials.

  Usage:   ./publish-local.ps1            (from tools/SwimServer)
           ./publish-local.ps1 -Zip       (also produce SwimReader-win-x64.zip)

  Requires the .NET 8 SDK.
#>
param([switch]$Zip)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$out = 'publish/win-x64'
Write-Host "Publishing self-contained win-x64 single-file build..." -ForegroundColor Cyan

dotnet publish -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:EnableCompressionInSingleFile=true `
    -o $out --nologo
if ($LASTEXITCODE -ne 0) { throw "publish failed" }

# Never ship a developer's saved credentials or runtime state.
foreach ($junk in 'swimreader.config.json','flight-cache','flight-history','tdls-history',
                  'itws-history','replay','crc-export','holdbar-map','nasr-data','ladd') {
    $p = Join-Path $out $junk
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
# Ship the user-facing quick-start next to the exe.
Copy-Item (Join-Path $PSScriptRoot 'README-local.txt') (Join-Path $out 'README.txt') -Force -ErrorAction SilentlyContinue

$exe = Join-Path $out 'SwimServer.exe'
$mb  = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "Built $exe ($mb MB)" -ForegroundColor Green

if ($Zip) {
    $zip = 'SwimReader-win-x64.zip'
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zip
    Write-Host "Zipped -> $zip" -ForegroundColor Green
}
