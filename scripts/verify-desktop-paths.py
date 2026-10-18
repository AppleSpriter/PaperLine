#!/usr/bin/env python3
"""Reject private build paths in native binaries without printing matched values."""
import argparse
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('desktop_privacy', Path(__file__).with_name('desktop-build-privacy.py'))
privacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(privacy)


def audit(binary: Path) -> int:
    content = binary.read_bytes()
    return sum(content.count(prefix.encode(encoding)) for prefix, _ in privacy.path_replacements(privacy.private_prefixes())
               for encoding in ('utf-8', 'utf-16le'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    args = parser.parse_args()
    count = audit(args.binary)
    print(f'Native binary private build path occurrences: {count}')
    if count:
        raise SystemExit('Private build path audit failed; do not publish this artifact')
