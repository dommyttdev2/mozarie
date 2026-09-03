from __future__ import annotations

import io
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

from mozarie import rocm_probe


class FakeTensor:
    def __init__(self, shape, value):
        self.shape = tuple(shape)
        self.value = float(value)

    def to(self, _device):
        return self

    def cpu(self):
        return self

    def __matmul__(self, other):
        return FakeTensor((self.shape[0], other.shape[1]), self.shape[1] * self.value * other.value)


class FakeCuda:
    def __init__(self, devices, available=True):
        self.devices = list(devices)
        self.available = available
        self.selected = None
        self.synchronized = []

    def is_available(self):
        return self.available

    def device_count(self):
        return len(self.devices)

    def get_device_properties(self, index):
        device = self.devices[index]
        return SimpleNamespace(
            gcnArchName=device.get("arch", ""),
            total_memory=device.get("memory", 0),
        )

    def get_device_name(self, index):
        return self.devices[index].get("name", "")

    def set_device(self, index):
        self.selected = index

    def synchronize(self, device):
        self.synchronized.append(device)


class FakeFunctional:
    @staticmethod
    def conv2d(image, kernel):
        return FakeTensor((1, 1, 6, 6), 9.0 * image.value * kernel.value)


class FakeTorch:
    float32 = "float32"

    def __init__(
        self,
        devices=None,
        *,
        version=rocm_probe.EXPECTED_TORCH_VERSION,
        hip="7.13.99004",
        cuda_version=None,
        available=True,
    ):
        self.__version__ = version
        self.version = SimpleNamespace(hip=hip, cuda=cuda_version)
        self.cuda = FakeCuda(
            devices
            if devices is not None
            else [{"name": "AMD Radeon RX 6600M", "arch": "gfx1032:sramecc-:xnack-", "memory": 8_000_000_000}],
            available=available,
        )
        self.nn = SimpleNamespace(functional=FakeFunctional)

    @staticmethod
    def device(value):
        return value

    @staticmethod
    def ones(shape, dtype=None, device=None):
        return FakeTensor(shape, 1.0)

    @staticmethod
    def full(shape, value, dtype=None, device=None):
        return FakeTensor(shape, value)

    @staticmethod
    def allclose(actual, expected):
        return actual.shape == expected.shape and actual.value == expected.value


