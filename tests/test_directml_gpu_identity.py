from __future__ import annotations

from types import SimpleNamespace
import unittest
from unittest.mock import patch

from mozarie.inference import onnx as onnx_module


class DirectMlGpuIdentityTests(unittest.TestCase):
    @staticmethod
    def _directml(*names: str) -> SimpleNamespace:
        return SimpleNamespace(
            device_count=lambda: len(names),
            device_name=lambda index: names[index],
        )

    def assert_gpu_unavailable(self, callback) -> None:
        with self.assertRaises(Exception) as raised:
            callback()
        self.assertEqual(getattr(raised.exception, "error_code", None), "gpu_unavailable")

    def test_reverse_enumeration_maps_selected_physical_gpu(self) -> None:
        directml = self._directml("AMD Radeon(TM) Graphics", " AMD   Radeon RX 6600M\0 ")
        adapters = [
            SimpleNamespace(index=0, name="amd radeon rx 6600m"),
            SimpleNamespace(index=1, name="AMD Radeon(TM) Graphics"),
        ]
        with patch("mozarie.inference.onnx.directml_module", return_value=directml), \
             patch("mozarie.inference.onnx._dxgi_adapter_names", return_value=adapters):
            self.assertEqual(onnx_module._directml_onnx_device_id(1), 0)

    def test_directml_identity_acquisition_failure_fails_closed(self) -> None:
        with patch("mozarie.inference.onnx.directml_module", side_effect=ImportError("torch-directml unavailable")):
            self.assert_gpu_unavailable(lambda: onnx_module._directml_onnx_device_id(0))

    def test_invalid_logical_device_id_fails_closed(self) -> None:
        directml = self._directml("GPU 0", "GPU 1")
        with patch("mozarie.inference.onnx.directml_module", return_value=directml):
            self.assert_gpu_unavailable(lambda: onnx_module._directml_onnx_device_id(2))

    def test_empty_dxgi_enumeration_fails_closed(self) -> None:
        directml = self._directml("GPU 0")
        with patch("mozarie.inference.onnx.directml_module", return_value=directml), \
             patch("mozarie.inference.onnx._dxgi_adapter_names", return_value=[]):
            self.assert_gpu_unavailable(lambda: onnx_module._directml_onnx_device_id(0))

    def test_name_mismatch_fails_closed(self) -> None:
        directml = self._directml("Selected GPU")
        adapters = [SimpleNamespace(index=0, name="Different GPU")]
        with patch("mozarie.inference.onnx.directml_module", return_value=directml), \
             patch("mozarie.inference.onnx._dxgi_adapter_names", return_value=adapters):
            self.assert_gpu_unavailable(lambda: onnx_module._directml_onnx_device_id(0))

    def test_duplicate_dxgi_name_fails_closed(self) -> None:
        directml = self._directml("AMD Radeon RX 6600M")
        adapters = [
            SimpleNamespace(index=0, name="AMD Radeon RX 6600M"),
            SimpleNamespace(index=2, name="AMD Radeon RX 6600M"),
        ]
        with patch("mozarie.inference.onnx.directml_module", return_value=directml), \
             patch("mozarie.inference.onnx._dxgi_adapter_names", return_value=adapters):
            self.assert_gpu_unavailable(lambda: onnx_module._directml_onnx_device_id(0))


if __name__ == "__main__":
    unittest.main()
