#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.desktop-tools/cargo/bin:$PATH"
if [[ -d .desktop-tools/rustup ]]; then
  export CARGO_HOME="$PWD/.desktop-tools/cargo"
  export RUSTUP_HOME="$PWD/.desktop-tools/rustup"
fi
exec ./node_modules/.bin/tauri "$@"
