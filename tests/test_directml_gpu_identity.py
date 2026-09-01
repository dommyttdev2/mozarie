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
        return SimpleNamespace(device_count=lambda: len(names), device_name=lambda index: names[index])

    def assert_runtime_mapping_failure(self, callback) -> None:
        with self.assertRaises(RuntimeError):
            callback()

    def assert_gpu_unavailable(self, callback) -> None:
        with self.assertRaises(Exception) as raised:
            callback()
        self.assertEqual(getattr(raised.exception, "error_code", None), "gpu_unavailable")

    def test_reverse_enumeration_maps_selected_physical_gpu(self) -> None:
        directml = self._directml("AMD Radeon(TM) Graphics", " AMD   Radeon RX 6600M\0")
        adapters = [runtime_module.DxgiDevice(index=0, name="amd radeon rx 6600m"), runtime_module.DxgiDevice(index=1, name="AMD Radeon(TM) Graphics")]
        self.assertEqual(runtime_module.directml_onnx_device_id(1, module=directml, adapters=adapters), 0)

    def test_onnx_wrapper_converts_mapping_failure_to_gpu_unavailable(self) -> None:
        with patch("mozarie.inference.onnx.directml_onnx_device_id", side_effect=RuntimeError("mapping failed")):
            self.assert_gpu_unavailable(lambda: onnx_module._directml_onnx_device_id(0))

    def test_identity_acquisition_and_invalid_ids_fail_closed(self) -> None:
        with patch("mozarie.runtime.directml_module", side_effect=ImportError("torch-directml unavailable")):
            self.assert_runtime_mapping_failure(lambda: runtime_module.directml_onnx_device_id(0))
        directml = self._directml("GPU 0", "GPU 1")
        for device in (-1, 2):
            with self.subTest(device=device):
                self.assert_runtime_mapping_failure(lambda device=device: runtime_module.directml_onnx_device_id(device, module=directml, adapters=[runtime_module.DxgiDevice(index=0, name="GPU 0")]))

    def test_empty_enumeration_name_mismatch_and_missing_identity_fail_closed(self) -> None:
        directml = self._directml("GPU 0")
        self.assert_runtime_mapping_failure(lambda: runtime_module.directml_onnx_device_id(0, module=directml, adapters=[]))
        self.assert_runtime_mapping_failure(lambda: runtime_module.directml_onnx_device_id(0, module=directml, adapters=[runtime_module.DxgiDevice(index=0, name="Other")]))
        duplicates = [runtime_module.DxgiDevice(index=0, name="GPU 0"), runtime_module.DxgiDevice(index=2, name="GPU 0")]
        self.assert_runtime_mapping_failure(lambda: runtime_module.directml_onnx_device_id(0, module=directml, adapters=duplicates))

    def test_duplicate_different_luids_same_pnp_identity_use_enumerated_alias(self) -> None:
        directml = self._directml("AMD Radeon RX 6600M")
        adapters = [runtime_module.DxgiDevice(index=2, name="AMD Radeon RX 6600M", luid=(0, 26920747)), runtime_module.DxgiDevice(index=0, name="AMD Radeon RX 6600M", luid=(0, 52342))]
        resolver = Mock(return_value=frozenset({("hardware", "software")}))
        self.assertEqual(runtime_module.directml_onnx_device_id(0, module=directml, adapters=adapters, physical_identity_resolver=resolver), 2)
        self.assertEqual([call.args for call in resolver.call_args_list], [((0, 26920747),), ((0, 52342),)])

    def test_duplicate_different_luids_ambiguous_identity_fails_closed(self) -> None:
        directml = self._directml("AMD Radeon RX 6600M")
        adapters = [runtime_module.DxgiDevice(index=0, name="AMD Radeon RX 6600M", luid=(1, 10)), runtime_module.DxgiDevice(index=2, name="AMD Radeon RX 6600M", luid=(1, 20))]
        resolvers = [
            lambda luid: frozenset({("a", "a")}) if luid == (1, 10) else frozenset({("b", "b")}),
            lambda luid: frozenset({("a", "a")}) if luid == (1, 10) else None,
            Mock(side_effect=OSError("KMT unavailable")),
        ]
        for resolver in resolvers:
            with self.subTest(resolver=resolver):
                self.assert_runtime_mapping_failure(lambda resolver=resolver: runtime_module.directml_onnx_device_id(0, module=directml, adapters=adapters, physical_identity_resolver=resolver))

    def test_duplicate_same_luid_uses_enumerated_alias_without_pnp_probe(self) -> None:
        directml = self._directml("AMD Radeon RX 6600M")
        adapters = [runtime_module.DxgiDevice(index=2, name="AMD Radeon RX 6600M", luid=(7, 42)), runtime_module.DxgiDevice(index=0, name="AMD Radeon RX 6600M", luid=(7, 42))]
        resolver = Mock()
        self.assertEqual(runtime_module.directml_onnx_device_id(0, module=directml, adapters=adapters, physical_identity_resolver=resolver), 2)
        resolver.assert_not_called()

    def test_dxgi_enumeration_requires_complete_results(self) -> None:
        adapter = object()
        release = Mock()
        self.assertEqual(runtime_module._enumerate_dxgi_adapter_names(Mock(side_effect=[(0, adapter), (runtime_module._DXGI_ERROR_NOT_FOUND, None)]), Mock(return_value=(0, "GPU 0\0", (3, 9))), release), [runtime_module.DxgiDevice(index=0, name="GPU 0", luid=(3, 9))])
        release.assert_called_once_with(adapter)
        release.reset_mock()
        self.assertEqual(runtime_module._enumerate_dxgi_adapter_names(Mock(side_effect=[(0, adapter), (-1, None)]), Mock(return_value=(0, "GPU 0")), release), [])
        release.assert_called_once_with(adapter)
        self.assertEqual(runtime_module._enumerate_dxgi_adapter_names(Mock(return_value=(0, None)), Mock(), Mock()), [])
        release.reset_mock()
        self.assertEqual(runtime_module._enumerate_dxgi_adapter_names(Mock(return_value=(0, adapter)), Mock(return_value=(-1, "")), release), [])
        release.assert_called_once_with(adapter)


