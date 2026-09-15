from __future__ import annotations

from types import SimpleNamespace
import unittest
from unittest.mock import patch

from mozarie import runtime as runtime_module
from mozarie import runtime_profile


class RuntimeProfileDirectMlIdentityTests(unittest.TestCase):
    @staticmethod
    def _onnx_dependencies(captured: dict[str, object]):
        session = SimpleNamespace(
            disable_fallback=lambda: None,
            get_providers=lambda: ["DmlExecutionProvider"],
            run=lambda *_args: [[[1.0]]],
        )
        options = SimpleNamespace()

        def inference_session(*_args, **kwargs):
            captured["providers"] = kwargs["providers"]
            return session

        ort = SimpleNamespace(
            SessionOptions=lambda: options,
            ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL="sequential"),
            InferenceSession=inference_session,
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

    def test_setup_probe_maps_reverse_directml_order_to_dxgi_index(self) -> None:
        captured: dict[str, object] = {}
        ort, onnx, np = self._onnx_dependencies(captured)
        directml = SimpleNamespace(
            device_count=lambda: 2,
            device_name=lambda index: [
                "AMD Radeon(TM) Graphics",
                "AMD Radeon RX 6600M",
            ][index],
        )
        adapters = [
            runtime_module.DxgiDevice(index=0, name="AMD Radeon RX 6600M"),
            runtime_module.DxgiDevice(index=1, name="AMD Radeon(TM) Graphics"),
        ]

        with patch("mozarie.runtime._dxgi_adapter_names", return_value=adapters):
            self.assertEqual(
                runtime_profile._probe_onnx(
                    ort,
                    onnx,
                    np,
                    "directml",
                    1,
                    directml_identity=directml,
                ),
                "DmlExecutionProvider",
            )

        self.assertEqual(
            captured["providers"],
            [("DmlExecutionProvider", {"device_id": 0}), "CPUExecutionProvider"],
        )

    def test_setup_probe_fails_closed_when_directml_mapping_is_unavailable(self) -> None:
        captured: dict[str, object] = {}
        ort, onnx, np = self._onnx_dependencies(captured)
        directml = SimpleNamespace(
            device_count=lambda: 1,
            device_name=lambda _index: "AMD Radeon RX 6600M",
        )

        with patch("mozarie.runtime._dxgi_adapter_names", return_value=[]):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "could not be mapped"):
                runtime_profile._probe_onnx(
                    ort,
                    onnx,
                    np,
                    "directml",
                    0,
                    directml_identity=directml,
                )

        self.assertNotIn("providers", captured)


if __name__ == "__main__":
    unittest.main()
