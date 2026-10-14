$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location (Split-Path $PSScriptRoot -Parent)
if ($env:OS -ne 'Windows_NT') { throw 'Build this sidecar on Windows x64; PyInstaller does not cross-compile.' }
$pythonCommand = 'py'
$pythonPrefix = @('-3.13')
if ($env:PAPERLINE_PYTHON) { $pythonCommand = $env:PAPERLINE_PYTHON; $pythonPrefix = @() }
& $pythonCommand @pythonPrefix -c "import struct,sys; assert sys.version_info[:2] == (3,13) and struct.calcsize('P') == 8, 'Requires Python 3.13 x64'"
if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.13 x64 or set PAPERLINE_PYTHON to its executable.' }
$venv = Join-Path $PWD '.desktop-tools/venv-windows'
$python = Join-Path $venv 'Scripts/python.exe'
if (!(Test-Path $python)) {
    & $pythonCommand @pythonPrefix -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create Windows packaging virtual environment.' }
}
& $python -c "import struct,sys; assert sys.version_info[:2] == (3,13) and struct.calcsize('P') == 8, 'Recreate .desktop-tools/venv-windows using Python 3.13 x64'"
if ($LASTEXITCODE -ne 0) { throw 'The existing Windows packaging environment is incompatible.' }
& $python -m pip install --disable-pip-version-check 'pyinstaller>=6.11,<7'
if ($LASTEXITCODE -ne 0) { throw 'Cannot install PyInstaller.' }
$rustInfo = & rustc -vV
if ($LASTEXITCODE -ne 0 -or ($rustInfo -join "`n") -notmatch 'host: x86_64-pc-windows-msvc') { throw 'Install the Rust x86_64-pc-windows-msvc toolchain.' }
New-Item -ItemType Directory -Force 'src-tauri/binaries' | Out-Null
# Console bootloader preserves JSON-lines stdin/stdout; the Rust parent hides its window.
& $python -m PyInstaller --noconfirm --clean --onefile --console `
    --name paperline-backend-x86_64-pc-windows-msvc `
    --distpath src-tauri/binaries --workpath .desktop-build/pyinstaller-windows `
    --specpath .desktop-build --paths . desktop_backend.py
if ($LASTEXITCODE -ne 0) { throw 'Windows sidecar build failed.' }
& $python scripts/verify-packaged-backend.py src-tauri/binaries/paperline-backend-x86_64-pc-windows-msvc.exe
if ($LASTEXITCODE -ne 0) { throw 'Windows sidecar startup verification failed.' }
