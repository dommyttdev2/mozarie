from __future__ import annotations

import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import setup_gpu_check


class SetupGpuCheckTests(unittest.TestCase):
    def test_missing_or_unusable_gpu_uses_cpu_without_a_traceback(self) -> None:
        ort = types.SimpleNamespace(get_available_providers=lambda: [], datasets=types.SimpleNamespace())
        torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
        output = io.StringIO()
        with patch.dict(sys.modules, {"numpy": types.SimpleNamespace(), "onnxruntime": ort, "torch": torch}), contextlib.redirect_stdout(output):
            self.assertEqual(setup_gpu_check.main(), 0)
        self.assertEqual(output.getvalue().strip(), setup_gpu_check.CPU_MESSAGE)
        self.assertNotIn("Traceback", output.getvalue())

    def test_cuda_session_is_run_before_gpu_is_reported_ready(self) -> None:
        calls: list[object] = []
        session = types.SimpleNamespace(
            disable_fallback=lambda: calls.append("disable_fallback"),
            get_providers=lambda: ["CUDAExecutionProvider"],
            run=lambda _outputs, inputs: calls.append(inputs),
        )
        ort = types.SimpleNamespace(
            get_available_providers=lambda: ["CUDAExecutionProvider"],
            InferenceSession=lambda path, providers: calls.append((path, providers)) or session,
            datasets=types.SimpleNamespace(get_example=lambda name: f"fixture/{name}"),
        )
        torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True))
        numpy = types.SimpleNamespace(float32="float32", ones=lambda shape, dtype: (shape, dtype))
        output = io.StringIO()
        with patch.dict(sys.modules, {"numpy": numpy, "onnxruntime": ort, "torch": torch}), contextlib.redirect_stdout(output):
            self.assertEqual(setup_gpu_check.main(), 0)
        self.assertEqual(calls, [("fixture/mul_1.onnx", ["CUDAExecutionProvider"]), "disable_fallback", {"X": ((3, 2), "float32")}])
        self.assertEqual(output.getvalue().strip(), "[Mozarie] GPU is ready.")

    @unittest.skipUnless(os.name == "nt" and shutil.which("py"), "requires the Windows Python launcher")
    def test_fresh_venv_pip_dry_run_keeps_resolver_output_visible(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            created = subprocess.run(["py", "-3.14-64", "-m", "venv", str(root / "venv")], capture_output=True, text=True, check=False, timeout=120)
            self.assertEqual(created.returncode, 0, created.stdout + created.stderr)
            python = root / "venv" / "Scripts" / "python.exe"
            result = subprocess.run(
                [str(python), "-m", "pip", "install", "--progress-bar", "on", "--dry-run", "--no-deps", "humanize==4.15.0"],
                capture_output=True, text=True, check=False, timeout=120,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertRegex(result.stdout, r"(?m)^(Looking in indexes:|Collecting|Would install) ")


if __name__ == "__main__":
    unittest.main()
