#!/bin/sh
set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
icon_source="$project_dir/assets/paperline-icon.svg"
icon_output="$project_dir/PaperLine.app/Contents/Resources/PaperLine.icns"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

qlmanage -t -s 1024 -o "$work_dir" "$icon_source" >/dev/null
master="$work_dir/paperline-icon.svg.png"
iconset="$work_dir/PaperLine.iconset"
mkdir -p "$iconset"

cp "$master" "$iconset/icon_512x512@2x.png"
for entry in '16 icon_16x16' '32 icon_16x16@2x' '32 icon_32x32' '64 icon_32x32@2x' '128 icon_128x128' '256 icon_128x128@2x' '256 icon_256x256' '512 icon_256x256@2x' '512 icon_512x512'; do
  set -- $entry
  sips -z "$1" "$1" "$master" --out "$iconset/$2.png" >/dev/null
done

mkdir -p "$(dirname "$icon_output")"
iconutil -c icns "$iconset" -o "$icon_output"
printf 'Created %s\n' "$icon_output"
