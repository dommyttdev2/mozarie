from __future__ import annotations

import os
import types
import unittest
from unittest.mock import patch

from mozarie import runtime


class RocmRuntimeCompatibilityTests(unittest.TestCase):
    def test_rocm_profile_routes_onnx_and_torch_independently(self) -> None:
        ort = types.SimpleNamespace(get_available_providers=lambda: ["DmlExecutionProvider"])
        torch = types.SimpleNamespace(
            version=types.SimpleNamespace(hip="7.13", cuda=None),
            cuda=types.SimpleNamespace(is_available=lambda: True),
        )
        with patch.dict(os.environ, {"MOZARIE_RUNTIME": "rocm"}):
            self.assertEqual(runtime.configured_backend(), "rocm")
            self.assertEqual(runtime.runtime_backend(ort_module=ort), "directml")
            self.assertEqual(runtime.runtime_backend(torch_module=torch), "rocm")
            self.assertEqual(runtime.runtime_backend(), "rocm")

    def test_hip_torch_is_detected_as_rocm_without_explicit_profile(self) -> None:
        torch = types.SimpleNamespace(
            version=types.SimpleNamespace(hip="7.13", cuda=None),
            cuda=types.SimpleNamespace(is_available=lambda: True),
        )
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(runtime.runtime_backend(torch_module=torch), "rocm")

    def test_rocm_uses_pytorch_cuda_device_api(self) -> None:
        torch = types.SimpleNamespace()
        self.assertEqual(runtime.torch_device(torch, "gpu", 3, backend="rocm"), "cuda:3")
        self.assertEqual(runtime.torch_device(torch, "cpu", 3, backend="rocm"), "cpu")


if __name__ == "__main__":
    unittest.main()
