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

    def assert_runtime_mapping_failure(self, callback) -> None:
        with self.assertRaises(RuntimeError):
            callback()

    def assert_gpu_unavailable(self, callback) -> None:
        with self.assertRaises(Exception) as raised:
            callback()
        self.assertEqual(getattr(raised.exception, "error_code", None), "gpu_unavailable")

    def test_reverse_enumeration_maps_selected_physical_gpu(self) -> None:
        directml = self._directml("AMD Radeon(TM) Graphics", " AMD   Radeon RX 6600M\0")
        adapters = [
            runtime_module.DxgiDevice(index=0, name="amd radeon rx 6600m"),
            runtime_module.DxgiDevice(index=1, name="AMD Radeon(TM) Graphics"),
        ]
        self.assertEqual(
            runtime_module.directml_onnx_device_id(1, module=directml, adapters=adapters),
            0,
        )

    def test_onnx_wrapper_converts_mapping_failure_to_gpu_unavailable(self) -> None:
        with patch("mozarie.inference.onnx.directml_onnx_device_id", side_effect=RuntimeError("mapping failed")):
            self.assert_gpu_unavailable(lambda: onnx_module._directml_onnx_device_id(0))

    def test_directml_identity_acquisition_failure_fails_closed(self) -> None:
        with patch("mozarie.runtime.directml_module", side_effect=ImportError("torch-directml unavailable")):
            self.assert_runtime_mapping_failure(lambda: runtime_module.directml_onnx_device_id(0))

    def test_invalid_logical_device_id_fails_closed(self) -> None:
        directml = self._directml("GPU 0", "GPU 1")
        self.assert_runtime_mapping_failure(
            lambda: runtime_module.directml_onnx_device_id(
                2,
                module=directml,
                adapters=[runtime_module.DxgiDevice(index=0, name="GPU 0")],
            )
        )

    def test_negative_logical_device_id_fails_closed(self) -> None:
        directml = self._directml("GPU 0", "GPU 1")
        self.assert_runtime_mapping_failure(
            lambda: runtime_module.directml_onnx_device_id(
                -1,
                module=directml,
                adapters=[runtime_module.DxgiDevice(index=0, name="GPU 0")],
            )
        )

    def test_empty_dxgi_enumeration_fails_closed(self) -> None:
        directml = self._directml("GPU 0")
        self.assert_runtime_mapping_failure(
            lambda: runtime_module.directml_onnx_device_id(0, module=directml, adapters=[])
        )

    def test_name_mismatch_fails_closed(self) -> None:
        directml = self._directml("Selected GPU")
        adapters = [runtime_module.DxgiDevice(index=0, name="Different GPU")]
        self.assert_runtime_mapping_failure(
            lambda: runtime_module.directml_onnx_device_id(0, module=directml, adapters=adapters)
        )

    def test_duplicate_dxgi_name_without_identity_fails_closed(self) -> None:
        directml = self._directml("AMD Radeon RX 6600M")
        adapters = [
            runtime_module.DxgiDevice(index=0, name="AMD Radeon RX 6600M"),
            runtime_module.DxgiDevice(index=2, name="AMD Radeon RX 6600M"),
        ]
        self.assert_runtime_mapping_failure(
            lambda: runtime_module.directml_onnx_device_id(0, module=directml, adapters=adapters)
        )

    def test_duplicate_dxgi_name_with_different_luids_requires_physical_identity(self) -> None:
        directml = self._directml("AMD Radeon RX 6600M")
        adapters = [
            runtime_module.DxgiDevice(index=0, name="AMD Radeon RX 6600M", luid=(1, 10)),
            runtime_module.DxgiDevice(index=2, name="AMD Radeon RX 6600M", luid=(1, 20)),
        ]
        self.assert_runtime_mapping_failure(
            lambda: runtime_module.directml_onnx_device_id(
                0,
                module=directml,
                adapters=adapters,
                physical_identity_resolver=lambda luid: None,
            )
        )

    def test_duplicate_different_luids_same_pnp_identity_use_enumerated_alias(self) -> None:
        directml = self._directml("AMD Radeon RX 6600M")
        adapters = [
            runtime_module.DxgiDevice(index=2, name="AMD Radeon RX 6600M", luid=(0, 26920747)),
            runtime_module.DxgiDevice(index=0, name="AMD Radeon RX 6600M", luid=(0, 52342)),
        ]
        identity = (
            r"\registry\machine\system\controlset001\enum\pci\ven_1002&dev_73ff\device parameters",
            r"\registry\machine\system\controlset001\control\class\display\0001",
        )
        resolver = Mock(return_value=identity)
        self.assertEqual(
            runtime_module.directml_onnx_device_id(
                0,
                module=directml,
                adapters=adapters,
                physical_identity_resolver=resolver,
            ),
            2,
        )
        self.assertEqual(resolver.call_args_list[0].args, ((0, 26920747),))
        self.assertEqual(resolver.call_args_list[1].args, ((0, 52342),))

    def test_duplicate_different_luids_conflicting_pnp_identity_fails_closed(self) -> None:
        directml = self._directml("AMD Radeon RX 6600M")
        adapters = [
            runtime_module.DxgiDevice(index=0, name="AMD Radeon RX 6600M", luid=(1, 10)),
            runtime_module.DxgiDevice(index=2, name="AMD Radeon RX 6600M", luid=(1, 20)),
        ]
        identities = {
            (1, 10): ("hardware-a", "software-a"),
            (1, 20): ("hardware-b", "software-b"),
        }
        self.assert_runtime_mapping_failure(
            lambda: runtime_module.directml_onnx_device_id(
                0,
                module=directml,
                adapters=adapters,
                physical_identity_resolver=identities.get,
            )
        )

    def test_duplicate_different_luids_partial_pnp_identity_fails_closed(self) -> None:
        directml = self._directml("AMD Radeon RX 6600M")
        adapters = [
            runtime_module.DxgiDevice(index=0, name="AMD Radeon RX 6600M", luid=(1, 10)),
            runtime_module.DxgiDevice(index=2, name="AMD Radeon RX 6600M", luid=(1, 20)),
        ]
        self.assert_runtime_mapping_failure(
            lambda: runtime_module.directml_onnx_device_id(
                0,
                module=directml,
                adapters=adapters,
                physical_identity_resolver=lambda luid: ("hardware", "software") if luid == (1, 10) else None,
            )
        )

    def test_duplicate_different_luids_resolver_error_fails_closed(self) -> None:
        directml = self._directml("AMD Radeon RX 6600M")
        adapters = [
            runtime_module.DxgiDevice(index=0, name="AMD Radeon RX 6600M", luid=(1, 10)),
            runtime_module.DxgiDevice(index=2, name="AMD Radeon RX 6600M", luid=(1, 20)),
        ]
        self.assert_runtime_mapping_failure(
            lambda: runtime_module.directml_onnx_device_id(
                0,
                module=directml,
                adapters=adapters,
                physical_identity_resolver=Mock(side_effect=OSError("KMT unavailable")),
            )
        )

    def test_duplicate_dxgi_entries_for_same_luid_use_enumerated_alias_without_pnp_probe(self) -> None:
        directml = self._directml("AMD Radeon RX 6600M")
        adapters = [
            runtime_module.DxgiDevice(index=2, name="AMD Radeon RX 6600M", luid=(7, 42)),
            runtime_module.DxgiDevice(index=0, name="AMD Radeon RX 6600M", luid=(7, 42)),
        ]
        resolver = Mock()
        self.assertEqual(
            runtime_module.directml_onnx_device_id(
                0,
                module=directml,
                adapters=adapters,
                physical_identity_resolver=resolver,
            ),
            2,
        )
        resolver.assert_not_called()

    def test_dxgi_not_found_is_the_only_normal_enumeration_end(self) -> None:
        adapter = object()
        enum_adapter = Mock(side_effect=[(0, adapter), (runtime_module._DXGI_ERROR_NOT_FOUND, None)])
        describe_adapter = Mock(return_value=(0, "GPU 0\0", (3, 9)))
        release_adapter = Mock()

        self.assertEqual(
            runtime_module._enumerate_dxgi_adapter_names(enum_adapter, describe_adapter, release_adapter),
            [runtime_module.DxgiDevice(index=0, name="GPU 0", luid=(3, 9))],
        )
        release_adapter.assert_called_once_with(adapter)

    def test_dxgi_legacy_descriptor_without_luid_is_supported_for_tests(self) -> None:
        adapter = object()
        enum_adapter = Mock(side_effect=[(0, adapter), (runtime_module._DXGI_ERROR_NOT_FOUND, None)])
        describe_adapter = Mock(return_value=(0, "GPU 0\0"))
        release_adapter = Mock()
        self.assertEqual(
            runtime_module._enumerate_dxgi_adapter_names(enum_adapter, describe_adapter, release_adapter),
            [runtime_module.DxgiDevice(index=0, name="GPU 0")],
        )

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
