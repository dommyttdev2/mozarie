from __future__ import annotations

import ctypes
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from mozarie import directml_identity as identity_module
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
        self.assertEqual(runtime_module.directml_onnx_device_id(1, module=directml, adapters=adapters), 0)

    def test_onnx_wrapper_converts_mapping_failure_to_gpu_unavailable(self) -> None:
        with patch("mozarie.inference.onnx.directml_onnx_device_id", side_effect=RuntimeError("mapping failed")):
            self.assert_gpu_unavailable(lambda: onnx_module._directml_onnx_device_id(0))

    def test_directml_identity_acquisition_failure_fails_closed(self) -> None:
        with patch("mozarie.runtime.directml_module", side_effect=ImportError("torch-directml unavailable")):
            self.assert_runtime_mapping_failure(lambda: runtime_module.directml_onnx_device_id(0))

    def test_invalid_logical_device_id_fails_closed(self) -> None:
        directml = self._directml("GPU 0", "GPU 1")
        self.assert_runtime_mapping_failure(lambda: runtime_module.directml_onnx_device_id(2, module=directml, adapters=[runtime_module.DxgiDevice(index=0, name="GPU 0")]))

    def test_negative_logical_device_id_fails_closed(self) -> None:
        directml = self._directml("GPU 0", "GPU 1")
        self.assert_runtime_mapping_failure(lambda: runtime_module.directml_onnx_device_id(-1, module=directml, adapters=[runtime_module.DxgiDevice(index=0, name="GPU 0")]))

    def test_empty_dxgi_enumeration_fails_closed(self) -> None:
        directml = self._directml("GPU 0")
        self.assert_runtime_mapping_failure(lambda: runtime_module.directml_onnx_device_id(0, module=directml, adapters=[]))

    def test_name_mismatch_fails_closed(self) -> None:
        directml = self._directml("Selected GPU")
        adapters = [runtime_module.DxgiDevice(index=0, name="Different GPU")]
        self.assert_runtime_mapping_failure(lambda: runtime_module.directml_onnx_device_id(0, module=directml, adapters=adapters))

    def test_duplicate_dxgi_name_without_identity_fails_closed(self) -> None:
        directml = self._directml("AMD Radeon RX 6600M")
        adapters = [runtime_module.DxgiDevice(index=0, name="AMD Radeon RX 6600M"), runtime_module.DxgiDevice(index=2, name="AMD Radeon RX 6600M")]
        self.assert_runtime_mapping_failure(lambda: runtime_module.directml_onnx_device_id(0, module=directml, adapters=adapters))

    def test_duplicate_different_luids_same_pnp_identity_use_enumerated_alias(self) -> None:
        directml = self._directml("AMD Radeon RX 6600M")
        adapters = [runtime_module.DxgiDevice(index=2, name="AMD Radeon RX 6600M", luid=(0, 26920747)), runtime_module.DxgiDevice(index=0, name="AMD Radeon RX 6600M", luid=(0, 52342))]
        identity = frozenset({("hardware", "software")})
        resolver = Mock(return_value=identity)
        self.assertEqual(runtime_module.directml_onnx_device_id(0, module=directml, adapters=adapters, physical_identity_resolver=resolver), 2)
        self.assertEqual([call.args for call in resolver.call_args_list], [((0, 26920747),), ((0, 52342),)])

    def test_duplicate_different_luids_conflicting_or_partial_identity_fails_closed(self) -> None:
        directml = self._directml("AMD Radeon RX 6600M")
        adapters = [runtime_module.DxgiDevice(index=0, name="AMD Radeon RX 6600M", luid=(1, 10)), runtime_module.DxgiDevice(index=2, name="AMD Radeon RX 6600M", luid=(1, 20))]
        for resolver in (
            lambda luid: frozenset({("hardware-a", "software-a")}) if luid == (1, 10) else frozenset({("hardware-b", "software-b")}),
            lambda luid: frozenset({("hardware", "software")}) if luid == (1, 10) else None,
            Mock(side_effect=OSError("KMT unavailable")),
        ):
            with self.subTest(resolver=resolver):
                self.assert_runtime_mapping_failure(lambda resolver=resolver: runtime_module.directml_onnx_device_id(0, module=directml, adapters=adapters, physical_identity_resolver=resolver))

    def test_duplicate_same_luid_uses_enumerated_alias_without_pnp_probe(self) -> None:
        directml = self._directml("AMD Radeon RX 6600M")
        adapters = [runtime_module.DxgiDevice(index=2, name="AMD Radeon RX 6600M", luid=(7, 42)), runtime_module.DxgiDevice(index=0, name="AMD Radeon RX 6600M", luid=(7, 42))]
        resolver = Mock()
        self.assertEqual(runtime_module.directml_onnx_device_id(0, module=directml, adapters=adapters, physical_identity_resolver=resolver), 2)
        resolver.assert_not_called()

    def test_dxgi_enumeration_is_complete_or_empty(self) -> None:
        adapter = object()
        release = Mock()
        self.assertEqual(runtime_module._enumerate_dxgi_adapter_names(Mock(side_effect=[(0, adapter), (runtime_module._DXGI_ERROR_NOT_FOUND, None)]), Mock(return_value=(0, "GPU 0\0", (3, 9))), release), [runtime_module.DxgiDevice(index=0, name="GPU 0", luid=(3, 9))])
        release.assert_called_once_with(adapter)
        release.reset_mock()
        self.assertEqual(runtime_module._enumerate_dxgi_adapter_names(Mock(side_effect=[(0, adapter), (-1, None)]), Mock(return_value=(0, "GPU 0")), release), [])
        release.assert_called_once_with(adapter)
        self.assertEqual(runtime_module._enumerate_dxgi_adapter_names(Mock(return_value=(0, None)), Mock(), Mock()), [])


