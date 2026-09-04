from __future__ import annotations

import os
import types
import unittest
from unittest.mock import patch

from mozarie import runtime_backends


class RuntimeBackendSplitTests(unittest.TestCase):
    def test_configured_profile_maps_each_stack_explicitly(self) -> None:
        ort = types.SimpleNamespace(get_available_providers=lambda: ["CUDAExecutionProvider"])
        torch = types.SimpleNamespace(
            version=types.SimpleNamespace(hip=None),
            cuda=types.SimpleNamespace(is_available=lambda: True),
        )
        expected = {
            "cuda": ("cuda", "cuda"),
            "directml": ("directml", "directml"),
            "cpu": ("cpu", "cpu"),
            "rocm": ("directml", "rocm"),
        }
        for profile, stack_backends in expected.items():
            with self.subTest(profile=profile), patch.dict(
                os.environ, {"MOZARIE_RUNTIME": profile}, clear=True
            ):
                self.assertEqual(runtime_backends.configured_profile(), profile)
                self.assertEqual(runtime_backends.onnx_backend(ort_module=ort), stack_backends[0])
                self.assertEqual(runtime_backends.torch_backend(torch_module=torch), stack_backends[1])
        with patch.dict(os.environ, {"MOZARIE_RUNTIME": "invalid"}, clear=True):
            self.assertIsNone(runtime_backends.configured_profile())

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

    def test_torch_backend_distinguishes_rocm_cuda_directml_and_cpu(self) -> None:
        rocm = types.SimpleNamespace(
            version=types.SimpleNamespace(hip="7.13"),
            cuda=types.SimpleNamespace(is_available=lambda: True),
        )
        cuda = types.SimpleNamespace(
            version=types.SimpleNamespace(hip=None),
            cuda=types.SimpleNamespace(is_available=lambda: True),
        )
        no_cuda = types.SimpleNamespace(
            version=types.SimpleNamespace(hip=None),
            cuda=types.SimpleNamespace(is_available=lambda: False),
        )
        directml = types.SimpleNamespace(device_count=lambda: 2)
        no_directml = types.SimpleNamespace(device_count=lambda: 0)
        with patch.dict(os.environ, {}, clear=True):
            with patch.object(
                runtime_backends,
                "directml_module",
                side_effect=AssertionError("HIP/CUDA must win before DirectML probing"),
            ):
                self.assertEqual(runtime_backends.torch_backend(torch_module=rocm), "rocm")
                self.assertEqual(runtime_backends.torch_backend(torch_module=cuda), "cuda")
            with patch.object(runtime_backends, "directml_module", return_value=directml):
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
        ort = types.SimpleNamespace(
            get_available_providers=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"]
        )
        torch = types.SimpleNamespace(
            version=types.SimpleNamespace(hip="7.13"),
            cuda=types.SimpleNamespace(is_available=lambda: True),
        )
        with patch.dict(os.environ, {}, clear=True), patch.object(
            runtime_backends,
            "directml_module",
            side_effect=AssertionError("ROCm should win before DirectML probing"),
        ):
            self.assertEqual(runtime_backends.onnx_backend(ort_module=ort), "directml")
            self.assertEqual(runtime_backends.torch_backend(torch_module=torch), "rocm")


if __name__ == "__main__":
    unittest.main()
