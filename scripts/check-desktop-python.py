#!/usr/bin/env python3
"""Reject Python runtimes newer than PaperLine's advertised macOS minimum."""
import json
import pathlib
import re
import subprocess
import sys
import sysconfig

root = pathlib.Path(__file__).resolve().parent.parent
minimum = json.loads((root / "src-tauri/tauri.conf.json").read_text())["bundle"]["macOS"]["minimumSystemVersion"]

def version(value):
    parts = tuple(int(part) for part in str(value).split("."))
    return parts + (0,) * (3 - len(parts))

candidates = [pathlib.Path(sys.executable).resolve()]
try:
    # This is the exact shared library PyInstaller will collect.
    from PyInstaller.depend.bindepend import get_python_library_path
    library = get_python_library_path()
    if library:
        candidates.append(pathlib.Path(library).resolve())
except ImportError:
    pass
library_dir, library_name = sysconfig.get_config_var("LIBDIR"), sysconfig.get_config_var("LDLIBRARY")
if library_dir and library_name:
    candidates.append(pathlib.Path(library_dir) / library_name)
framework_prefix = sysconfig.get_config_var("PYTHONFRAMEWORKPREFIX")
framework = sysconfig.get_config_var("PYTHONFRAMEWORK")
if framework_prefix and framework:
    candidates.append(pathlib.Path(framework_prefix) / f"{framework}.framework" / "Versions" / sysconfig.get_config_var("VERSION") / framework)

checked = set()
for candidate in candidates:
    if not candidate.is_file() or candidate.resolve() in checked:
        continue
    checked.add(candidate.resolve())
    output = subprocess.check_output(["otool", "-arch", "arm64", "-l", str(candidate)], text=True)
    versions = re.findall(r"\bminos\s+([\d.]+)", output)
    versions += re.findall(r"cmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version ([\d.]+)", output)
    if not versions:
        raise SystemExit(f"Cannot verify macOS deployment target of Python binary: {candidate}")
    required = max(versions, key=version)
    if version(required) > version(minimum):
        raise SystemExit(
            f"Python binary requires macOS {required}, but PaperLine targets macOS {minimum}:\n{candidate}\n"
            "Use a compatible relocatable Python via PAPERLINE_PYTHON, then recreate .desktop-tools/venv. "
            "The application minimum must cover its bundled runtime."
        )
    print(f"Python macOS compatibility: {candidate.name} requires {required} <= {minimum}")
if len(checked) < 2:
    raise SystemExit("Cannot locate the Python shared library for macOS compatibility verification. Install PyInstaller in the desktop build environment first.")
