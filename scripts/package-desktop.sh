#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.desktop-tools/cargo/bin:$PATH"
if [[ -d .desktop-tools/rustup ]]; then
  export CARGO_HOME="$PWD/.desktop-tools/cargo"
  export RUSTUP_HOME="$PWD/.desktop-tools/rustup"
fi
# Bundle the app first. The installer below needs no Finder or AppleScript session.
npm run desktop:build -- --bundles app
python_bin="${PAPERLINE_PYTHON:-python3}"
bundle="src-tauri/target/release/bundle/macos/PaperLine.app"
"$python_bin" scripts/verify-packaged-backend.py "$bundle"
codesign --verify --deep --strict "$bundle"
.desktop-tools/venv/bin/python scripts/desktop-build-privacy.py audit "$bundle/Contents/MacOS/paperline-backend"
"$python_bin" - "$bundle/Contents/MacOS/paperline" <<'PYAUDIT'
import sys
from pathlib import Path
count = Path(sys.argv[1]).read_bytes().count(str(Path.home()).encode())
print(f"Rust binary private home path matches: {count}")
if count:
    raise SystemExit("Rust build path privacy audit failed")
PYAUDIT
version="$("$python_bin" scripts/desktop-version.py macos)"
bundle_version="$("$python_bin" - "$bundle/Contents/Info.plist" <<'PYVERSION'
import plistlib, sys
with open(sys.argv[1], 'rb') as stream:
    print(plistlib.load(stream)['CFBundleShortVersionString'])
PYVERSION
)"
if [[ "$bundle_version" != "$version" ]]; then
  echo 'Built bundle version does not match the effective macOS configuration.' >&2
  exit 1
fi
if [[ ! "$version" =~ ^[0-9A-Za-z.+-]+$ ]]; then
  echo 'Invalid application version for installer output.' >&2
  exit 1
fi
target="$(rustc -vV | sed -n 's/^host: //p')"
output="dist/macos/$version"
mkdir -p "$output"
# Keep a compressed recovery/build archive, never another launchable installed app.
archive="$output/PaperLine_${version}_${target}.app.zip"
ditto -c -k --sequesterRsrc --keepParent "$bundle" "$archive"
staging="$(mktemp -d "${TMPDIR:-/tmp}/paperline-dmg.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
ditto "$bundle" "$staging/PaperLine.app"
ln -s /Applications "$staging/Applications"
image="$output/PaperLine_${version}_${target}.dmg"
hdiutil create -volname PaperLine -srcfolder "$staging" -format UDZO -ov "$image"
hdiutil verify "$image"
printf 'Application archive: %s/%s\nInstaller: %s/%s\n' "$PWD" "$archive" "$PWD" "$image"

# Remove only this temporary build path from LaunchServices before deleting it.
# Existing registrations can cause macOS to rediscover a rebuilt bundle automatically.
lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if ! "$lsregister" -u "$bundle"; then
  echo 'Warning: LaunchServices could not unregister the temporary build bundle.' >&2
fi
# The sole installed app is /Applications/PaperLine.app.
rm -rf "$bundle"
