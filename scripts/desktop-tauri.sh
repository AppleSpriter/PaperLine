#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.desktop-tools/cargo/bin:$PATH"
if [[ -d .desktop-tools/rustup ]]; then
  export CARGO_HOME="$PWD/.desktop-tools/cargo"
  export RUSTUP_HOME="$PWD/.desktop-tools/rustup"
fi
# Cargo's encoded form keeps a remap path containing spaces as a single argument.
# Existing encoded flags retain Cargo's precedence over RUSTFLAGS.
export CARGO_ENCODED_RUSTFLAGS="$(python3 - <<'PYFLAGS'
import os
from pathlib import Path
separator = chr(31)
if "CARGO_ENCODED_RUSTFLAGS" in os.environ:
    existing = os.environ["CARGO_ENCODED_RUSTFLAGS"]
    flags = existing.split(separator) if existing else []
else:
    flags = os.environ.get("RUSTFLAGS", "").split()
flags.append(f"--remap-path-prefix={Path.home()}=/build")
print(separator.join(flags))
PYFLAGS
)"
exec ./node_modules/.bin/tauri "$@"
