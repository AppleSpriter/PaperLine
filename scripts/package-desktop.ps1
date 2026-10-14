$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location (Split-Path $PSScriptRoot -Parent)
if ($env:OS -ne 'Windows_NT') { throw 'Windows installers must be packaged on a Windows x64 machine.' }
& npm.cmd run desktop:windows:build
if ($LASTEXITCODE -ne 0) { throw 'Tauri Windows build failed.' }
$config = Get-Content 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json
$version = [string]$config.version
if ($version -notmatch '^[0-9A-Za-z.+-]+$') { throw 'Invalid application version.' }
$output = Join-Path $PWD "dist/windows/$version"
# Installer output is separate from any installed/running application.
New-Item -ItemType Directory -Force $output | Out-Null
$installers = @(Get-ChildItem 'src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis' -Filter '*-setup.exe')
if ($installers.Count -ne 1) { throw 'Expected exactly one NSIS installer in the Windows build output.' }
$installer = Join-Path $output "PaperLine_${version}_x64-setup.exe"
Copy-Item $installers[0].FullName $installer -Force
(Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + (Split-Path $installer -Leaf) | Set-Content (Join-Path $output 'SHA256SUMS.txt') -Encoding ascii
Write-Host "Windows installer: $installer"
Write-Host 'Installer GUI/lifecycle verification requires a Windows session or the CI workflow.'
