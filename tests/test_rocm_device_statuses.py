from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mozarie import state


class RocmDeviceStatusTests(unittest.TestCase):
    @staticmethod
    def _torch(*, hip="7.13", available=True, devices=(), arch_list=None):
        cuda_values = {
            "is_available": Mock(return_value=available),
            "device_count": Mock(return_value=len(devices)),
            "get_device_name": Mock(side_effect=lambda index: devices[index][0]),
            "get_device_properties": Mock(side_effect=lambda index: devices[index][1]),
        }
        if arch_list is not None:
            cuda_values["get_arch_list"] = Mock(return_value=arch_list)
        return SimpleNamespace(
            version=SimpleNamespace(hip=hip),
            cuda=SimpleNamespace(**cuda_values),
        )

    def test_non_hip_torch_is_not_reported_as_rocm(self):
        torch = self._torch(hip=None)
        self.assertEqual(state.rocm_device_statuses(torch), [])
        torch.cuda.is_available.assert_not_called()

    def test_unavailable_hip_runtime_has_no_devices(self):
        torch = self._torch(available=False)
        self.assertEqual(state.rocm_device_statuses(torch), [])
        torch.cuda.device_count.assert_not_called()

    def test_rocm_device_reports_gfx_architecture_memory_and_support(self):
        properties = SimpleNamespace(
            gcnArchName="gfx1032:sramecc-:xnack-",
            total_memory=8573157376,
        )
        torch = self._torch(
            devices=(("AMD Radeon RX 6600M", properties),),
            arch_list=["gfx1030", "gfx1032"],
        )
        self.assertEqual(state.rocm_device_statuses(torch), [{
            "id": 0,
            "name": "AMD Radeon RX 6600M",
            "architecture": "gfx1032",
            "totalMemory": 8573157376,
            "supported": True,
        }])

    def test_rocm_device_accepts_alternate_gcn_arch_property_without_compiled_list(self):
        properties = SimpleNamespace(gcn_arch_name="gfx1032", total_memory=8)
        torch = self._torch(devices=(("AMD GPU", properties),))
        self.assertEqual(state.rocm_device_statuses(torch)[0]["architecture"], "gfx1032")
        self.assertTrue(state.rocm_device_statuses(torch)[0]["supported"])

    def test_rocm_device_marks_architecture_outside_compiled_list_unsupported(self):
        properties = SimpleNamespace(gcnArchName="gfx1100", total_memory=16)
        torch = self._torch(
            devices=(("AMD GPU", properties),),
            arch_list=["gfx1032"],
        )
        self.assertFalse(state.rocm_device_statuses(torch)[0]["supported"])

    def test_rocm_device_without_architecture_fails_closed(self):
        properties = SimpleNamespace(total_memory=16)
        torch = self._torch(devices=(("AMD GPU", properties),), arch_list=[])
        result = state.rocm_device_statuses(torch)
        self.assertEqual(result[0]["architecture"], "")
        self.assertFalse(result[0]["supported"])

    def test_gpu_device_statuses_dispatches_rocm_without_directml(self):
        torch = object()
        expected = [{"id": 0, "supported": True}]
        with patch.object(state, "runtime_backend", return_value="rocm"), \
             patch.object(state, "rocm_device_statuses", return_value=expected) as rocm, \
             patch.object(state, "directml_devices") as directml:
            self.assertIs(state.gpu_device_statuses(torch), expected)
        rocm.assert_called_once_with(torch)
        directml.assert_not_called()


if __name__ == "__main__":
    unittest.main()
