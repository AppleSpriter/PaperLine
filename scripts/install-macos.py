#!/usr/bin/env python3
"""Replace the sole installed PaperLine bundle with an archived rollback copy."""
import argparse
import ctypes
import datetime
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile
import zipfile

BUNDLE_ID = 'io.github.applespriter.paperline'
DESTINATION = Path('/Applications/PaperLine.app')


def validate_bundle(bundle: Path) -> str:
    info = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != BUNDLE_ID:
        raise ValueError('Refusing a bundle with an unexpected identifier.')
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(bundle)], check=True)
    version = str(info['CFBundleShortVersionString'])
    if not re.fullmatch(r'[0-9A-Za-z.+-]+', version):
        raise ValueError('The bundle version is invalid.')
    return version


def require_quit() -> None:
    # Never terminate the app or its work: the user must quit through the UI.
    result = subprocess.run(['pgrep', '-x', 'paperline'], capture_output=True)
    if result.returncode == 0:
        raise ValueError('PaperLine is running. Quit PaperLine normally, then run installation again.')
    if result.returncode != 1:
        raise RuntimeError('Cannot determine whether PaperLine is running.')


def atomic_swap(first: Path, second: Path) -> None:
    # macOS RENAME_SWAP exchanges two same-volume entries in one filesystem operation.
    library = ctypes.CDLL(None, use_errno=True)
    swap = library.renameatx_np
    swap.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    swap.restype = ctypes.c_int
    if swap(-2, os.fsencode(first), -2, os.fsencode(second), 2) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def replace_staged(staged: Path, destination: Path, verify=validate_bundle) -> None:
    previous = destination.exists()
    if previous:
        atomic_swap(staged, destination)
    else:
        staged.rename(destination)
    try:
        verify(destination)
    except BaseException:
        if previous:
            atomic_swap(staged, destination)
        else:
            destination.rename(staged)
        raise


def install(source: Path, backup_dir: Path) -> Path | None:
    if sys.platform != 'darwin':
        raise ValueError('Installation requires macOS.')
    source = source.resolve(strict=True)
    if source == DESTINATION:
        raise ValueError('Choose the new build bundle as the source.')
    version = validate_bundle(source)
    require_quit()
    backup = None
    if DESTINATION.exists():
        previous = validate_bundle(DESTINATION)
        backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
        backup = backup_dir / f'PaperLine-{previous}-{stamp}.app.zip'
        subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(DESTINATION), str(backup)], check=True)
        with zipfile.ZipFile(backup) as archive:
            if archive.testzip() is not None:
                raise ValueError('The rollback archive failed verification.')
    # Staging beside the destination guarantees an atomic exchange on its volume.
    with tempfile.TemporaryDirectory(prefix='.PaperLine-install-', dir=DESTINATION.parent) as directory:
        staged = Path(directory) / 'PaperLine.app'
        subprocess.run(['ditto', str(source), str(staged)], check=True)
        validate_bundle(staged)
        require_quit()
        replace_staged(staged, DESTINATION)
    print(f'Installed PaperLine {version} at /Applications/PaperLine.app')
    if backup:
        print(f'Recovery archive: {backup}')
    return backup


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='A verified new build or a recovered native app bundle')
    args = parser.parse_args()
    try:
        install(args.source, Path(__file__).resolve().parent.parent / '.desktop-build/install-backups')
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f'Installation stopped: {error}', file=sys.stderr)
        raise SystemExit(1)