class DirectMlPhysicalIdentityTests(unittest.TestCase):
    class FakeFunction:
        def __init__(self, callback):
            object.__setattr__(self, "callback", callback)
        def __call__(self, *args):
            return self.callback(*args)

    class FakeGdi32:
        def __init__(self, *, count=1, identities=None, fail_open=False, fail_query=False):
            self.count = count
            self.identities = identities or [("HW", "SW")] * count
            self.fail_open = fail_open
            self.fail_query = fail_query
            self.closed = []
            self.D3DKMTOpenAdapterFromLuid = DirectMlPhysicalIdentityTests.FakeFunction(self._open)
            self.D3DKMTQueryAdapterInfo = DirectMlPhysicalIdentityTests.FakeFunction(self._query)
            self.D3DKMTCloseAdapter = DirectMlPhysicalIdentityTests.FakeFunction(self._close)
        def _open(self, pointer):
            if self.fail_open:
                return -1
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
            hardware, software = self.identities[payload.PhysicalAdapterIndex]
            value = hardware if payload.PnPKeyType == identity_module._D3DKMT_PNP_KEY_HARDWARE else software
            buffer = ctypes.cast(payload.pDest, ctypes.POINTER(ctypes.c_wchar))
            for index, char in enumerate(value + "\0"):
                buffer[index] = char
            return 0
        def _close(self, pointer):
            close = ctypes.cast(pointer, ctypes.POINTER(identity_module._CloseAdapter)).contents
            self.closed.append(close.hAdapter)
            return 0

    def _resolve(self, gdi32):
        with patch.object(identity_module.os, "name", "nt"), patch.object(identity_module.ctypes, "WinDLL", return_value=gdi32, create=True):
            return identity_module.physical_adapter_identity((7, 42))

    def test_physical_identity_collects_complete_set_and_closes(self) -> None:
        gdi32 = self.FakeGdi32(count=2, identities=[("HW-A", "SW-A"), ("HW-B", "SW-B")])
        self.assertEqual(self._resolve(gdi32), frozenset({("hw-a", "sw-a"), ("hw-b", "sw-b")}))
        self.assertEqual(gdi32.closed, [123])

    def test_physical_identity_rejects_duplicate_members(self) -> None:
        gdi32 = self.FakeGdi32(count=2)
        self.assertIsNone(self._resolve(gdi32))
        self.assertEqual(gdi32.closed, [123])

    def test_physical_identity_fails_closed_on_platform_open_or_query_failure(self) -> None:
        with patch.object(identity_module.os, "name", "posix"):
            self.assertIsNone(identity_module.physical_adapter_identity((0, 1)))
        self.assertIsNone(self._resolve(self.FakeGdi32(fail_open=True)))
        gdi32 = self.FakeGdi32(fail_query=True)
        self.assertIsNone(self._resolve(gdi32))
        self.assertEqual(gdi32.closed, [123])


if __name__ == "__main__":
    unittest.main()
