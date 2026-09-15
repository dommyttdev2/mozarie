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
