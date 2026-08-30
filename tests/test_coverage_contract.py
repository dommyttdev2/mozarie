from __future__ import annotations

import configparser
import unittest
from pathlib import Path


class CoverageContractTests(unittest.TestCase):
    def test_branch_coverage_includes_root_runtime_entrypoints(self) -> None:
        config = configparser.ConfigParser()
        config.read(Path(__file__).resolve().parents[1] / ".coveragerc", encoding="utf-8")
        sources = {line.strip() for line in config["run"]["source"].splitlines() if line.strip()}
        self.assertTrue(config.getboolean("run", "branch"))
        self.assertTrue({"mozarie", "server", "updater", "setup_gpu_check"}.issubset(sources))
        self.assertEqual(config.getint("report", "fail_under"), 100)
