from __future__ import annotations

import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

from mozarie import runtime_profile


class RuntimeProfileTests(unittest.TestCase):
    @staticmethod
    def _probe_dependencies(providers: list[str], output: object = None):
        session = SimpleNamespace(
            disable_fallback=lambda: None,
            get_providers=lambda: providers,
            run=lambda *_args: [[[1.0]]] if output is None else output,
        )
        ort = SimpleNamespace(
            SessionOptions=lambda: SimpleNamespace(),
            ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL="sequential"),
            InferenceSession=lambda *_args, **_kwargs: session,
        )
        helper = SimpleNamespace(
            make_tensor_value_info=lambda *_args: object(),
            make_node=lambda *_args: object(),
            make_graph=lambda *_args: object(),
            make_opsetid=lambda *_args: object(),
            make_model=lambda *_args, **_kwargs: SimpleNamespace(SerializeToString=lambda: b"model"),
        )
        onnx = SimpleNamespace(helper=helper, TensorProto=SimpleNamespace(FLOAT=1))
        np = SimpleNamespace(float32="float32", ones=lambda *_args, **_kwargs: [[1.0]])
        return ort, onnx, np

    def test_normalize_and_read_marker_inputs(self) -> None:
        self.assertIsNone(runtime_profile.normalize_profile(None))
        self.assertEqual(runtime_profile.normalize_profile(" CUDA "), "cuda")
        with self.assertRaises(runtime_profile.ProfileError):
            runtime_profile.normalize_profile("openvino")
        with tempfile.TemporaryDirectory() as directory:
            venv = Path(directory)
            self.assertIsNone(runtime_profile.read_marker(venv))
            marker = venv / runtime_profile.MARKER_NAME
            marker.write_text("not json", encoding="utf-8")
            self.assertIsNone(runtime_profile.read_marker(venv))
            marker.write_text("[]", encoding="utf-8")
            self.assertIsNone(runtime_profile.read_marker(venv))
            marker.write_text('{"schema": 1, "profile": "cpu"}', encoding="utf-8")
            self.assertEqual(runtime_profile.read_marker(venv), {"schema": 1, "profile": "cpu"})

    def test_installed_distributions_and_profiles(self) -> None:
        def version(name: str) -> str:
            if name == "onnxruntime-directml":
                return "1.24.4"
            raise runtime_profile.metadata.PackageNotFoundError

        with patch.object(runtime_profile.metadata, "version", side_effect=version):
            self.assertEqual(runtime_profile.installed_distributions(), {"onnxruntime-directml": "1.24.4"})
        with patch.object(runtime_profile, "installed_distributions", return_value={}):
            self.assertIsNone(runtime_profile.installed_profile())
        with patch.object(runtime_profile, "installed_distributions", return_value={"onnxruntime": "1.24.4"}):
            self.assertEqual(runtime_profile.installed_profile(), "cpu")

    def test_preflight_allows_empty_environment_and_rejects_unusable_runtime(self) -> None:
        with patch.object(runtime_profile, "installed_profile", return_value=None):
            runtime_profile.preflight("cuda")
        with patch.object(runtime_profile, "installed_profile", return_value="cuda"):
            with patch.dict(sys.modules, {"onnxruntime": None}):
                with self.assertRaisesRegex(runtime_profile.ProfileError, "cannot be imported"):
                    runtime_profile.preflight("cuda")
        ort = type("Ort", (), {"get_available_providers": staticmethod(lambda: ["CPUExecutionProvider"])})
        with patch.object(runtime_profile, "installed_profile", return_value="cuda"), \
                patch.dict(sys.modules, {"onnxruntime": ort}):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "does not expose"):
                runtime_profile.preflight("cuda")

    def test_show_returns_no_profile_for_missing_or_unsupported_marker_schema(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            venv = Path(directory)
            with patch.dict(os.environ, {}, clear=True):
                self.assertIsNone(runtime_profile.selected_profile(venv))
            runtime_profile.write_marker(venv, {"schema": 2, "profile": "cuda"})
            with patch.dict(os.environ, {}, clear=True):
                self.assertIsNone(runtime_profile.selected_profile(venv))
    def test_onnx_probe_runs_on_the_selected_directml_device(self) -> None:
        ort, onnx, np = self._probe_dependencies(["DmlExecutionProvider", "CPUExecutionProvider"])
        self.assertEqual(runtime_profile._probe_onnx(ort, onnx, np, "directml", 1), "DmlExecutionProvider")

    def test_onnx_probe_supports_cuda_and_cpu_and_rejects_bad_results(self) -> None:
        for profile, provider in (("cuda", "CUDAExecutionProvider"), ("cpu", "CPUExecutionProvider")):
            with self.subTest(profile=profile):
                ort, onnx, np = self._probe_dependencies([provider])
                self.assertEqual(runtime_profile._probe_onnx(ort, onnx, np, profile, 2), provider)
        ort, onnx, np = self._probe_dependencies([], output=[])
        with self.assertRaisesRegex(runtime_profile.ProfileError, "probe failed"):
            runtime_profile._probe_onnx(ort, onnx, np, "cpu", 0)

    def test_validate_cpu_and_main_commands(self) -> None:
        class CpuProbe:
            def __add__(self, _value: object) -> "CpuProbe":
                return self

            def item(self) -> float:
                return 2.0

        cpu_probe = CpuProbe()
        fake_torch = SimpleNamespace(ones=lambda *_args, **_kwargs: cpu_probe)
        fake_ort = SimpleNamespace(get_available_providers=lambda: ["CPUExecutionProvider"])
        with patch.object(runtime_profile, "installed_profile", return_value="cpu"), \
                patch.object(runtime_profile, "_probe_onnx", return_value="CPUExecutionProvider"), \
                patch.dict(sys.modules, {
                    "numpy": SimpleNamespace(),
                    "onnx": SimpleNamespace(),
                    "onnxruntime": fake_ort,
                    "torch": fake_torch,
                }):
            result = runtime_profile.validate("cpu")
        self.assertEqual(result["profile"], "cpu")
        self.assertIsNone(result["validated_device"])

        stdout = io.StringIO()
        with patch.object(sys, "argv", ["runtime_profile.py", "show"]), \
                patch.object(runtime_profile, "selected_profile", return_value="cuda"), redirect_stdout(stdout):
            self.assertEqual(runtime_profile.main(), 0)
        self.assertEqual(stdout.getvalue(), "cuda\n")

        stdout = io.StringIO()
        with patch.object(sys, "argv", ["runtime_profile.py", "show"]), \
                patch.object(runtime_profile, "selected_profile", return_value=None), redirect_stdout(stdout):
            self.assertEqual(runtime_profile.main(), 0)
        self.assertEqual(stdout.getvalue(), "")

        with patch.object(sys, "argv", ["runtime_profile.py", "preflight", "cpu"]), \
                patch.object(runtime_profile, "preflight") as preflight:
            self.assertEqual(runtime_profile.main(), 0)
        preflight.assert_called_once_with("cpu")

        stderr = io.StringIO()
        with patch.object(sys, "argv", ["runtime_profile.py", "preflight"]), redirect_stderr(stderr):
            self.assertEqual(runtime_profile.main(), 1)
        self.assertIn("runtime profile is required", stderr.getvalue())

    def test_rejects_cross_profile_install_before_pip(self) -> None:
        with patch.object(runtime_profile, "installed_profile", return_value="directml"):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "selected cuda"):
                runtime_profile.preflight("cuda")

    def test_rejects_both_onnx_runtime_distributions(self) -> None:
        with patch.object(runtime_profile, "installed_distributions", return_value={
            "onnxruntime-gpu": "1.27.0",
            "onnxruntime-directml": "1.24.4",
        }):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "must not share"):
                runtime_profile.installed_profile()

    def test_cpu_preflight_requires_the_cpu_provider(self) -> None:
        ort = type("Ort", (), {"get_available_providers": staticmethod(lambda: ["CPUExecutionProvider"])})
        with patch.object(runtime_profile, "installed_profile", return_value="cpu"):
            with patch.dict("sys.modules", {"onnxruntime": ort}):
                runtime_profile.preflight("cpu")

    def test_marker_round_trip_and_explicit_override(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            venv = Path(directory)
            runtime_profile.write_marker(venv, {"schema": 1, "profile": "directml"})
            self.assertEqual(json.loads((venv / runtime_profile.MARKER_NAME).read_text(encoding="utf-8"))["profile"], "directml")
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(runtime_profile.selected_profile(venv), "directml")
            with patch.dict(os.environ, {"MOZARIE_RUNTIME": "cuda"}):
                self.assertEqual(runtime_profile.selected_profile(venv), "cuda")

    def test_markerless_profile_is_not_inferred_from_installed_packages(self) -> None:
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(runtime_profile, "installed_profile", side_effect=AssertionError("must not infer")):
            with patch.dict(os.environ, {}, clear=True):
                self.assertIsNone(runtime_profile.selected_profile(Path(directory)))

    def test_invalid_marker_profile_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            venv = Path(directory)
            runtime_profile.write_marker(venv, {"schema": 1, "profile": "invalid"})
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaises(runtime_profile.ProfileError):
                    runtime_profile.selected_profile(venv)


if __name__ == "__main__":
    unittest.main()
