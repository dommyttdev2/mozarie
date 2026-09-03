from __future__ import annotations

import io
import os
import sys
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import Mock, patch

import setup_gpu_check
from mozarie import runtime_profile
from mozarie.inference import onnx as onnx_module


class _ProbeTensor:
    def __init__(self, value: float = 2.0) -> None:
        self.value = value

    def __add__(self, _value: object) -> "_ProbeTensor":
        return self

    def cpu(self) -> "_ProbeTensor":
        return self

    def item(self) -> float:
        return self.value


class _ProfileOptions:
    def __init__(self) -> None:
        self.entries: dict[str, str] = {}
        self.enable_mem_pattern = True
        self.execution_mode = None

    def add_session_config_entry(self, key: str, value: str) -> None:
        self.entries[key] = value


class _ProfileSession:
    last: "_ProfileSession | None" = None

    def __init__(self, _model, *, sess_options, providers) -> None:
        self.options = sess_options
        self.requested = providers
        type(self).last = self

    @staticmethod
    def disable_fallback() -> None:
        return None

    @staticmethod
    def get_providers():
        return ["DmlExecutionProvider"]

    @staticmethod
    def run(*_args):
        return [[[1.0]]]


class _ProfileHelper:
    @staticmethod
    def make_tensor_value_info(*_args): return object()
    @staticmethod
    def make_node(*_args): return object()
    @staticmethod
    def make_graph(*_args): return object()
    @staticmethod
    def make_opsetid(*_args): return object()
    @staticmethod
    def make_model(*_args, **_kwargs): return SimpleNamespace(SerializeToString=lambda: b"model")


