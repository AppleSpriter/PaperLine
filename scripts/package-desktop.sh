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
version="$("$python_bin" -c 'import json; print(json.load(open("src-tauri/tauri.conf.json"))["version"])')"
if [[ ! "$version" =~ ^[0-9A-Za-z.+-]+$ ]]; then
  echo 'Invalid application version for installer output.' >&2
  exit 1
fi
target="$(rustc -vV | sed -n 's/^host: //p')"
output="dist/macos/$version"
mkdir -p "$output"
# Keep the unversioned preview app intact, even while it is running.
ditto "$bundle" "$output/PaperLine.app"
staging="$(mktemp -d "${TMPDIR:-/tmp}/paperline-dmg.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
# ditto preserves bundle metadata and executable permissions.
ditto "$output/PaperLine.app" "$staging/PaperLine.app"
ln -s /Applications "$staging/Applications"
image="$output/PaperLine_${version}_${target}.dmg"
hdiutil create -volname PaperLine -srcfolder "$staging" -format UDZO -ov "$image"
hdiutil verify "$image"
printf 'Packaged application: %s/%s/PaperLine.app\nInstaller: %s/%s\n' "$PWD" "$output" "$PWD" "$image"
