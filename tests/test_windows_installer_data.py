import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('windows_data', ROOT / 'scripts/verify-windows-data.py')
windows_data = importlib.util.module_from_spec(spec)
spec.loader.exec_module(windows_data)
path_spec = importlib.util.spec_from_file_location('native_paths', ROOT / 'scripts/verify-desktop-paths.py')
native_paths = importlib.util.module_from_spec(path_spec)
path_spec.loader.exec_module(native_paths)


class InstallerDataFixtureTests(unittest.TestCase):
    def test_native_binary_audit_detects_both_slashes_and_encodings(self):
        with tempfile.TemporaryDirectory() as folder:
            binary = Path(folder) / 'synthetic.exe'
            binary.write_bytes(b'PE\x00' + 'C:/Users/fixture/repo/main.rs'.encode('utf-8')
                               + b'\x00' + 'C:\\Users\\fixture\\repo\\main.rs'.encode('utf-16le'))
            with patch.object(native_paths.privacy, 'private_prefixes', return_value=('C:\\Users\\fixture\\repo', 'C:\\Users\\fixture')):
                self.assertGreaterEqual(native_paths.audit(binary), 2)
                binary.write_bytes(b'PE\x00/build/paperline/main.rs')
                self.assertEqual(native_paths.audit(binary), 0)

    def test_fixture_migrates_real_backend_and_detects_data_loss(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder) / '中文 data with spaces'
            directory.mkdir()
            manifest = Path(folder) / 'expected.json'
            command = [sys.executable, str(ROOT / 'desktop_backend.py')]
            windows_data.seed(command, directory, manifest)
            windows_data.verify(command, directory, manifest)
            (directory / 'state-v2.json').write_text('{}', encoding='utf-8')
            with self.assertRaisesRegex(AssertionError, 'changed synthetic'):
                windows_data.verify(None, directory, manifest)
