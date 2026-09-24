#!/bin/sh
project_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)" || exit 1
exec "$project_dir/PaperLine.app/Contents/MacOS/PaperLine" --foreground
