import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

def script(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'scripts' / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

version = script('desktop-version')
installer = script('install-macos')

class PlatformVersionTests(unittest.TestCase):
    def test_platforms_have_independent_versions(self):
        self.assertEqual(version.platform_version('macos'), '0.3.10')
        self.assertEqual(version.platform_version('windows'), '0.3.0')

@unittest.skipUnless(sys.platform == 'darwin', 'macOS filesystem exchange API')
class AtomicInstallTests(unittest.TestCase):
    def fixture(self, root):
        staged, installed = root / 'staged', root / 'installed'
        staged.mkdir(); installed.mkdir()
        (staged / 'version').write_text('new')
        (installed / 'version').write_text('old')
        return staged, installed

    def test_exchange_commits_new_bundle_without_removing_old_recovery_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            staged, installed = self.fixture(Path(directory))
            installer.replace_staged(staged, installed, lambda _: None)
            self.assertEqual((installed / 'version').read_text(), 'new')
            self.assertEqual((staged / 'version').read_text(), 'old')

    def test_failed_verification_atomically_restores_previous_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            staged, installed = self.fixture(Path(directory))
            def reject(_):
                raise ValueError('signature changed')
            with self.assertRaisesRegex(ValueError, 'signature changed'):
                installer.replace_staged(staged, installed, reject)
            self.assertEqual((installed / 'version').read_text(), 'old')
            self.assertEqual((staged / 'version').read_text(), 'new')
