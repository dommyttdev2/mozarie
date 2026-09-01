from __future__ import annotations

from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from mozarie import runtime as runtime_module
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
        directml = self._directml("AMD Radeon(TM) Graphics", " AMD   Radeon RX 6600M\0")
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

    def test_dxgi_not_found_is_the_only_normal_enumeration_end(self) -> None:
        adapter = object()
        enum_adapter = Mock(side_effect=[(0, adapter), (runtime_module._DXGI_ERROR_NOT_FOUND, None)])
        describe_adapter = Mock(return_value=(0, "GPU 0\0"))
        release_adapter = Mock()

        self.assertEqual(
            runtime_module._enumerate_dxgi_adapter_names(enum_adapter, describe_adapter, release_adapter),
            [runtime_module.DxgiDevice(index=0, name="GPU 0")],
        )
        release_adapter.assert_called_once_with(adapter)

    def test_dxgi_partial_enumeration_failure_discards_previous_results(self) -> None:
        adapter = object()
        enum_adapter = Mock(side_effect=[(0, adapter), (-1, None)])
        describe_adapter = Mock(return_value=(0, "GPU 0"))
        release_adapter = Mock()

        self.assertEqual(
            runtime_module._enumerate_dxgi_adapter_names(enum_adapter, describe_adapter, release_adapter),
            [],
        )
        release_adapter.assert_called_once_with(adapter)

    def test_dxgi_null_adapter_fails_the_whole_enumeration(self) -> None:
        describe_adapter = Mock()
        release_adapter = Mock()

        self.assertEqual(
            runtime_module._enumerate_dxgi_adapter_names(
                Mock(return_value=(0, None)),
                describe_adapter,
                release_adapter,
            ),
            [],
        )
        describe_adapter.assert_not_called()
        release_adapter.assert_not_called()

    def test_dxgi_descriptor_failure_discards_the_whole_enumeration(self) -> None:
        adapter = object()
        describe_adapter = Mock(return_value=(-1, ""))
        release_adapter = Mock()

        self.assertEqual(
            runtime_module._enumerate_dxgi_adapter_names(
                Mock(return_value=(0, adapter)),
                describe_adapter,
                release_adapter,
            ),
            [],
        )
        release_adapter.assert_called_once_with(adapter)


if __name__ == "__main__":
    unittest.main()