class WindowsRocmRuntimeProfileTests(unittest.TestCase):
    def test_normalize_accepts_rocm(self) -> None:
        self.assertEqual(runtime_profile.normalize_profile(" ROCM "), "rocm")
        with self.assertRaisesRegex(runtime_profile.ProfileError, "rocm"):
            runtime_profile.normalize_profile("migraphx")

    def test_directml_distribution_is_classified_as_rocm_only_for_rocm_torch(self) -> None:
        def rocm_version(name: str) -> str:
            if name == "torch-directml":
                raise runtime_profile.metadata.PackageNotFoundError
            if name == "torch":
                return "2.11.0+rocm7.13.0"
            raise AssertionError(name)

        with patch.object(runtime_profile, "installed_distributions", return_value={"onnxruntime-directml": "1.24.4"}), \
                patch.object(runtime_profile.metadata, "version", side_effect=rocm_version):
            self.assertEqual(runtime_profile.installed_profile(), "rocm")
        with patch.object(runtime_profile, "installed_distributions", return_value={"onnxruntime-directml": "1.24.4"}), \
                patch.object(runtime_profile.metadata, "version", return_value="0.2.5.dev240914"):
            self.assertEqual(runtime_profile.installed_profile(), "directml")
        with patch.object(runtime_profile, "installed_distributions", return_value={"onnxruntime-directml": "1.24.4"}), \
                patch.object(runtime_profile.metadata, "version", side_effect=runtime_profile.metadata.PackageNotFoundError):
            self.assertEqual(runtime_profile.installed_profile(), "directml")

    def test_preflight_rocm_requires_directml_ep(self) -> None:
        good = SimpleNamespace(get_available_providers=lambda: ["DmlExecutionProvider"])
        with patch.object(runtime_profile, "installed_profile", return_value="rocm"), patch.dict(sys.modules, {"onnxruntime": good}):
            runtime_profile.preflight("rocm")
        bad = SimpleNamespace(get_available_providers=lambda: ["CPUExecutionProvider"])
        with patch.object(runtime_profile, "installed_profile", return_value="rocm"), patch.dict(sys.modules, {"onnxruntime": bad}):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "DmlExecutionProvider"):
                runtime_profile.preflight("rocm")

    def test_rocm_onnx_probe_has_no_cpu_provider_and_disables_cpu_fallback(self) -> None:
        ort = SimpleNamespace(
            SessionOptions=_ProfileOptions,
            ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL="sequential"),
            InferenceSession=_ProfileSession,
        )
        onnx = SimpleNamespace(helper=_ProfileHelper(), TensorProto=SimpleNamespace(FLOAT=1))
        fake_np = SimpleNamespace(float32="float32", ones=lambda *_args, **_kwargs: [[1.0]])
        identity = SimpleNamespace(device_count=lambda: 1, device_name=lambda _index: "AMD Radeon RX 6600M")
        with patch("mozarie.runtime.directml_onnx_device_id", return_value=2):
            provider = runtime_profile._probe_onnx(ort, onnx, fake_np, "rocm", 0, directml_identity=identity)
        self.assertEqual(provider, "DmlExecutionProvider")
        session = _ProfileSession.last
        self.assertIsNotNone(session)
        assert session is not None
        self.assertEqual(session.requested, [("DmlExecutionProvider", {"device_id": 2})])
        self.assertEqual(session.options.entries, {runtime_profile.CPU_FALLBACK_CONFIG: "1"})
        self.assertFalse(session.options.enable_mem_pattern)
        self.assertEqual(session.options.execution_mode, "sequential")
        with self.assertRaisesRegex(runtime_profile.ProfileError, "identity is required"):
            runtime_profile._probe_onnx(ort, onnx, fake_np, "rocm", 0)

    def test_validate_rocm_uses_hip_torch(self) -> None:
        cuda = SimpleNamespace(
            is_available=lambda: True,
            device_count=lambda: 1,
            get_device_name=lambda _index: "AMD Radeon RX 6600M",
        )
        torch = SimpleNamespace(
            version=SimpleNamespace(hip="7.13.99004", cuda=None),
            cuda=cuda,
            ones=lambda *_args, **_kwargs: _ProbeTensor(),
        )
        ort = SimpleNamespace(get_available_providers=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"])
        modules = {"numpy": SimpleNamespace(), "onnx": SimpleNamespace(), "onnxruntime": ort, "torch": torch}
        with patch.object(runtime_profile, "installed_profile", return_value="rocm"), \
                patch.object(runtime_profile, "_probe_onnx", return_value="DmlExecutionProvider") as probe_onnx, \
                patch.dict(sys.modules, modules):
            result = runtime_profile.validate("rocm")
        self.assertEqual(result["profile"], "rocm")
        self.assertEqual(result["devices"], ["AMD Radeon RX 6600M"])
        identity = probe_onnx.call_args.kwargs["directml_identity"]
        self.assertEqual(identity.device_count(), 1)
        self.assertEqual(identity.device_name(0), "AMD Radeon RX 6600M")

    def test_validate_rocm_failure_modes(self) -> None:
        providers = SimpleNamespace(get_available_providers=lambda: [])
        torch = SimpleNamespace(
            version=SimpleNamespace(hip="7.13", cuda=None),
            cuda=SimpleNamespace(is_available=lambda: True, device_count=lambda: 1, get_device_name=lambda _i: "GPU"),
            ones=lambda *_args, **_kwargs: _ProbeTensor(),
        )
        modules = {"numpy": SimpleNamespace(), "onnx": SimpleNamespace(), "onnxruntime": providers, "torch": torch}
        with patch.object(runtime_profile, "installed_profile", return_value="rocm"), patch.dict(sys.modules, modules):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "DmlExecutionProvider"):
                runtime_profile.validate("rocm")
        providers.get_available_providers = lambda: ["DmlExecutionProvider"]
        for hip, cuda_version, available, count, device, value, message in (
            (None, None, True, 1, 0, 2.0, "ROCm/HIP"),
            ("7.13", "13.0", True, 1, 0, 2.0, "ROCm/HIP"),
            ("7.13", None, False, 1, 0, 2.0, "usable HIP"),
            ("7.13", None, True, 0, 0, 2.0, "did not find"),
            ("7.13", None, True, 1, 2, 2.0, "device 2"),
            ("7.13", None, True, 1, 0, 0.0, "tensor probe"),
        ):
            with self.subTest(message=message):
                torch.version = SimpleNamespace(hip=hip, cuda=cuda_version)
                torch.cuda = SimpleNamespace(is_available=lambda a=available: a, device_count=lambda c=count: c, get_device_name=lambda _i: "GPU")
                torch.ones = lambda *_args, v=value, **_kwargs: _ProbeTensor(v)
                with patch.object(runtime_profile, "installed_profile", return_value="rocm"), patch.dict(sys.modules, modules):
                    with self.assertRaisesRegex(runtime_profile.ProfileError, message):
                        runtime_profile.validate("rocm", device)

    def test_rocm_onnx_identity_uses_torch_names_without_torch_directml(self) -> None:
        cuda = SimpleNamespace(device_count=lambda: 1, get_device_name=lambda _i: "AMD Radeon RX 6600M")
        torch = SimpleNamespace(cuda=cuda)
        with patch.dict(sys.modules, {"torch": torch}), \
                patch.object(onnx_module, "torch_backend", return_value="rocm"), \
                patch.object(onnx_module, "directml_module") as directml, \
                patch.object(onnx_module, "_dxgi_adapter_names", return_value=[object()]), \
                patch.object(onnx_module, "directml_onnx_device_id", return_value=2) as map_device:
            self.assertEqual(onnx_module._directml_onnx_device_id(0), 2)
        directml.assert_not_called()
        identity = map_device.call_args.kwargs["module"]
        self.assertEqual(identity.device_name(0), "AMD Radeon RX 6600M")

    def test_rocm_onnx_provider_list_excludes_cpu(self) -> None:
        with patch.dict(os.environ, {"MOZARIE_RUNTIME": "rocm"}), \
                patch.object(onnx_module.ort, "get_available_providers", return_value=["DmlExecutionProvider", "CPUExecutionProvider"]), \
                patch.object(onnx_module, "_directml_onnx_device_id", return_value=0):
            self.assertEqual(onnx_module.available_providers("gpu", 0), [("DmlExecutionProvider", {"device_id": 0})])

    def test_setup_gpu_check_accepts_rocm(self) -> None:
        store = SimpleNamespace(load=Mock(return_value={"models": {"gpu_device": 0}}), save=Mock())
        output = io.StringIO()
        with patch.object(setup_gpu_check, "SettingsStore", return_value=store), \
                patch.object(setup_gpu_check, "selected_profile", return_value="rocm"), \
                patch.object(setup_gpu_check, "validate") as validate, redirect_stdout(output):
            self.assertEqual(setup_gpu_check.main(), 0)
        validate.assert_called_once_with("rocm", 0)
        self.assertIn("ROCm/DirectML GPU 0 is ready", output.getvalue())

        output = io.StringIO()
        with patch.object(setup_gpu_check, "SettingsStore", return_value=store), \
                patch.object(setup_gpu_check, "selected_profile", return_value="rocm"), \
                patch.object(setup_gpu_check, "validate", side_effect=RuntimeError("bad")), redirect_stdout(output):
            self.assertEqual(setup_gpu_check.main(), 1)
        self.assertIn("ROCm/DirectML runtime could not start", output.getvalue())


if __name__ == "__main__":
    unittest.main()
