from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import patch

import numpy as np

from mozarie import rocm_directml_probe as probe
from mozarie.runtime import DxgiDevice


class _Model:
    @staticmethod
    def SerializeToString() -> bytes:
        return b"model"


class _Helper:
    @staticmethod
    def make_tensor_value_info(*_args):
        return object()

    @staticmethod
    def make_tensor(*_args):
        return object()

    @staticmethod
    def make_node(*_args, **_kwargs):
        return object()

    @staticmethod
    def make_graph(*_args):
        return object()

    @staticmethod
    def make_opsetid(*_args):
        return object()

    @staticmethod
    def make_model(*_args, **_kwargs):
        return _Model()


class _SessionOptions:
    def __init__(self) -> None:
        self.config_entries: dict[str, str] = {}

    def add_session_config_entry(self, key: str, value: str) -> None:
        self.config_entries[key] = value


class _Session:
    active = [probe.DML_EP, "CPUExecutionProvider"]
    output = np.full((1, 64), 64.0, dtype=np.float32)
    create_error: Exception | None = None
    last: "_Session | None" = None

    def __init__(self, _model, *, sess_options, providers):
        if self.create_error is not None:
            raise self.create_error
        self.options = sess_options
        self.providers = providers
        type(self).last = self

    @staticmethod
    def disable_fallback():
        return None

    def get_providers(self):
        return list(self.active)

    def run(self, _outputs, _feeds):
        return [self.output]


def _ort(session_type=_Session, providers=None):
    return types.SimpleNamespace(
        get_available_providers=lambda: list(
            providers if providers is not None else [probe.DML_EP, "CPUExecutionProvider"]
        ),
        SessionOptions=_SessionOptions,
        GraphOptimizationLevel=types.SimpleNamespace(ORT_ENABLE_ALL=object()),
        ExecutionMode=types.SimpleNamespace(ORT_SEQUENTIAL=object()),
        InferenceSession=session_type,
    )


ONNX = types.SimpleNamespace(
    helper=_Helper(),
    TensorProto=types.SimpleNamespace(FLOAT=1),
)


