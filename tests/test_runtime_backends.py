from __future__ import annotations

import os
import types
import unittest
from unittest.mock import patch

from mozarie.runtime import directml_devices, runtime_backend, torch_device


class RuntimeBackendTests(unittest.TestCase):
    def test_explicit_runtime_wins_over_detected_providers(self) -> None:
        ort = types.SimpleNamespace(get_available_providers=lambda: ["CUDAExecutionProvider"])
        with patch.dict(os.environ, {"MOZARIE_RUNTIME": "directml"}):
            self.assertEqual(runtime_backend(ort_module=ort), "directml")

    def test_provider_detection_preserves_cuda_and_adds_directml(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            cuda = types.SimpleNamespace(get_available_providers=lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"])
            directml = types.SimpleNamespace(get_available_providers=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"])
            self.assertEqual(runtime_backend(ort_module=cuda), "cuda")
            self.assertEqual(runtime_backend(ort_module=directml), "directml")

    def test_directml_devices_strip_native_null_terminators(self) -> None:
        module = types.SimpleNamespace(
            device_count=lambda: 2,
            device_name=lambda index: ["AMD Radeon Graphics\0", "AMD Radeon RX 6600M\0"][index],
        )
        self.assertEqual(directml_devices(module), [
            {"id": 0, "name": "AMD Radeon Graphics", "backend": "directml", "supported": True},
            {"id": 1, "name": "AMD Radeon RX 6600M", "backend": "directml", "supported": True},
        ])

    def test_torch_device_keeps_cuda_and_uses_directml_device_object(self) -> None:
        torch = types.SimpleNamespace(device=lambda value: f"torch:{value}")
        self.assertEqual(torch_device(torch, "gpu", 2, backend="cuda"), "cuda:2")
        directml = types.SimpleNamespace(device=lambda index: ("dml", index))
        with patch("mozarie.runtime.directml_module", return_value=directml):
            self.assertEqual(torch_device(torch, "gpu", 1, backend="directml"), ("dml", 1))
        self.assertEqual(torch_device(torch, "cpu", 9, backend="directml"), "cpu")


if __name__ == "__main__":
    unittest.main()
