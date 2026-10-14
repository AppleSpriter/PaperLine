#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'This packaging script requires macOS.' >&2
  exit 1
fi
export PATH="$PWD/.desktop-tools/cargo/bin:$PATH"
if [[ -d .desktop-tools/rustup ]]; then
  export CARGO_HOME="$PWD/.desktop-tools/cargo"
  export RUSTUP_HOME="$PWD/.desktop-tools/rustup"
fi
python_bin="${PAPERLINE_PYTHON:-python3}"
venv=".desktop-tools/venv"
if [[ ! -x "$venv/bin/python" ]]; then
  "$python_bin" -m venv "$venv"
elif [[ -n "${PAPERLINE_PYTHON:-}" ]]; then
  requested_base="$("$python_bin" -c 'import pathlib,sys; print(pathlib.Path(sys.executable).resolve())')"
  existing_base="$("$venv/bin/python" -c 'import pathlib,sys; print(pathlib.Path(sys._base_executable).resolve())')"
  if [[ "$requested_base" != "$existing_base" ]]; then
    echo 'PAPERLINE_PYTHON differs from the existing desktop virtual environment. Recreate .desktop-tools/venv with the requested Python before building.' >&2
    exit 1
  fi
fi
if ! "$venv/bin/python" -m PyInstaller --version >/dev/null 2>&1; then
  "$venv/bin/python" -m pip install --disable-pip-version-check 'pyinstaller>=6.11,<7'
fi
"$venv/bin/python" scripts/check-desktop-python.py
target="$(rustc -vV | sed -n 's/^host: //p')"
mkdir -p src-tauri/binaries
"$venv/bin/python" -m PyInstaller --noconfirm --clean --onefile \
  --name "paperline-backend-$target" \
  --osx-entitlements-file src-tauri/Entitlements.plist \
  --distpath src-tauri/binaries --workpath .desktop-build/pyinstaller \
  --specpath .desktop-build --paths . desktop_backend.py
chmod +x "src-tauri/binaries/paperline-backend-$target"
