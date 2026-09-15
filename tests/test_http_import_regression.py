"""Regression coverage for loading the HTTP request handler module."""

import ast
import importlib
from pathlib import Path
import unittest


class HttpImportRegressionTests(unittest.TestCase):
    def test_http_module_parses_and_imports(self) -> None:
        source = (Path(__file__).parents[1] / "mozarie" / "http.py").read_text(encoding="utf-8")
        ast.parse(source)
        importlib.import_module("mozarie.http")

    def test_import_and_thumbnail_paths_do_not_add_fixed_global_gates(self) -> None:
        root = Path(__file__).parents[1]
        sources = {
            "core": (root / "mozarie" / "core.py").read_text(encoding="utf-8"),
            "state": (root / "mozarie" / "state.py").read_text(encoding="utf-8"),
            "http": (root / "mozarie" / "http.py").read_text(encoding="utf-8"),
        }
        for gate in ("import_staging_gate", "thumbnail_gate", "THUMBNAIL_WORKERS", "thumbnail_generation_lock"):
            self.assertFalse(any(gate in source for source in sources.values()), gate)
        self.assertIn("with STATE.image_io_lock(image_id):", sources["http"])
        self.assertEqual(sources["http"].count("if not thumbnail_path.is_file():"), 1)
