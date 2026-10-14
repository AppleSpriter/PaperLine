param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location (Split-Path $PSScriptRoot -Parent)
if ($env:OS -ne 'Windows_NT') { throw 'This installer test requires Windows.' }
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Run installation verification in the dedicated GitHub Actions runner; NSIS registration must not replace a real user installation.' }
$installerPath = (Resolve-Path $Installer).Path
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('paperline-install-smoke-' + [guid]::NewGuid().ToString('N'))
$installDirectory = Join-Path $fixture 'installed'
$dataDirectory = Join-Path $fixture 'synthetic-data'
New-Item -ItemType Directory -Force $dataDirectory | Out-Null
$tracked = @{}
$app = $null
$uninstalled = $false
function Observe-OwnedProcesses {
    param([int]$RootPid)
    $processes = @(Get-CimInstance Win32_Process)
    $parents = @($RootPid) + @($tracked.Keys)
    do {
        $added = $false
        foreach ($process in $processes) {
            if ($parents -contains [int]$process.ParentProcessId -and !$tracked.ContainsKey([int]$process.ProcessId)) {
                $tracked[[int]$process.ProcessId] = $process.CreationDate
                $parents += [int]$process.ProcessId
                $added = $true
            }
        }
    } while ($added)
}
function Get-OwnedSurvivors {
    @(Get-CimInstance Win32_Process | Where-Object {
        $tracked.ContainsKey([int]$_.ProcessId) -and $tracked[[int]$_.ProcessId] -eq $_.CreationDate
    })
}
try {
    # NSIS requires /D as the final argument; everything after /D= is its path.
    $setup = Start-Process $installerPath -ArgumentList "/S /D=$installDirectory" -PassThru
    if (!$setup.WaitForExit(120000)) { Stop-Process -Id $setup.Id -Force; throw 'Silent installer timed out.' }
    if ($setup.ExitCode -ne 0) { throw "Silent installer failed: $($setup.ExitCode)" }
    $executable = Join-Path $installDirectory 'paperline.exe'
    if (!(Test-Path $executable)) { throw "Installed executable is missing: $executable" }
    $python = Join-Path $PWD '.desktop-tools/venv-windows/Scripts/python.exe'
    & $python scripts/verify-packaged-backend.py $installDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Installed helper failed protocol verification.' }
    # Native smoke mode uses this explicit synthetic directory, creates the real WebView,
    # and exits through the normal application lifecycle. It never reads the user profile.
    $app = Start-Process $executable -ArgumentList "--smoke-test `"$dataDirectory`"" -PassThru
    $visibleWindow = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while (!$app.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        Observe-OwnedProcesses -RootPid $app.Id
        $app.Refresh()
        if ($app.MainWindowHandle -ne [IntPtr]::Zero) { $visibleWindow = $true }
        Start-Sleep -Milliseconds 200
    }
    if (!$app.HasExited) { throw 'Installed application did not exit normally within 45 seconds.' }
    $app.WaitForExit()
    if ($app.ExitCode -ne 0) { throw "Installed application smoke failed: $($app.ExitCode)" }
    if (!$visibleWindow) { throw 'Application exited without showing a native window.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $survivors = @(Get-OwnedSurvivors)
        if ($survivors.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($survivors.Count -ne 0) { throw "Application left owned processes alive: $($survivors.ProcessId -join ', ')" }
    $uninstaller = Join-Path $installDirectory 'uninstall.exe'
    if (!(Test-Path $uninstaller)) { throw 'Installed uninstaller is missing.' }
    # _?= avoids the NSIS self-copy parent returning before its temporary child finishes.
    $uninstall = Start-Process $uninstaller -ArgumentList "/S _?=$installDirectory" -PassThru
    if (!$uninstall.WaitForExit(60000)) { Stop-Process -Id $uninstall.Id -Force; throw 'Uninstaller timed out.' }
    if ($uninstall.ExitCode -ne 0) { throw "Uninstaller failed: $($uninstall.ExitCode)" }
    if (Test-Path $executable) { throw 'Uninstaller left the installed application executable behind.' }
    $uninstalled = $true
    Write-Host 'Installed app passed helper protocol, native window, normal exit, descendant cleanup, and uninstall checks.'
} finally {
    # Failure cleanup is restricted to this launch and observed PID+creation-time identities.
    if ($null -ne $app -and !$app.HasExited) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
    foreach ($process in @(Get-OwnedSurvivors)) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
    $uninstaller = Join-Path $installDirectory 'uninstall.exe'
    if (!$uninstalled -and (Test-Path $uninstaller)) {
        $uninstall = Start-Process $uninstaller -ArgumentList "/S _?=$installDirectory" -PassThru
        if (!$uninstall.WaitForExit(60000)) { Stop-Process -Id $uninstall.Id -Force -ErrorAction SilentlyContinue }
    }
    if (Test-Path $fixture) { Remove-Item $fixture -Recurse -Force -ErrorAction SilentlyContinue }
}
