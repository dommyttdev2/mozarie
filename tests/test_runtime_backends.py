from __future__ import annotations

import os
import types
import unittest
from unittest.mock import patch

from mozarie.runtime import RuntimeDevice, configured_backend, directml_devices, patch_directml_sam_prompt_encoder, runtime_backend, torch_device


class RuntimeBackendTests(unittest.TestCase):
    def test_runtime_device_payload_and_configuration_validation(self) -> None:
        self.assertEqual(
            RuntimeDevice(3, "GPU", "cuda", False, "sm_90", 1024).payload(),
            {"id": 3, "name": "GPU", "backend": "cuda", "supported": False, "architecture": "sm_90", "totalMemory": 1024},
        )
        self.assertEqual(RuntimeDevice(0, "CPU", "cpu").payload(), {"id": 0, "name": "CPU", "backend": "cpu", "supported": True})
        for value, expected in ((" CUDA ", "cuda"), ("invalid", None), ("", None)):
            with self.subTest(value=value), patch.dict(os.environ, {"MOZARIE_RUNTIME": value}):
                self.assertEqual(configured_backend(), expected)

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

    def test_runtime_backend_uses_torch_directml_and_cpu_fallbacks(self) -> None:
        torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True))
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(runtime_backend(torch_module=torch), "cuda")
        no_cuda = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
        directml = types.SimpleNamespace(device_count=lambda: 1)
        with patch.dict(os.environ, {}, clear=True), patch("mozarie.runtime.importlib.import_module", return_value=directml):
            self.assertEqual(runtime_backend(torch_module=no_cuda), "directml")
        with patch.dict(os.environ, {}, clear=True), patch("mozarie.runtime.importlib.import_module", return_value=types.SimpleNamespace(device_count=lambda: 0)):
            self.assertEqual(runtime_backend(torch_module=no_cuda), "cpu")
        for error in (ImportError(), OSError(), RuntimeError()):
            with self.subTest(error=type(error).__name__), patch.dict(os.environ, {}, clear=True), patch("mozarie.runtime.importlib.import_module", side_effect=error):
                self.assertEqual(runtime_backend(torch_module=no_cuda), "cpu")
        cpu_ort = types.SimpleNamespace(get_available_providers=lambda: ["CPUExecutionProvider"])
        with patch.dict(os.environ, {}, clear=True), patch("mozarie.runtime.importlib.import_module", side_effect=ImportError()):
            self.assertEqual(runtime_backend(ort_module=cpu_ort, torch_module=no_cuda), "cpu")

    def test_torch_device_uses_detected_backend_and_rejects_missing_gpu_runtime(self) -> None:
        torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
        with patch("mozarie.runtime.runtime_backend", return_value="cuda"):
            self.assertEqual(torch_device(torch, "gpu", 4), "cuda:4")
        with patch("mozarie.runtime.runtime_backend", return_value="cpu"):
            with self.assertRaisesRegex(RuntimeError, "No GPU"):
                torch_device(torch, "gpu")

    def test_directml_module_imports_the_runtime_package(self) -> None:
        from mozarie.runtime import directml_module
        module = object()
        with patch("mozarie.runtime.importlib.import_module", return_value=module) as imported:
            self.assertIs(directml_module(), module)
        imported.assert_called_once_with("torch_directml")

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

    def test_directml_sam_patch_preserves_points_boxes_masks_and_padding(self) -> None:
        import numpy as np

        class Tensor:
            def __init__(self, values) -> None:
                self.values = np.asarray(values)
                self.device = "dml:0"

            @property
            def shape(self):
                return self.values.shape

            @property
            def dtype(self):
                return self.values.dtype

            def __add__(self, other):
                return Tensor(self.values + unwrap(other))

            def __radd__(self, other):
                return Tensor(unwrap(other) + self.values)

            def __mul__(self, other):
                return Tensor(self.values * unwrap(other))

            def __rmul__(self, other):
                return Tensor(unwrap(other) * self.values)

            def __neg__(self):
                return Tensor(-self.values)

            def __eq__(self, other):
                return Tensor(self.values == unwrap(other))

            def unsqueeze(self, axis):
                return Tensor(np.expand_dims(self.values, axis))

            def to(self, **_kwargs):
                return self

            def reshape(self, *shape):
                return Tensor(self.values.reshape(*shape))

            def expand(self, *shape):
                shape = tuple(current if requested == -1 else requested for current, requested in zip(self.values.shape, shape))
                return Tensor(np.broadcast_to(self.values, shape).copy())

        def unwrap(value):
            return value.values if isinstance(value, Tensor) else value

        class Torch:
            @staticmethod
            def zeros(shape, **_kwargs):
                return Tensor(np.zeros(shape, dtype=np.float32))

            @staticmethod
            def ones(shape, **_kwargs):
                return Tensor(np.ones(shape, dtype=np.float32))

            @staticmethod
            def full(shape, value, **_kwargs):
                return Tensor(np.full(shape, value, dtype=np.float32))

            @staticmethod
            def tensor(values, **_kwargs):
                return Tensor(values)

            @staticmethod
            def cat(values, dim=0):
                return Tensor(np.concatenate([unwrap(value) for value in values], axis=dim))

            @staticmethod
            def where(condition, left, right):
                return Tensor(np.where(unwrap(condition), unwrap(left), unwrap(right)))

            @staticmethod
            def empty(shape, **_kwargs):
                return Tensor(np.empty(shape, dtype=np.float32))

        torch = Torch()

        class Encoder:
            embed_dim = 4
            image_embedding_size = (2, 2)
            input_image_size = (8, 8)
            pe_layer = types.SimpleNamespace(forward_with_coords=lambda points, _size: torch.zeros((*points.shape[:2], 4)))
            not_a_point_embed = types.SimpleNamespace(weight=torch.full((1, 4), 7.0))
            point_embeddings = [types.SimpleNamespace(weight=torch.full((1, 4), value)) for value in (2.0, 3.0)]
            no_mask_embed = types.SimpleNamespace(weight=torch.full((1, 4), 5.0))

            @staticmethod
            def _get_batch_size(points, boxes, masks):
                for value in (points, boxes, masks):
                    if value is not None:
                        return value[0].shape[0] if isinstance(value, tuple) else value.shape[0]
                return 1

            @staticmethod
            def _embed_boxes(boxes):
                return boxes

            @staticmethod
            def _embed_masks(masks):
                return masks

            @staticmethod
            def _get_device():
                return "cpu"

        encoder = Encoder()
        patch_directml_sam_prompt_encoder(types.SimpleNamespace(prompt_encoder=encoder), torch)
        points = torch.zeros((1, 1, 2))
        labels = torch.tensor([[0]])
        embedded = encoder._embed_points(points, labels, pad=True)
        np.testing.assert_array_equal(embedded.values, np.array([[[2, 2, 2, 2], [7, 7, 7, 7]]], dtype=np.float32))
        boxes = torch.full((1, 1, 4), 11)
        masks = torch.full((1, 4, 2, 2), 9)
        sparse, dense = encoder.forward((points, labels), boxes, masks)
        np.testing.assert_array_equal(sparse.values, np.array([[[2, 2, 2, 2], [11, 11, 11, 11]]], dtype=np.float32))
        np.testing.assert_array_equal(dense.values, np.full((1, 4, 2, 2), 9, dtype=np.float32))
        sparse, dense = encoder.forward(None, None, None)
        np.testing.assert_array_equal(sparse.values, np.empty((1, 0, 4), dtype=np.float32))
        np.testing.assert_array_equal(dense.values, np.full((1, 4, 2, 2), 5, dtype=np.float32))


if __name__ == "__main__":
    unittest.main()
