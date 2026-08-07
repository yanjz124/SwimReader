<#
  Push the latest FAA IndustryLADD filter to the running SwimReader deployments.

  The LADD list (privacy-blocked aircraft) updates roughly weekly on the FAA ADX
  portal. It is NEVER committed to git — it is CUI//SP-PRVCY privacy data. Workflow:

    1. Download the newest "LADD Industry" filter from https://adx.faa.gov
       (SCBlockAtIndustry community) into  <repo>/LADD/LADD Industry/  — that folder
       is gitignored, so it is just your local archive.
    2. Run this script. It picks the newest LADD_Industry_Filter file, installs it as
       the single active list locally, and scp's it to the Pi.

  The server reloads the ladd/ folder every 6 hours, so the new list takes effect
  within a day with no restart. Use -Restart to apply it immediately.

  Usage:
    ./update-ladd.ps1                 # install latest locally + scp to Pi
    ./update-ladd.ps1 -Restart        # ...and restart the Pi service now
    ./update-ladd.ps1 -LocalOnly      # just refresh the local active list
#>
param(
    [switch]$Restart,
    [switch]$LocalOnly,
    [string]$PiHost = 'JY@JY5',
    [string]$PiLaddDir = '/home/JY/SwimReader/tools/SwimServer/ladd'
)

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$archive = Join-Path $repo 'LADD\LADD Industry'

if (-not (Test-Path $archive)) { throw "Archive folder not found: $archive`nDownload the Industry filter there first." }

$files = Get-ChildItem (Join-Path $archive 'LADD_Industry_Filter*.txt') -ErrorAction SilentlyContinue
if (-not $files) { throw "No LADD_Industry_Filter*.txt files in $archive" }

# Newest by the yyyyMMdd stamped in the filename (naming has varied — the CUI prefix
# was added mid-2026 — so sort on the date, not the raw name).
$newest = $files | Sort-Object { if ($_.Name -match '(\d{8})') { [int64]$Matches[1] } else { 0 } } -Descending | Select-Object -First 1
$lines = (Get-Content $newest.FullName | Measure-Object -Line).Lines
Write-Host "Latest Industry filter: $($newest.Name)  ($lines identifiers)" -ForegroundColor Cyan

# Install as the single active local list (overwrite so old weeks never accumulate —
# a union of many weeks would keep blocking aircraft that have since opted out).
$localDir = Join-Path $PSScriptRoot 'ladd'
New-Item -ItemType Directory -Force $localDir | Out-Null
Get-ChildItem (Join-Path $localDir '*.txt'), (Join-Path $localDir '*.csv') -ErrorAction SilentlyContinue | Remove-Item -Force
Copy-Item $newest.FullName (Join-Path $localDir 'IndustryLADD.txt') -Force
Write-Host "Installed locally -> $localDir\IndustryLADD.txt" -ForegroundColor Green

if ($LocalOnly) { return }

# Ship to the Pi (single active file; overwrite).
Write-Host "Copying to ${PiHost}:${PiLaddDir}/IndustryLADD.txt ..." -ForegroundColor Cyan
ssh $PiHost "mkdir -p '$PiLaddDir' && rm -f '$PiLaddDir'/*.txt '$PiLaddDir'/*.csv 2>/dev/null; true"
scp $newest.FullName "${PiHost}:${PiLaddDir}/IndustryLADD.txt"
if ($LASTEXITCODE -ne 0) { throw "scp failed" }
Write-Host "Uploaded to Pi." -ForegroundColor Green

if ($Restart) {
    Write-Host "Restarting sfdps-eram on the Pi..." -ForegroundColor Cyan
    ssh $PiHost 'sudo systemctl restart sfdps-eram'
    Write-Host "Restarted." -ForegroundColor Green
} else {
    Write-Host "The server auto-reloads within 6h. Use -Restart to apply immediately." -ForegroundColor DarkGray
}