class RocmDirectmlProbeTests(unittest.TestCase):
    def tearDown(self) -> None:
        _Session.active = [probe.DML_EP, "CPUExecutionProvider"]
        _Session.output = np.full((1, 64), 64.0, dtype=np.float32)
        _Session.create_error = None
        _Session.last = None

    def test_dxgi_inventory_and_fail_closed_selection(self) -> None:
        adapter = DxgiDevice(3, " AMD Radeon RX 6600M ", (1, 2))
        self.assertEqual(
            probe.describe_dxgi_adapter(adapter),
            {"index": 3, "name": " AMD Radeon RX 6600M ", "luid": [1, 2]},
        )
        self.assertEqual(
            probe.describe_dxgi_adapter(DxgiDevice(0, "GPU")),
            {"index": 0, "name": "GPU", "luid": None},
        )
        index, inventory = probe.select_directml_adapter(
            "amd   radeon RX 6600m",
            [DxgiDevice(0, "iGPU"), adapter],
        )
        self.assertEqual(index, 3)
        self.assertEqual(len(inventory), 2)
        with self.assertRaisesRegex(probe.rocm_probe.ProbeError, "could not be matched"):
            probe.select_directml_adapter("missing", [adapter])
        with self.assertRaisesRegex(probe.rocm_probe.ProbeError, "multiple DXGI"):
            probe.select_directml_adapter(
                "GPU",
                [DxgiDevice(0, "GPU"), DxgiDevice(1, "gpu")],
            )

    def test_directml_provider_validation(self) -> None:
        self.assertEqual(
            probe.validate_directml_runtime(_ort()),
            [probe.DML_EP, "CPUExecutionProvider"],
        )
        with self.assertRaisesRegex(probe.rocm_probe.ProbeError, "does not expose"):
            probe.validate_directml_runtime(_ort(providers=["CPUExecutionProvider"]))

    def test_directml_matmul_disables_cpu_ep_fallback(self) -> None:
        result = probe.run_directml_matmul(_ort(), ONNX, np, 2)
        self.assertEqual(
            result,
            {
                "provider": probe.DML_EP,
                "deviceIndex": 2,
                "shape": [1, 64],
                "verified": True,
                "cpuFallbackDisabled": True,
            },
        )
        session = _Session.last
        self.assertIsNotNone(session)
        assert session is not None
        self.assertEqual(
            session.providers,
            [(probe.DML_EP, {"device_id": 2})],
        )
        self.assertEqual(
            session.options.config_entries,
            {probe.CPU_FALLBACK_CONFIG: "1"},
        )
        self.assertFalse(session.options.enable_mem_pattern)
        self.assertEqual(
            session.options.execution_mode,
            _ort().ExecutionMode.ORT_SEQUENTIAL,
        )

    def test_directml_matmul_failure_modes(self) -> None:
        _Session.active = ["CPUExecutionProvider"]
        with self.assertRaisesRegex(probe.rocm_probe.ProbeError, "instead of"):
            probe.run_directml_matmul(_ort(), ONNX, np, 0)

        _Session.active = [probe.DML_EP]
        _Session.output = np.zeros((1, 64), dtype=np.float32)
        with self.assertRaisesRegex(probe.rocm_probe.ProbeError, "unexpected result"):
            probe.run_directml_matmul(_ort(), ONNX, np, 0)

        class EmptyOutputSession(_Session):
            def run(self, _outputs, _feeds):
                return []

        with self.assertRaisesRegex(probe.rocm_probe.ProbeError, "unexpected result"):
            probe.run_directml_matmul(_ort(EmptyOutputSession), ONNX, np, 0)

        class ExplodingSession(_Session):
            create_error = RuntimeError("boom")

        with self.assertRaisesRegex(probe.rocm_probe.ProbeError, "probe failed: boom"):
            probe.run_directml_matmul(_ort(ExplodingSession), ONNX, np, 0)

    def test_probe_combines_rocm_directml_and_post_dml_rocm_execution(self) -> None:
        torch = types.SimpleNamespace(
            cuda=types.SimpleNamespace(set_device=lambda index: self.assertEqual(index, 0))
        )
        runtime = {"torchVersion": "torch", "hipVersion": "hip", "deviceCount": 1}
        rocm_inventory = [
            {"index": 0, "name": "AMD Radeon RX 6600M", "gfx": "gfx1032"}
        ]
        with (
            patch.object(probe.rocm_probe, "validate_host"),
            patch.object(probe.rocm_probe, "validate_rocm_torch", return_value=runtime),
            patch.object(probe.rocm_probe, "select_device", return_value=(0, rocm_inventory)),
            patch.object(
                probe.rocm_probe,
                "run_matmul",
                return_value={"shape": [64, 64], "verified": True},
            ) as rocm_after,
            patch.object(
                probe,
                "run_directml_matmul",
                return_value={
                    "provider": probe.DML_EP,
                    "deviceIndex": 7,
                    "shape": [1, 64],
                    "verified": True,
                    "cpuFallbackDisabled": True,
                },
            ) as directml,
        ):
            result = probe.probe(
                torch_module=torch,
                np_module=np,
                onnx_module=ONNX,
                ort_module=_ort(),
                dxgi_adapters=[DxgiDevice(7, "AMD Radeon RX 6600M")],
            )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["directml"]["deviceIndex"], 7)
        self.assertTrue(result["directml"]["cpuFallbackDisabled"])
        self.assertTrue(result["rocmAfterDirectml"]["verified"])
        directml.assert_called_once()
        rocm_after.assert_called_once_with(torch, 0)

        with (
            patch.object(probe.rocm_probe, "validate_host"),
            patch.object(probe.rocm_probe, "validate_rocm_torch", return_value=runtime),
            patch.object(probe.rocm_probe, "select_device", return_value=(0, rocm_inventory)),
            patch.object(probe, "_dxgi_adapter_names", return_value=[]),
        ):
            with self.assertRaisesRegex(probe.rocm_probe.ProbeError, "returned no devices"):
                probe.probe(
                    torch_module=torch,
                    np_module=np,
                    onnx_module=ONNX,
                    ort_module=_ort(),
                )

    def test_probe_import_paths_and_import_failure(self) -> None:
        fake_torch = types.SimpleNamespace()
        fake_onnx = object()
        fake_ort = object()
        modules = {
            "torch": fake_torch,
            "numpy": np,
            "onnx": fake_onnx,
            "onnxruntime": fake_ort,
        }
        supplied = {
            "torch_module": fake_torch,
            "np_module": np,
            "onnx_module": fake_onnx,
            "ort_module": fake_ort,
        }
        with patch.object(probe.rocm_probe, "validate_host"), patch.dict(sys.modules, modules):
            for missing in supplied:
                kwargs = dict(supplied)
                kwargs[missing] = None
                with self.subTest(missing=missing), patch.object(
                    probe.rocm_probe,
                    "validate_rocm_torch",
                    side_effect=probe.rocm_probe.ProbeError("stop"),
                ):
                    with self.assertRaisesRegex(probe.rocm_probe.ProbeError, "stop"):
                        probe.probe(**kwargs)

        real_import = __import__

        def failing_import(name, *args, **kwargs):
            if name == "torch":
                raise ImportError("missing torch")
            return real_import(name, *args, **kwargs)

        with patch.object(probe.rocm_probe, "validate_host"), patch("builtins.__import__", side_effect=failing_import):
            with self.assertRaisesRegex(probe.rocm_probe.ProbeError, "dependencies could not be imported"):
                probe.probe()

    def test_main_success_and_error(self) -> None:
        with patch.object(sys, "argv", ["probe"]), patch.object(
            probe, "probe", return_value={"status": "ok"}
        ):
            self.assertEqual(probe.main(), 0)
        with patch.object(sys, "argv", ["probe"]), patch.object(
            probe, "probe", side_effect=probe.rocm_probe.ProbeError("bad")
        ):
            self.assertEqual(probe.main(), 1)


if __name__ == "__main__":
    unittest.main()
