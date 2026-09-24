#!/bin/sh
project_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)" || exit 1
"$project_dir/PaperLine.app/Contents/MacOS/PaperLine" --stop
printf '\n按回车键关闭此窗口…'
read -r _