class DirectMlPhysicalIdentityTests(unittest.TestCase):
    class FakeFunction:
        def __init__(self, callback):
            object.__setattr__(self, "callback", callback)
        def __call__(self, *args):
            return self.callback(*args)

    class FakeGdi32:
        def __init__(self, *, count=1, hardware="HW", software="SW", fail_query=False):
            self.count = count
            self.hardware = hardware
            self.software = software
            self.fail_query = fail_query
            self.closed = []
            self.D3DKMTOpenAdapterFromLuid = DirectMlPhysicalIdentityTests.FakeFunction(self._open)
            self.D3DKMTQueryAdapterInfo = DirectMlPhysicalIdentityTests.FakeFunction(self._query)
            self.D3DKMTCloseAdapter = DirectMlPhysicalIdentityTests.FakeFunction(self._close)
        def _open(self, pointer):
            request = ctypes.cast(pointer, ctypes.POINTER(identity_module._OpenAdapterFromLuid)).contents
            request.hAdapter = 123
            return 0
        def _query(self, pointer):
            query = ctypes.cast(pointer, ctypes.POINTER(identity_module._QueryAdapterInfo)).contents
            if self.fail_query:
                return -1
            if query.Type == identity_module._KMTQAITYPE_PHYSICALADAPTERCOUNT:
                payload = ctypes.cast(query.pPrivateDriverData, ctypes.POINTER(identity_module._PhysicalAdapterCount)).contents
                payload.Count = self.count
                return 0
            payload = ctypes.cast(query.pPrivateDriverData, ctypes.POINTER(identity_module._QueryPhysicalAdapterPnpKey)).contents
            value = self.hardware if payload.PnPKeyType == identity_module._D3DKMT_PNP_KEY_HARDWARE else self.software
            buffer = ctypes.cast(payload.pDest, ctypes.POINTER(ctypes.c_wchar))
            for index, char in enumerate(value + "\0"):
                buffer[index] = char
            return 0
        def _close(self, pointer):
            close = ctypes.cast(pointer, ctypes.POINTER(identity_module._CloseAdapter)).contents
            self.closed.append(close.hAdapter)
            return 0

    def test_physical_identity_collects_all_reported_members_and_closes(self) -> None:
        gdi32 = self.FakeGdi32(count=2)
        with patch.object(identity_module.os, "name", "nt"), patch.object(identity_module.ctypes, "WinDLL", return_value=gdi32, create=True):
            identity = identity_module.physical_adapter_identity((7, 42))
        self.assertEqual(identity, frozenset({("hw", "sw")}))
        # Duplicate physical identities are ambiguous relative to the reported count.
        self.assertIsNone(identity)
        self.assertEqual(gdi32.closed, [123])

    def test_physical_identity_single_member_succeeds(self) -> None:
        gdi32 = self.FakeGdi32()
        with patch.object(identity_module.os, "name", "nt"), patch.object(identity_module.ctypes, "WinDLL", return_value=gdi32, create=True):
            self.assertEqual(identity_module.physical_adapter_identity((7, 42)), frozenset({("hw", "sw")}))
        self.assertEqual(gdi32.closed, [123])

    def test_physical_identity_fails_closed_on_platform_or_query_failure(self) -> None:
        with patch.object(identity_module.os, "name", "posix"):
            self.assertIsNone(identity_module.physical_adapter_identity((0, 1)))
        gdi32 = self.FakeGdi32(fail_query=True)
        with patch.object(identity_module.os, "name", "nt"), patch.object(identity_module.ctypes, "WinDLL", return_value=gdi32, create=True):
            self.assertIsNone(identity_module.physical_adapter_identity((0, 1)))
        self.assertEqual(gdi32.closed, [123])


if __name__ == "__main__":
    unittest.main()
