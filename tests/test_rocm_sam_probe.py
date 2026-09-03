from __future__ import annotations

import io
import sys
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from mozarie import rocm_sam_probe


class FakeCuda:
    def __init__(self):
        self.selected = None
        self.synced = []
        self.empty_calls = 0

    def set_device(self, index):
        self.selected = index

    def synchronize(self, device):
        self.synced.append(device)

    def empty_cache(self):
        self.empty_calls += 1


class InferenceMode:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None


class FakeTorch:
    def __init__(self):
        self.cuda = FakeCuda()

    @staticmethod
    def device(value):
        return value

    @staticmethod
    def inference_mode():
        return InferenceMode()


class FakeModel:
    def __init__(self, *, parameter_device="cpu"):
        self.parameter = SimpleNamespace(device=parameter_device)

    def to(self, *, device):
        self.parameter.device = device
        return self

    def parameters(self):
        yield self.parameter


class WrongDeviceModel(FakeModel):
    def to(self, *, device):
        return self


class FakePredictor:
    feature_device = "cuda:0"
    masks = np.zeros((1, 64, 64), dtype=bool)
    scores = np.asarray([0.5], dtype=np.float32)
    logits = np.zeros((1, 256, 256), dtype=np.float32)
    last = None

    def __init__(self, model):
        self.model = model
        self.features = None
        self.reset = False
        FakePredictor.last = self

    def set_image(self, _image):
        self.features = SimpleNamespace(device=self.feature_device)

    def predict(self, **_kwargs):
        return self.masks, self.scores, self.logits

    def reset_image(self):
        self.reset = True


