from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import runtime_profile


class RuntimeProfileTests(unittest.TestCase):
    def test_onnx_probe_runs_on_the_selected_directml_device(self) -> None:
        session = SimpleNamespace(
            disable_fallback=lambda: None,
            get_providers=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
            run=lambda *_args: [[[1.0]]],
        )
        ort = SimpleNamespace(
            SessionOptions=lambda: SimpleNamespace(),
            ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL="sequential"),
            InferenceSession=lambda *_args, **kwargs: session,
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

        with patch("mozarie.runtime.directml_ort_device_id", return_value=3):
            self.assertEqual(runtime_profile._probe_onnx(ort, onnx, np, "directml", 1), "DmlExecutionProvider")

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


if __name__ == "__main__":
    unittest.main()
