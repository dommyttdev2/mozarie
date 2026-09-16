from __future__ import annotations

import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mozarie.http import health_device


class RuntimeContractTests(unittest.TestCase):
    def test_release_archive_excludes_development_only_files(self):
        root = Path(__file__).resolve().parents[1]
        attributes = (root / ".gitattributes").read_text(encoding="utf-8")
        for path in ("/.github export-ignore", "/.coveragerc export-ignore", "/tests export-ignore", "/scripts export-ignore", "/package.json export-ignore", "/package-lock.json export-ignore", "/requirements-test.txt export-ignore"):
            self.assertIn(path, attributes)
        self.assertIn("output/", (root / ".gitignore").read_text(encoding="utf-8"))

    def test_health_cpu_does_not_expose_or_need_a_gpu(self):
        self.assertEqual(health_device("cpu", 7, []), {"provider": "cpu", "runtimeBackend": "cpu", "gpuDevice": None, "device": "CPU"})

    def test_health_uses_the_selected_gpu_index(self):
        self.assertEqual(
            health_device("gpu", 1, [{"id": 0, "name": "first"}, {"id": 1, "name": "second"}]),
            {"provider": "gpu", "runtimeBackend": "cuda", "gpuDevice": 1, "gpuName": "second", "device": "GPU 1: second"},
        )


if __name__ == "__main__":
    unittest.main()
