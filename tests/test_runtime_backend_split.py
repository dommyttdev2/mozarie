from __future__ import annotations

import os
import types
import unittest
from unittest.mock import patch

from mozarie import runtime_backends


class RuntimeBackendSplitTests(unittest.TestCase):
    def test_configured_profile_wins_for_both_stacks(self) -> None:
        ort = types.SimpleNamespace(get_available_providers=lambda: ["CUDAExecutionProvider"])
        torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True))
        with patch.dict(os.environ, {"MOZARIE_RUNTIME": "directml"}):
            self.assertEqual(runtime_backends.onnx_backend(ort_module=ort), "directml")
            self.assertEqual(runtime_backends.torch_backend(torch_module=torch), "directml")

    def test_onnx_backend_is_resolved_independently(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(runtime_backends.onnx_backend(), "cpu")
            self.assertEqual(
                runtime_backends.onnx_backend(
                    ort_module=types.SimpleNamespace(
                        get_available_providers=lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"]
                    )
                ),
                "cuda",
            )
            self.assertEqual(
                runtime_backends.onnx_backend(
                    ort_module=types.SimpleNamespace(
                        get_available_providers=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"]
                    )
                ),
                "directml",
            )
            self.assertEqual(
                runtime_backends.onnx_backend(
                    ort_module=types.SimpleNamespace(
                        get_available_providers=lambda: ["CPUExecutionProvider"]
                    )
                ),
                "cpu",
            )

    def test_torch_backend_is_resolved_independently(self) -> None:
        cuda = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True))
        no_cuda = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
        directml = types.SimpleNamespace(device_count=lambda: 2)
        no_directml = types.SimpleNamespace(device_count=lambda: 0)
        with patch.dict(os.environ, {}, clear=True):
            with patch.object(runtime_backends, "directml_module", return_value=directml):
                self.assertEqual(runtime_backends.torch_backend(torch_module=cuda), "cuda")
                self.assertEqual(runtime_backends.torch_backend(torch_module=no_cuda), "directml")
            with patch.object(runtime_backends, "directml_module", return_value=no_directml):
                self.assertEqual(runtime_backends.torch_backend(torch_module=no_cuda), "cpu")
                self.assertEqual(runtime_backends.torch_backend(), "cpu")
            for error in (ImportError(), OSError(), RuntimeError()):
                with self.subTest(error=type(error).__name__), patch.object(
                    runtime_backends, "directml_module", side_effect=error
                ):
                    self.assertEqual(runtime_backends.torch_backend(torch_module=no_cuda), "cpu")

    def test_mixed_onnx_and_torch_backends_do_not_collapse(self) -> None:
        ort = types.SimpleNamespace(get_available_providers=lambda: ["CPUExecutionProvider"])
        torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True))
        with patch.dict(os.environ, {}, clear=True), patch.object(
            runtime_backends,
            "directml_module",
            side_effect=AssertionError("CUDA should win before DirectML probing"),
        ):
            self.assertEqual(runtime_backends.onnx_backend(ort_module=ort), "cpu")
            self.assertEqual(runtime_backends.torch_backend(torch_module=torch), "cuda")


if __name__ == "__main__":
    unittest.main()
