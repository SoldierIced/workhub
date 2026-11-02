# Installs (or updates) Workhub 2 on Windows x64, for the current user, from the latest published
# GitHub release. Run it in PowerShell:
#
#   irm https://raw.githubusercontent.com/SoldierIced/workhub/main/scripts/install.ps1 | iex
#
# It downloads the installer, checks it against its .sha256, installs it silently and opens the app.
# A file downloaded by PowerShell carries no "downloaded from the internet" mark, so SmartScreen
# does not stop the unsigned installer.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar makes Invoke-WebRequest many times slower

$repo = 'SoldierIced/workhub'
$headers = @{ 'User-Agent' = 'workhub-install' }

# Every release also carries its installers under names without the version, so this link always
# fetches the latest one (see .github/workflows/release.yml).
$url = "https://github.com/$repo/releases/latest/download/Workhub-2-win-x64.exe"

$dir = Join-Path $env:TEMP 'workhub-install'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$file = Join-Path $dir 'Workhub-2-win-x64.exe'
Write-Host 'Downloading the latest Workhub 2...'
try { Invoke-WebRequest -Uri $url -OutFile $file -Headers $headers -UseBasicParsing }
catch { throw "Could not download $url (no published release yet?). See https://github.com/$repo/releases" }

$sumFile = "$file.sha256"
$hasSum = $true
try { Invoke-WebRequest -Uri "$url.sha256" -OutFile $sumFile -Headers $headers -UseBasicParsing } catch { $hasSum = $false }
if ($hasSum) {
  $want = ((Get-Content -Raw $sumFile).Trim() -split '\s+')[0].ToUpperInvariant()
  $got = (Get-FileHash -Path $file -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($got -ne $want) { Remove-Item $file -Force; throw "The download does not match its checksum; nothing was installed. Try again." }
  Write-Host 'Checksum OK.'
}

# A running copy keeps its files open: ask it to quit first (its sessions can be resumed later).
Get-Process -Name 'Workhub 2' -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }
Start-Sleep -Seconds 2

Write-Host 'Installing Workhub 2...'
$p = Start-Process -FilePath $file -ArgumentList '/S' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "The installer failed (exit code $($p.ExitCode))." }
Remove-Item $file -Force -ErrorAction SilentlyContinue

$app = Join-Path $env:LOCALAPPDATA 'Programs\Workhub 2\Workhub 2.exe'
if (Test-Path $app) {
  Write-Host 'Done. Opening Workhub 2.'
  Start-Process -FilePath $app
} else {
  Write-Host 'Done. Open Workhub 2 from the Start menu.'
}
