import importlib.util
import marshal
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
    def test_windows_path_variants_keep_repository_mapping_in_nested_code(self):
        repository = r"C:\Users\example\project"
        home = r"C:\Users\example"
        repository_forward = repository.replace("\\", "/")
        home_forward = home.replace("\\", "/")
        source = (f"build_time_vars = {{'prefix': {repository_forward + '/runtime'!r}, 'home': {home + '/tools'!r}}}\n"
                  f"def nested():\n    return ({repository + '/module'!r}, {home_forward + '/cache'!r}, 42)\n")
        code = compile(source, repository_forward + "/config.py", "exec")
        cleaned = privacy.sanitized_code(code, (repository, home))
        namespace = {}
        exec(cleaned, namespace)
        self.assertEqual(namespace["build_time_vars"], {"prefix": "/build/paperline/runtime", "home": "/build/tools"})
        self.assertEqual(namespace["nested"](), ("/build/paperline/module", "/build/cache", 42))
        self.assertEqual(cleaned.co_filename, "/build/paperline/config.py")
        self.assertEqual(namespace["nested"].__code__.co_filename, "/build/paperline/config.py")

    def test_archive_audit_detects_windows_variants_nested_code_and_data_names(self):
        repository = r"C:\Users\example\project"
        home = r"C:\Users\example"
        home_forward = home.replace("\\", "/")
        source = f"def nested():\n    return {home_forward + '/tools'!r}\n"
        code = compile(source, repository + "/config.py", "exec")
        reader = types.ModuleType("PyInstaller.archive.readers")

        class Archive:
            toc = {r"data\state-v2.json": ("x",), "script": ("s",), "modules.pyz": ("z",)}

            def __init__(self, _binary):
                pass

            def extract(self, name):
                return marshal.dumps(code) if name == "script" else b"{}"

            def open_embedded_archive(self, _name):
                return types.SimpleNamespace(toc={"module": None}, extract=lambda _: code)

        reader.CArchiveReader = Archive
        with tempfile.TemporaryDirectory() as folder:
            binary = Path(folder) / "backend.exe"
            binary.write_bytes(b"")
            with patch.dict(sys.modules, {"PyInstaller.archive.readers": reader}), patch.object(privacy, "private_prefixes", return_value=(repository, home)):
                counters = privacy.audit_archive(binary)
                for prefix in (repository, repository.replace("\\", "/"), home, home_forward):
                    for encoding in ("utf-8", "utf-16le"):
                        with self.subTest(prefix=prefix, encoding=encoding):
                            binary.write_bytes((prefix + "/runtime").encode(encoding))
                            self.assertGreater(privacy.audit_archive(binary)["privatePathOccurrences"], counters["privatePathOccurrences"])
        self.assertEqual(counters["sensitiveDataEntries"], 1)
        self.assertEqual(counters["codeObjects"], 4)
        self.assertGreaterEqual(counters["privatePathOccurrences"], 6)

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
