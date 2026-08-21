from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mozarie.inference.generic_yolo_segment import GenericYoloSegmenter, _class_names
from mozarie.inference.onnx import Letterbox, class_aware_nms_indices, create_session, nms_indices
from mozarie.inference.yolo_detect import HandDetector
from mozarie.inference.yolo_segment import TargetSegmenter


class OnnxAdapterTests(unittest.TestCase):
    def test_nms_keeps_highest_score_and_other_classes(self) -> None:
        boxes = [(0, 0, 10, 10), (1, 1, 9, 9), (20, 20, 30, 30)]
        self.assertEqual(nms_indices(boxes, [0.9, 0.8, 0.7], 0.5), [0, 2])
        self.assertEqual(class_aware_nms_indices(boxes[:2], [0.9, 0.8], ["penis", "pussy"], 0.5), [0, 1])

    def test_create_session_prefers_cuda_then_allows_cpu_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.onnx"
            path.write_bytes(b"model")
            cuda_session = Mock()
            cuda_session.get_providers.return_value = ["CUDAExecutionProvider", "CPUExecutionProvider"]
            cpu_session = Mock()
            cpu_session.get_providers.return_value = ["CPUExecutionProvider"]
            with patch("mozarie.inference.onnx.ort.preload_dlls") as preload, patch(
                "mozarie.inference.onnx.ort.get_available_providers",
                return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
            ), patch("mozarie.inference.onnx.ort.InferenceSession", side_effect=[cuda_session, cpu_session]) as create:
                self.assertIs(create_session(path, "gpu", 2), cuda_session)
                self.assertIs(create_session(path, "cpu"), cpu_session)
            preload.assert_called_once_with()
            self.assertEqual(create.call_args_list[0].kwargs["providers"], [("CUDAExecutionProvider", {"device_id": 2}), "CPUExecutionProvider"])
            self.assertEqual(create.call_args_list[1].kwargs["providers"], ["CPUExecutionProvider"])

    def test_target_decoder_identifies_reversed_outputs_and_channel_first_rows(self) -> None:
        prediction = np.zeros((1, 43, 2), dtype=np.float32)
        prototype = np.zeros((1, 32, 4, 4), dtype=np.float32)
        resolved_prediction, resolved_prototype = TargetSegmenter._outputs([prototype, prediction])
        self.assertIs(resolved_prediction, prediction)
        self.assertIs(resolved_prototype, prototype)
        self.assertEqual(TargetSegmenter._prediction_rows(prediction).shape, (2, 43))

    def test_target_detect_decodes_a_target_class(self) -> None:
        detector = TargetSegmenter.__new__(TargetSegmenter)
        detector.input_size = 10
        prediction = np.zeros((1, 43, 1), dtype=np.float32)
        prediction[0, :4, 0] = (5, 5, 6, 6)
        prediction[0, 6, 0] = 0.9  # class 2: penis
        prediction[0, -32:, 0] = 1.0
        detector.run = lambda _tensor: [prediction, np.ones((1, 32, 4, 4), dtype=np.float32)]
        transform = Letterbox(1, 0, 0, 10, 10, 10, 10)
        with patch("mozarie.inference.yolo_segment.letterbox_bgr", return_value=(np.zeros((1, 3, 10, 10)), transform)):
            segments = detector.detect(np.zeros((10, 10, 3), dtype=np.uint8), 0.5)
        self.assertEqual([(segment["class_name"], segment["source"]) for segment in segments], [("penis", "target")])

    def test_generic_decoder_uses_metadata_and_both_row_orientations(self) -> None:
        self.assertEqual(_class_names({"names": "{0: 'vagina', 1: 'penis'}"}), ("vagina", "penis"))
        self.assertEqual(_class_names({"names": "['penis', 'vagina']"}), ("penis", "vagina"))
        detector = GenericYoloSegmenter.__new__(GenericYoloSegmenter)
        detector.class_names = ("vagina", "penis")
        channels = 4 + len(detector.class_names) + 32
        self.assertEqual(detector._prediction_rows(np.zeros((1, channels, 3), dtype=np.float32)).shape, (3, channels))
        self.assertEqual(detector._prediction_rows(np.zeros((1, 3, channels), dtype=np.float32)).shape, (3, channels))
        with self.assertRaises(ValueError):
            _class_names({"names": "{1: 'penis'}"})

    def test_generic_detect_maps_vagina_to_pussy(self) -> None:
        detector = GenericYoloSegmenter.__new__(GenericYoloSegmenter)
        detector.input_size = 10
        detector.class_names = ("vagina", "penis", "arm")
        channels = 4 + len(detector.class_names) + 32
        prediction = np.zeros((1, channels, 1), dtype=np.float32)
        prediction[0, :4, 0] = (5, 5, 6, 6)
        prediction[0, 4, 0] = 0.9
        prediction[0, 4 + len(detector.class_names):, 0] = 1.0
        detector.run = lambda _tensor: [prediction, np.ones((1, 32, 4, 4), dtype=np.float32)]
        transform = Letterbox(1, 0, 0, 10, 10, 10, 10)
        with patch("mozarie.inference.generic_yolo_segment.letterbox_bgr", return_value=(np.zeros((1, 3, 10, 10)), transform)):
            segments = detector.detect(np.zeros((10, 10, 3), dtype=np.uint8), 0.5, "generic")
        self.assertEqual([(segment["class_name"], segment["source"]) for segment in segments], [("pussy", "generic")])

    def test_hand_decoder_accepts_both_export_orientations(self) -> None:
        detector = HandDetector.__new__(HandDetector)
        detector.input_size = 10
        tensor = np.zeros((1, 3, 10, 10), dtype=np.float32)
        transform = Letterbox(1, 0, 0, 10, 10, 10, 10)
        with patch("mozarie.inference.yolo_detect.letterbox_bgr", return_value=(tensor, transform)):
            for output in (
                np.asarray([[[5.0], [5.0], [6.0], [6.0], [0.9]]], dtype=np.float32),
                np.asarray([[[5.0, 5.0, 6.0, 6.0, 0.9]]], dtype=np.float32),
            ):
                detector.run = lambda _tensor, value=output: [value]
                self.assertEqual(detector.detect_boxes(np.zeros((10, 10, 3), dtype=np.uint8), 0.5), [(2, 2, 8, 8)])
