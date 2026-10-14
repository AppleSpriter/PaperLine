#!/usr/bin/env python3
"""Sanitize build paths before PYZ compression and audit the finished sidecar."""
from __future__ import annotations

import argparse
import io
import json
import marshal
from pathlib import Path
import types
import zipfile


def private_prefixes() -> tuple[str, ...]:
    # Most specific first; no developer identity is stored in shared source.
    return (str(Path(__file__).resolve().parent.parent), str(Path.home()))


def sanitized_code(code: types.CodeType, prefixes: tuple[str, ...]) -> types.CodeType:
    def sanitize(value):
        if isinstance(value, types.CodeType):
            return sanitized_code(value, prefixes)
        if isinstance(value, str):
            for prefix in prefixes:
                value = value.replace(prefix, "/build/paperline" if prefix == prefixes[0] else "/build")
            return value
        if isinstance(value, tuple):
            return tuple(sanitize(item) for item in value)
        if isinstance(value, frozenset):
            return frozenset(sanitize(item) for item in value)
        return value
    return code.replace(co_filename=sanitize(code.co_filename), co_consts=tuple(sanitize(value) for value in code.co_consts))


def sanitize_analysis(pure_toc, prefixes: tuple[str, ...]) -> None:
    from PyInstaller.config import CONF
    mapping = CONF.get("code_cache")
    if not isinstance(mapping, dict) or not isinstance(mapping.get(id(pure_toc)), dict):
        raise RuntimeError("Unsupported PyInstaller code-cache API; refusing an unauditable build")
    cache = mapping[id(pure_toc)]
    modules = [name for name, _, _ in pure_toc if name.startswith("_sysconfigdata")]
    for name in modules:
        code = cache.get(name)
        if not isinstance(code, types.CodeType):
            raise RuntimeError("PyInstaller sysconfig code object unavailable; refusing build")
        cache[name] = sanitized_code(code, prefixes)


def prepare_spec(spec: Path, output: Path) -> None:
    source = spec.read_text(encoding="utf-8")
    marker = "pyz = PYZ(a.pure)"
    if source.count(marker) != 1:
        raise ValueError("Unsupported PyInstaller spec layout; refusing build")
    helper = Path(__file__).resolve()
    insertion = (
        "import importlib.util as _privacy_import\n"
        f"_privacy_spec = _privacy_import.spec_from_file_location('desktop_build_privacy', {str(helper)!r})\n"
        "_privacy = _privacy_import.module_from_spec(_privacy_spec)\n"
        "_privacy_spec.loader.exec_module(_privacy)\n"
        f"_privacy.sanitize_analysis(a.pure, {private_prefixes()!r})\n"
    )
    output.write_text(source.replace(marker, insertion + marker), encoding="utf-8")


def audit_archive(binary: Path) -> dict[str, int]:
    from PyInstaller.archive.readers import CArchiveReader
    prefixes = private_prefixes()
    counters = {"archiveEntries": 0, "pyzModules": 0, "zipMembers": 0, "codeObjects": 0,
                "privatePathOccurrences": 0, "sensitiveDataEntries": 0}
    archive = CArchiveReader(str(binary))

    def inspect(value):
        if isinstance(value, types.CodeType):
            counters["codeObjects"] += 1
            inspect(value.co_filename)
            for item in value.co_consts:
                inspect(item)
        elif isinstance(value, str):
            counters["privatePathOccurrences"] += sum(value.count(prefix) for prefix in prefixes)
        elif isinstance(value, bytes):
            counters["privatePathOccurrences"] += sum(value.count(prefix.encode("utf-8")) + value.count(prefix.encode("utf-16le")) for prefix in prefixes)
        elif isinstance(value, (tuple, list, set, frozenset)):
            for item in value:
                inspect(item)
        elif isinstance(value, dict):
            for key, item in value.items():
                inspect(key)
                inspect(item)

    for name, entry in archive.toc.items():
        counters["archiveEntries"] += 1
        if Path(name).name in {"state.json", "webdav.json", "state.backup.json", ".env"}:
            counters["sensitiveDataEntries"] += 1
        data = archive.extract(name)
        inspect(data)
        if entry[-1] in ("s", "m"):
            inspect(marshal.loads(data))
        elif entry[-1] == "z":
            pyz = archive.open_embedded_archive(name)
            counters["pyzModules"] += len(pyz.toc)
            for module in pyz.toc:
                inspect(pyz.extract(module))
        elif name.endswith(".zip"):
            with zipfile.ZipFile(io.BytesIO(data)) as zipped:
                counters["zipMembers"] += len(zipped.namelist())
                for member in zipped.namelist():
                    content = zipped.read(member)
                    inspect(content)
                    if member.endswith(".pyc"):
                        inspect(marshal.loads(content[16:]))
    inspect(binary.read_bytes())
    return counters


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="operation", required=True)
    prepare = subparsers.add_parser("prepare")
    prepare.add_argument("--spec", type=Path, required=True)
    prepare.add_argument("--output", type=Path, required=True)
    audit = subparsers.add_parser("audit")
    audit.add_argument("binary", type=Path)
    args = parser.parse_args()
    if args.operation == "prepare":
        prepare_spec(args.spec, args.output)
    else:
        counters = audit_archive(args.binary)
        print(json.dumps(counters, sort_keys=True))  # Counts only, never private matches.
        if counters["privatePathOccurrences"] or counters["sensitiveDataEntries"]:
            raise SystemExit("Desktop sidecar privacy audit failed; do not publish this artifact")


if __name__ == "__main__":
    main()
