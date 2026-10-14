import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("desktop_build_privacy", Path(__file__).resolve().parents[1] / "scripts" / "desktop-build-privacy.py")
privacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(privacy)


class DesktopBuildPrivacyTests(unittest.TestCase):
    def test_sanitize_keeps_sysconfig_values_and_removes_nested_build_paths(self):
        code = compile("build_time_vars = {'prefix': '/private/developer/project/runtime', 'count': 13}\ndef nested():\n    return ('/private/developer/tools', 42)\n", "/private/developer/project/module.py", "exec")
        cleaned = privacy.sanitized_code(code, ("/private/developer/project", "/private/developer"))
        namespace = {}
        exec(cleaned, namespace)
        self.assertEqual(namespace["build_time_vars"], {"prefix": "/build/paperline/runtime", "count": 13})
        self.assertEqual(namespace["nested"](), ("/build/tools", 42))
        self.assertEqual(cleaned.co_filename, "/build/paperline/module.py")

    def test_code_cache_is_required_and_only_sysconfig_modules_are_changed(self):
        pure = [("_sysconfigdata_test", "config.py", "PYMODULE"), ("app", "app.py", "PYMODULE")]
        original = compile("prefix = '/private/developer/runtime'", "module.py", "exec")
        config = types.ModuleType("PyInstaller.config")
        installer = types.ModuleType("PyInstaller")
        with patch.dict(sys.modules, {"PyInstaller": installer, "PyInstaller.config": config}):
            config.CONF = {}
            with self.assertRaises(RuntimeError):
                privacy.sanitize_analysis(pure, ("/private/developer/project", "/private/developer"))
            cache = {"_sysconfigdata_test": original, "app": original}
            config.CONF = {"code_cache": {id(pure): cache}}
            privacy.sanitize_analysis(pure, ("/private/developer/project", "/private/developer"))
            self.assertIs(cache["app"], original)
            namespace = {}
            exec(cache["_sysconfigdata_test"], namespace)
            self.assertEqual(namespace["prefix"], "/build/runtime")

    def test_spec_injects_cleaning_before_pyz_and_rejects_unknown_layout(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "backend.spec"
            output = Path(folder) / "backend.privacy.spec"
            source.write_text("a = Analysis([])\npyz = PYZ(a.pure)\n", encoding="utf-8")
            privacy.prepare_spec(source, output)
            text = output.read_text(encoding="utf-8")
            self.assertLess(text.index("sanitize_analysis"), text.index("pyz = PYZ"))
            source.write_text("unknown layout", encoding="utf-8")
            with self.assertRaises(ValueError):
                privacy.prepare_spec(source, output)


if __name__ == "__main__":
    unittest.main()