class RocmSamProbeTests(unittest.TestCase):
    def setUp(self):
        FakePredictor.feature_device = "cuda:0"
        FakePredictor.masks = np.zeros((1, 64, 64), dtype=bool)
        FakePredictor.scores = np.asarray([0.5], dtype=np.float32)
        FakePredictor.logits = np.zeros((1, 256, 256), dtype=np.float32)
        FakePredictor.last = None

    def test_validate_sam_outputs_success_and_failures(self):
        result = rocm_sam_probe.validate_sam_outputs(
            np,
            FakePredictor.masks,
            FakePredictor.scores,
            FakePredictor.logits,
            image_size=64,
        )
        self.assertTrue(result["finite"])

        cases = [
            (np.zeros((2, 64, 64)), FakePredictor.scores, FakePredictor.logits, "mask shape"),
            (FakePredictor.masks, np.asarray([0.1, 0.2]), FakePredictor.logits, "score shape"),
            (FakePredictor.masks, FakePredictor.scores, np.zeros((1, 8)), "logits shape"),
            (FakePredictor.masks, FakePredictor.scores, np.zeros((2, 8, 8)), "logits shape"),
            (FakePredictor.masks, np.asarray([np.nan]), FakePredictor.logits, "non-finite score"),
            (FakePredictor.masks, FakePredictor.scores, np.full((1, 8, 8), np.nan), "non-finite mask logits"),
        ]
        for masks, scores, logits, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(rocm_sam_probe.rocm_probe.ProbeError, message):
                rocm_sam_probe.validate_sam_outputs(np, masks, scores, logits, image_size=64)

    def test_run_sam_vit_b_success(self):
        torch = FakeTorch()
        registry = {"vit_b": lambda checkpoint=None: FakeModel()}
        result = rocm_sam_probe.run_sam_vit_b(torch, np, FakePredictor, registry, 0)
        self.assertEqual(result["modelType"], "vit_b")
        self.assertTrue(result["finite"])
        self.assertEqual(torch.cuda.synced, ["cuda:0"])
        self.assertEqual(torch.cuda.empty_calls, 1)
        self.assertTrue(FakePredictor.last.reset)

    def test_run_sam_rejects_wrong_model_and_feature_devices(self):
        torch = FakeTorch()
        registry = {"vit_b": lambda checkpoint=None: WrongDeviceModel(parameter_device="cpu")}
        with self.assertRaisesRegex(rocm_sam_probe.rocm_probe.ProbeError, "SAM model is on"):
            rocm_sam_probe.run_sam_vit_b(torch, np, FakePredictor, registry, 0)
        self.assertEqual(torch.cuda.empty_calls, 1)
        self.assertIsNone(FakePredictor.last)

        torch = FakeTorch()
        FakePredictor.feature_device = "cpu"
        registry = {"vit_b": lambda checkpoint=None: FakeModel()}
        with self.assertRaisesRegex(rocm_sam_probe.rocm_probe.ProbeError, "image embedding"):
            rocm_sam_probe.run_sam_vit_b(torch, np, FakePredictor, registry, 0)
        self.assertTrue(FakePredictor.last.reset)
        self.assertEqual(torch.cuda.empty_calls, 1)

    def test_probe_with_injected_dependencies(self):
        torch = FakeTorch()
        registry = {"vit_b": lambda checkpoint=None: FakeModel()}
        with patch.object(rocm_sam_probe.rocm_probe, "validate_host") as host, \
             patch.object(rocm_sam_probe.rocm_probe, "validate_rocm_torch", return_value={"torchVersion": "t", "hipVersion": "h", "deviceCount": 1}), \
             patch.object(rocm_sam_probe.rocm_probe, "select_device", return_value=(0, [{"index": 0, "gfx": "gfx1032"}])):
            result = rocm_sam_probe.probe(
                torch_module=torch,
                np_module=np,
                sam_predictor_type=FakePredictor,
                sam_model_registry=registry,
            )
        host.assert_called_once_with()
        self.assertEqual(torch.cuda.selected, 0)
        self.assertEqual(result["expectedGfx"], "gfx1032")
        self.assertTrue(result["sam"]["finite"])

    def test_probe_imports_all_missing_dependencies(self):
        fake_torch = FakeTorch()
        fake_segment = types.ModuleType("segment_anything")
        fake_segment.SamPredictor = FakePredictor
        fake_segment.sam_model_registry = {"vit_b": lambda checkpoint=None: FakeModel()}
        with patch.dict(sys.modules, {"torch": fake_torch, "segment_anything": fake_segment}), \
             patch.object(rocm_sam_probe.rocm_probe, "validate_rocm_torch", return_value={}), \
             patch.object(rocm_sam_probe.rocm_probe, "select_device", return_value=(0, [{"index": 0, "gfx": "gfx1032"}])):
            result = rocm_sam_probe.probe()
        self.assertEqual(result["status"], "ok")

    def test_probe_imports_only_missing_sam_parts(self):
        fake_segment = types.ModuleType("segment_anything")
        fake_segment.SamPredictor = FakePredictor
        registry = {"vit_b": lambda checkpoint=None: FakeModel()}
        fake_segment.sam_model_registry = registry
        torch = FakeTorch()
        common = dict(torch_module=torch, np_module=np)

        with patch.dict(sys.modules, {"segment_anything": fake_segment}), \
             patch.object(rocm_sam_probe.rocm_probe, "validate_rocm_torch", return_value={}), \
             patch.object(rocm_sam_probe.rocm_probe, "select_device", return_value=(0, [{"index": 0, "gfx": "gfx1032"}])):
            self.assertEqual(
                rocm_sam_probe.probe(**common, sam_predictor_type=None, sam_model_registry=registry)["status"],
                "ok",
            )
            self.assertEqual(
                rocm_sam_probe.probe(**common, sam_predictor_type=FakePredictor, sam_model_registry=None)["status"],
                "ok",
            )

    def test_probe_imports_missing_torch_without_reloading_sam(self):
        fake_torch = FakeTorch()
        registry = {"vit_b": lambda checkpoint=None: FakeModel()}
        with patch.dict(sys.modules, {"torch": fake_torch}), \
             patch.object(rocm_sam_probe.rocm_probe, "validate_rocm_torch", return_value={}), \
             patch.object(rocm_sam_probe.rocm_probe, "select_device", return_value=(0, [{"index": 0, "gfx": "gfx1032"}])):
            result = rocm_sam_probe.probe(
                torch_module=None,
                np_module=np,
                sam_predictor_type=FakePredictor,
                sam_model_registry=registry,
            )
        self.assertEqual(result["status"], "ok")

    def test_probe_dependency_import_failure(self):
        original_import = __import__

        def fake_import(name, *args, **kwargs):
            if name == "torch":
                raise ImportError("missing torch")
            return original_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=fake_import):
            with self.assertRaisesRegex(rocm_sam_probe.rocm_probe.ProbeError, "missing torch"):
                rocm_sam_probe.probe()

    def test_main_success_and_failure(self):
        stdout = io.StringIO()
        with patch.object(sys, "argv", ["rocm_sam_probe", "--device-index", "0", "--expected-gfx", "gfx1032"]), \
             patch.object(rocm_sam_probe, "probe", return_value={"status": "ok"}) as probe, \
             redirect_stdout(stdout):
            self.assertEqual(rocm_sam_probe.main(), 0)
        probe.assert_called_once_with(0, "gfx1032")
        self.assertIn('"status": "ok"', stdout.getvalue())

        stderr = io.StringIO()
        with patch.object(sys, "argv", ["rocm_sam_probe"]), \
             patch.object(rocm_sam_probe, "probe", side_effect=rocm_sam_probe.rocm_probe.ProbeError("boom")), \
             redirect_stderr(stderr):
            self.assertEqual(rocm_sam_probe.main(), 1)
        self.assertIn("boom", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
