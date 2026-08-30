from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class RuntimeProfileSubprocessTests(unittest.TestCase):
    def test_module_execution_avoids_the_app_http_module_shadow(self) -> None:
        """The batch/updater form must keep stdlib http ahead of mozarie/http.py."""
        source_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "app"
            package = app / "mozarie"
            package.mkdir(parents=True)
            shutil.copy2(source_root / "mozarie" / "runtime_profile.py", package / "runtime_profile.py")
            (package / "http.py").write_text("raise RuntimeError('app http was imported')\n", encoding="utf-8")
            site = app / "site"
            site.mkdir()
            (site / "onnxruntime.py").write_text(
                "from http import HTTPStatus\n"
                "def get_available_providers(): return ['CPUExecutionProvider']\n",
                encoding="utf-8",
            )
            metadata = site / "onnxruntime-1.0.dist-info"
            metadata.mkdir()
            (metadata / "METADATA").write_text("Name: onnxruntime\nVersion: 1.0\n", encoding="utf-8")
            environment = os.environ | {"PYTHONPATH": str(site)}
            command = [sys.executable, "-S", "-m", "mozarie.runtime_profile", "preflight", "cpu", "--venv", str(app / ".venv")]
            result = subprocess.run(command, cwd=app, env=environment, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            direct = subprocess.run(
                [sys.executable, "-S", str(package / "runtime_profile.py"), "preflight", "cpu", "--venv", str(app / ".venv")],
                cwd=app, env=environment, capture_output=True, text=True, encoding="utf-8",
            )
            self.assertNotEqual(direct.returncode, 0, direct.stdout + direct.stderr)
            self.assertIn("app http was imported", direct.stderr)


if __name__ == "__main__":
    unittest.main()