class RocmProbeTests(unittest.TestCase):
    def test_validate_host(self):
        self.assertIsNone(rocm_probe.validate_host("win32"))
        with self.assertRaisesRegex(rocm_probe.ProbeError, "requires Windows"):
            rocm_probe.validate_host("linux")

    def test_validate_rocm_torch_success_and_failures(self):
        result = rocm_probe.validate_rocm_torch(FakeTorch())
        self.assertEqual(result["torchVersion"], rocm_probe.EXPECTED_TORCH_VERSION)
        self.assertEqual(result["hipVersion"], "7.13.99004")
        self.assertEqual(result["deviceCount"], 1)

        with self.assertRaisesRegex(rocm_probe.ProbeError, "Unexpected PyTorch version"):
            rocm_probe.validate_rocm_torch(FakeTorch(version="2.10.0"))
        with self.assertRaisesRegex(rocm_probe.ProbeError, "not a ROCm/HIP build"):
            rocm_probe.validate_rocm_torch(FakeTorch(hip=None))
        with self.assertRaisesRegex(rocm_probe.ProbeError, "refuses CUDA"):
            rocm_probe.validate_rocm_torch(FakeTorch(cuda_version="13.0"))
        with self.assertRaisesRegex(rocm_probe.ProbeError, "is_available"):
            rocm_probe.validate_rocm_torch(FakeTorch(available=False))
        with self.assertRaisesRegex(rocm_probe.ProbeError, "no GPU devices"):
            rocm_probe.validate_rocm_torch(FakeTorch(devices=[]))

    def test_normalize_and_describe_device(self):
        self.assertEqual(rocm_probe.normalize_gfx_name(" gfx1032:xnack- "), "gfx1032")
        self.assertEqual(rocm_probe.normalize_gfx_name(None), "")
        item = rocm_probe.describe_device(FakeTorch(), 0)
        self.assertEqual(item["index"], 0)
        self.assertEqual(item["name"], "AMD Radeon RX 6600M")
        self.assertEqual(item["gfx"], "gfx1032")
        self.assertEqual(item["totalMemoryBytes"], 8_000_000_000)

    def test_select_device(self):
        torch = FakeTorch()
        index, inventory = rocm_probe.select_device(torch)
        self.assertEqual(index, 0)
        self.assertEqual(inventory[0]["gfx"], "gfx1032")
        self.assertEqual(rocm_probe.select_device(torch, 0)[0], 0)

        with self.assertRaisesRegex(rocm_probe.ProbeError, "must not be empty"):
            rocm_probe.select_device(torch, expected_gfx="")
        with self.assertRaisesRegex(rocm_probe.ProbeError, "unavailable"):
            rocm_probe.select_device(torch, -1)
        with self.assertRaisesRegex(rocm_probe.ProbeError, "unavailable"):
            rocm_probe.select_device(torch, 1)
        with self.assertRaisesRegex(rocm_probe.ProbeError, "expected gfx1031"):
            rocm_probe.select_device(torch, 0, "gfx1031")
        with self.assertRaisesRegex(rocm_probe.ProbeError, "No ROCm device matched"):
            rocm_probe.select_device(torch, expected_gfx="gfx1100")

        duplicate = FakeTorch(
            devices=[
                {"name": "GPU A", "arch": "gfx1032", "memory": 1},
                {"name": "GPU B", "arch": "gfx1032", "memory": 2},
            ]
        )
        with self.assertRaisesRegex(rocm_probe.ProbeError, "2 ROCm devices matched"):
            rocm_probe.select_device(duplicate)

    def test_matmul_success_and_failure(self):
        torch = FakeTorch()
        result = rocm_probe.run_matmul(torch, 0)
        self.assertEqual(result, {"shape": [64, 64], "verified": True})
        self.assertEqual(torch.cuda.synchronized, ["cuda:0"])

        with patch.object(torch, "allclose", return_value=False):
            with self.assertRaisesRegex(rocm_probe.ProbeError, "MatMul"):
                rocm_probe.run_matmul(torch, 0)

    def test_conv2d_success_and_failure(self):
        torch = FakeTorch()
        result = rocm_probe.run_conv2d(torch, 0)
        self.assertEqual(result, {"shape": [1, 1, 6, 6], "verified": True})
        self.assertEqual(torch.cuda.synchronized, ["cuda:0"])

        with patch.object(torch, "allclose", return_value=False):
            with self.assertRaisesRegex(rocm_probe.ProbeError, "Conv2d"):
                rocm_probe.run_conv2d(torch, 0)

    def test_probe_success(self):
        torch = FakeTorch()
        with patch.object(rocm_probe, "validate_host") as validate_host:
            result = rocm_probe.probe(torch_module=torch)
        validate_host.assert_called_once_with()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["expectedGfx"], "gfx1032")
        self.assertEqual(result["selectedDevice"]["name"], "AMD Radeon RX 6600M")
        self.assertTrue(result["matmul"]["verified"])
        self.assertTrue(result["conv2d"]["verified"])
        self.assertEqual(torch.cuda.selected, 0)

    def test_probe_import_failure(self):
        original_import = __import__

        def fake_import(name, *args, **kwargs):
            if name == "torch":
                raise ImportError("missing torch")
            return original_import(name, *args, **kwargs)

        with patch.object(rocm_probe, "validate_host"), patch(
            "builtins.__import__", side_effect=fake_import
        ):
            with self.assertRaisesRegex(rocm_probe.ProbeError, "missing torch"):
                rocm_probe.probe()

    def test_main_success_and_failure(self):
        stdout = io.StringIO()
        with patch.object(sys, "argv", ["rocm_probe", "--device-index", "0", "--expected-gfx", "gfx1032"]), \
                patch.object(rocm_probe, "probe", return_value={"status": "ok"}) as probe, \
                redirect_stdout(stdout):
            self.assertEqual(rocm_probe.main(), 0)
        probe.assert_called_once_with(0, "gfx1032")
        self.assertIn('"status": "ok"', stdout.getvalue())

        stderr = io.StringIO()
        with patch.object(sys, "argv", ["rocm_probe"]), \
                patch.object(rocm_probe, "probe", side_effect=rocm_probe.ProbeError("boom")), \
                redirect_stderr(stderr):
            self.assertEqual(rocm_probe.main(), 1)
        self.assertIn("boom", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
