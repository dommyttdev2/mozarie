from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import onnx
from onnx import TensorProto, helper

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mozarie.inference.onnx import Letterbox, nms_indices, restore_box
from mozarie.inference.yolo_detect import HandDetector
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

    def test_target_decoder_identifies_outputs_without_session_order(self) -> None:
        prediction = np.zeros((1, 43, 10), dtype=np.float32)
        prototype = np.zeros((1, 32, 20, 20), dtype=np.float32)
        resolved_prediction, resolved_prototype = TargetSegmenter._outputs([prototype, prediction])
        self.assertEqual(resolved_prediction.shape, prediction.shape)
        self.assertEqual(resolved_prototype.shape, prototype.shape)

    def test_hand_decoder_accepts_both_supported_orientations(self) -> None:
        detector = HandDetector.__new__(HandDetector)
        detector.input_size = 640
        tensor = np.zeros((1, 3, 640, 640), dtype=np.float32)
        detector.run = lambda _tensor: [np.asarray([[[320.0], [320.0], [100.0], [100.0], [0.9]]], dtype=np.float32)]
        with patch("mozarie.inference.yolo_detect.letterbox_bgr", return_value=(tensor, Letterbox(1, 0, 0, 640, 640, 640, 640))):
            self.assertEqual(len(detector.detect_boxes(np.zeros((640, 640, 3), dtype=np.uint8), 0.5)), 1)
        detector.run = lambda _tensor: [np.asarray([[[320.0, 320.0, 100.0, 100.0, 0.9]]], dtype=np.float32)]
        with patch("mozarie.inference.yolo_detect.letterbox_bgr", return_value=(tensor, Letterbox(1, 0, 0, 640, 640, 640, 640))):
            self.assertEqual(len(detector.detect_boxes(np.zeros((640, 640, 3), dtype=np.uint8), 0.5)), 1)

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

            reversed_path = self._write_model(root, "target-reversed.onnx", [image], [prototype, prediction])
            self.assertEqual(validate_target_profile(reversed_path).kind, "target_segmentation")
            nhwc = helper.make_tensor_value_info("images", TensorProto.FLOAT, [1, 1280, 1280, 3])
            with self.assertRaises(ModelProfileError):
                validate_target_profile(self._write_model(root, "target-nhwc.onnx", [nhwc], [prediction, prototype]))
            wrong_size = helper.make_tensor_value_info("images", TensorProto.FLOAT, [1, 3, 1024, 1024])
            with self.assertRaises(ModelProfileError):
                validate_target_profile(self._write_model(root, "target-size.onnx", [wrong_size], [prediction, prototype]))
            float16 = helper.make_tensor_value_info("images", TensorProto.FLOAT16, [1, 3, None, None])
            with self.assertRaises(ModelProfileError):
                validate_target_profile(self._write_model(root, "target-f16.onnx", [float16], [prediction, prototype]))

    def test_hand_profile_requires_single_xywh_score_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = helper.make_tensor_value_info("images", TensorProto.FLOAT, [1, 3, 640, 640])
            output = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, None, 5])
            path = self._write_model(root, "hand.onnx", [image], [output])
            self.assertEqual(validate_hand_profile(path).kind, "hand_detection")
            transposed = self._write_model(root, "hand-transposed.onnx", [image], [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 5, None])])
            self.assertEqual(validate_hand_profile(transposed).kind, "hand_detection")
            incompatible = self._write_model(root, "bad-hand.onnx", [image], [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, None, 6])])
            with self.assertRaises(ModelProfileError):
                validate_hand_profile(incompatible)
            wrong_size = helper.make_tensor_value_info("images", TensorProto.FLOAT, [1, 3, 1280, 1280])
            with self.assertRaises(ModelProfileError):
                validate_hand_profile(self._write_model(root, "hand-size.onnx", [wrong_size], [output]))
