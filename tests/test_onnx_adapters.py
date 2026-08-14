from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mozarie.inference.onnx import Letterbox, nms_indices, restore_box
from mozarie.inference.yolo_segment import TargetSegmenter
from mozarie.inference.profiles import ModelProfileError, validate_hand_profile, validate_target_profile


class OnnxAdapterTests(unittest.TestCase):
    def _write_model(self, directory: Path, name: str, inputs, outputs) -> Path:
        path = directory / name
        graph = helper.make_graph([], "profile", inputs, outputs)
        onnx.save(helper.make_model(graph), path)
        return path

    def test_restore_box_reverses_letterbox_coordinates(self) -> None:
        transform = Letterbox(2.0, 10, 20, 100, 100, 40, 30)
        self.assertEqual(restore_box(np.asarray((50, 50, 20, 20)), transform), (15, 10, 25, 20))

    def test_nms_removes_overlapping_lower_confidence_box(self) -> None:
        self.assertEqual(nms_indices([(0, 0, 10, 10), (1, 1, 9, 9), (20, 20, 30, 30)], [0.9, 0.8, 0.7], 0.5), [0, 2])

    def test_segment_rows_accept_channel_first_export(self) -> None:
        rows = TargetSegmenter._prediction_rows(np.zeros((1, 43, 10), dtype=np.float32))
        self.assertEqual(rows.shape, (10, 43))

    def test_target_profile_requires_nchw_43_channel_prediction_and_32_channel_prototype(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = helper.make_tensor_value_info("images", TensorProto.FLOAT, [1, 3, None, None])
            prediction = helper.make_tensor_value_info("prediction", TensorProto.FLOAT, [1, 43, None])
            prototype = helper.make_tensor_value_info("prototype", TensorProto.FLOAT, [1, 32, None, None])
            path = self._write_model(root, "target.onnx", [image], [prediction, prototype])
            profile = validate_target_profile(path)
            self.assertEqual(profile.kind, "target_segmentation")
            incompatible = self._write_model(root, "bad-target.onnx", [image], [prediction])
            with self.assertRaises(ModelProfileError):
                validate_target_profile(incompatible)

    def test_hand_profile_requires_single_xywh_score_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = helper.make_tensor_value_info("images", TensorProto.FLOAT, [1, 3, 640, 640])
            output = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, None, 5])
            path = self._write_model(root, "hand.onnx", [image], [output])
            self.assertEqual(validate_hand_profile(path).kind, "hand_detection")
            incompatible = self._write_model(root, "bad-hand.onnx", [image], [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, None, 6])])
            with self.assertRaises(ModelProfileError):
                validate_hand_profile(incompatible)
