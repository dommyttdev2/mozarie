from __future__ import annotations

import os
import types
import unittest
from unittest.mock import patch

from mozarie.runtime import (
    DirectMLDeviceMappingError,
    _DxgiAdapter,
    directml_devices,
    directml_ort_device_id,
    patch_directml_sam_prompt_encoder,
    runtime_backend,
    torch_device,
)


class RuntimeBackendTests(unittest.TestCase):
    def test_explicit_runtime_wins_over_detected_providers(self) -> None:
        ort = types.SimpleNamespace(get_available_providers=lambda: ["CUDAExecutionProvider"])
        with patch.dict(os.environ, {"MOZARIE_RUNTIME": "directml"}):
            self.assertEqual(runtime_backend(ort_module=ort), "directml")

    def test_provider_detection_preserves_cuda_and_adds_directml(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            cuda = types.SimpleNamespace(get_available_providers=lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"])
            directml = types.SimpleNamespace(get_available_providers=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"])
            self.assertEqual(runtime_backend(ort_module=cuda), "cuda")
            self.assertEqual(runtime_backend(ort_module=directml), "directml")

    def test_directml_devices_strip_native_null_terminators(self) -> None:
        module = types.SimpleNamespace(
            device_count=lambda: 2,
            device_name=lambda index: ["AMD Radeon Graphics\0", "AMD Radeon RX 6600M\0"][index],
        )
        self.assertEqual(directml_devices(module), [
            {"id": 0, "name": "AMD Radeon Graphics", "backend": "directml", "supported": True},
            {"id": 1, "name": "AMD Radeon RX 6600M", "backend": "directml", "supported": True},
        ])

    def test_torch_device_keeps_cuda_and_uses_directml_device_object(self) -> None:
        torch = types.SimpleNamespace(device=lambda value: f"torch:{value}")
        self.assertEqual(torch_device(torch, "gpu", 2, backend="cuda"), "cuda:2")
        directml = types.SimpleNamespace(device=lambda index: ("dml", index))
        with patch("mozarie.runtime.directml_module", return_value=directml):
            self.assertEqual(torch_device(torch, "gpu", 1, backend="directml"), ("dml", 1))
        self.assertEqual(torch_device(torch, "cpu", 9, backend="directml"), "cpu")

    def test_directml_ort_mapping_uses_luid_not_adapter_name_or_order(self) -> None:
        directml = types.SimpleNamespace(
            device_count=lambda: 2,
            device_name=lambda index: ["Same GPU", "Different spelling"][index],
            device_luid=lambda index: [(20, 0), (10, 0)][index],
        )
        adapters = (_DxgiAdapter("GPU one", (10, 0)), _DxgiAdapter("GPU two", (20, 0)))
        with patch("mozarie.runtime._dxgi_adapters", return_value=adapters):
            self.assertEqual(directml_ort_device_id(0, directml), 1)
            self.assertEqual(directml_ort_device_id(1, directml), 0)

    def test_directml_ort_mapping_rejects_ambiguous_or_unavailable_identity(self) -> None:
        directml = types.SimpleNamespace(device_count=lambda: 2, device_name=lambda _index: "Same GPU")
        with patch("mozarie.runtime._dxgi_adapters", return_value=(
            _DxgiAdapter("Same GPU", (10, 0)), _DxgiAdapter("Same GPU", (20, 0)),
        )):
            with self.assertRaisesRegex(DirectMLDeviceMappingError, "cannot be matched"):
                directml_ort_device_id(1, directml)
        with patch("mozarie.runtime._dxgi_adapters", return_value=()):
            with self.assertRaisesRegex(DirectMLDeviceMappingError, "cannot be matched"):
                directml_ort_device_id(0, directml)

    def test_directml_ort_mapping_rejects_duplicate_luid_matches(self) -> None:
        directml = types.SimpleNamespace(
            device_count=lambda: 1,
            device_name=lambda _index: "GPU",
            adapter_luid=lambda _index: (10, 0),
        )
        with patch("mozarie.runtime._dxgi_adapters", return_value=(
            _DxgiAdapter("GPU A", (10, 0)), _DxgiAdapter("GPU B", (10, 0)),
        )):
            with self.assertRaisesRegex(DirectMLDeviceMappingError, "multiple DXGI adapters"):
                directml_ort_device_id(0, directml)

    def test_directml_ort_mapping_allows_only_the_provably_single_adapter_case(self) -> None:
        directml = types.SimpleNamespace(device_count=lambda: 1, device_name=lambda _index: "Name does not matter")
        with patch("mozarie.runtime._dxgi_adapters", return_value=(_DxgiAdapter("Different name", (10, 0)),)):
            self.assertEqual(directml_ort_device_id(0, directml), 0)
        with self.assertRaisesRegex(DirectMLDeviceMappingError, "unavailable"):
            directml_ort_device_id(1, directml)

    def test_directml_ort_mapping_normalizes_integer_luids(self) -> None:
        directml = types.SimpleNamespace(
            device_count=lambda: 1,
            device_name=lambda _index: "GPU",
            device_luid=lambda _index: (3 << 32) | 7,
        )
        with patch("mozarie.runtime._dxgi_adapters", return_value=(_DxgiAdapter("GPU", (7, 3)),)):
            self.assertEqual(directml_ort_device_id(0, directml), 0)

    def test_directml_sam_patch_does_not_cat_an_empty_sparse_tensor(self) -> None:
        class Encoder:
            embed_dim = 256
            image_embedding_size = (64, 64)
            no_mask_embed = types.SimpleNamespace(weight=None)

            @staticmethod
            def _get_batch_size(_points, _boxes, _masks):
                return 1

            @staticmethod
            def _embed_boxes(boxes):
                return boxes

            @staticmethod
            def _embed_points(_coordinates, _labels, _pad):
                raise AssertionError("the original DirectML-unsafe point embedding must be replaced")

            @staticmethod
            def _embed_masks(masks):
                return masks

            @staticmethod
            def _get_device():
                return "privateuseone:0"

        torch = types.SimpleNamespace(
            empty=lambda *_args, **_kwargs: self.fail("an empty tensor must not be created for a box prompt"),
            cat=lambda *_args, **_kwargs: self.fail("a single box embedding must not be concatenated"),
        )
        encoder = Encoder()
        model = types.SimpleNamespace(prompt_encoder=encoder)
        patch_directml_sam_prompt_encoder(model, torch)
        patched_embed_points = encoder._embed_points
        boxes = object()
        dense = object()
        sparse_result, dense_result = encoder.forward(None, boxes, dense)
        self.assertIs(sparse_result, boxes)
        self.assertIs(dense_result, dense)
        self.assertTrue(encoder._mozarie_directml_safe)
        patch_directml_sam_prompt_encoder(model, torch)
        self.assertIs(encoder._embed_points, patched_embed_points)


if __name__ == "__main__":
    unittest.main()
