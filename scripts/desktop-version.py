#!/usr/bin/env python3
"""Resolve the platform override used by Tauri without coupling app versions."""
import argparse
import json
from pathlib import Path


def platform_version(platform: str, root: Path | None = None) -> str:
    root = root or Path(__file__).resolve().parent.parent
    config = json.loads((root / 'src-tauri/tauri.conf.json').read_text())
    override = root / f'src-tauri/tauri.{platform}.conf.json'
    if override.is_file():
        config.update(json.loads(override.read_text()))
    return config['version']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('platform', choices=['macos', 'windows'])
    print(platform_version(parser.parse_args().platform))
