from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import ANY, Mock, patch
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mozarie.inference.generic_yolo_segment import GenericYoloSegmenter, _class_names
from mozarie.inference.onnx import BaseOnnxModel, Letterbox, available_providers, class_aware_nms_indices, create_session, nms_indices
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
            with patch("mozarie.inference.onnx.ort.get_available_providers",
                return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
            ), patch("mozarie.inference.onnx.ort.InferenceSession", side_effect=[cuda_session, cpu_session]) as create:
                self.assertIs(create_session(path, "gpu", 2), cuda_session)
                self.assertIs(create_session(path, "cpu"), cpu_session)
            self.assertEqual(create.call_args_list[0].kwargs["providers"], [(
                "CUDAExecutionProvider",
                {
                    "device_id": 2,
                    "arena_extend_strategy": "kSameAsRequested",
                    "cudnn_conv_algo_search": "HEURISTIC",
                    "cudnn_conv_use_max_workspace": "0",
                    "do_copy_in_default_stream": "1",
                },
            ), "CPUExecutionProvider"])
            self.assertEqual(create.call_args_list[1].kwargs["providers"], ["CPUExecutionProvider"])

    def test_default_gpu_does_not_pass_a_redundant_device_id(self) -> None:
        with patch("mozarie.inference.onnx.ort.get_available_providers", return_value=["CUDAExecutionProvider", "CPUExecutionProvider"]):
            self.assertEqual(available_providers("gpu", 0), [("CUDAExecutionProvider", {
                "arena_extend_strategy": "kSameAsRequested",
                "cudnn_conv_algo_search": "HEURISTIC",
                "cudnn_conv_use_max_workspace": "0",
                "do_copy_in_default_stream": "1",
            }), "CPUExecutionProvider"])

    def test_run_uses_cpu_and_gpu_onnx_runtime_call_shapes(self) -> None:
        cpu = BaseOnnxModel.__new__(BaseOnnxModel)
        cpu.input_name = "image"; cpu.run_options = None; cpu.session = Mock()
        cpu.session.run.return_value = [np.asarray([1])]
        self.assertEqual(cpu.run(np.zeros((1,), dtype=np.float32))[0].tolist(), [1])
        cpu.session.run.assert_called_once_with(None, {"image": ANY})

        gpu = BaseOnnxModel.__new__(BaseOnnxModel)
        gpu.input_name = "image"; gpu.run_options = Mock(); gpu.session = Mock()
        gpu.session.run.return_value = [np.asarray([2])]
        self.assertEqual(gpu.run(np.zeros((1,), dtype=np.float32))[0].tolist(), [2])
        gpu.session.run.assert_called_once_with(None, {"image": ANY}, gpu.run_options)

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

    def test_target_detect_vector_filter_keeps_first_ties_and_row_order(self) -> None:
        detector = TargetSegmenter.__new__(TargetSegmenter)
        detector.input_size = 10
        prediction = np.zeros((1, 43, 4), dtype=np.float32)
        prediction[0, :4, :] = np.asarray([[2, 8, 2, 8], [2, 8, 2, 8], [2, 2, 2, 2], [2, 2, 2, 2]], dtype=np.float32)
        prediction[0, 6, 0] = 0.9  # penis
        prediction[0, 6:8, 1] = 0.9  # tie remains class 2 (penis)
        prediction[0, 7, 2] = 0.95  # pussy
        prediction[0, 4, 3] = 0.99  # unrelated class is discarded
        prediction[0, -32:, :] = 1.0
        detector.run = lambda _tensor: [prediction, np.ones((1, 32, 4, 4), dtype=np.float32)]
        transform = Letterbox(1, 0, 0, 10, 10, 10, 10)
        with patch("mozarie.inference.yolo_segment.letterbox_bgr", return_value=(np.zeros((1, 3, 10, 10)), transform)):
            segments = detector.detect(np.zeros((10, 10, 3), dtype=np.uint8), 0.5)
        self.assertEqual([segment["class_name"] for segment in segments], ["pussy", "penis", "penis"])
        self.assertEqual([round(float(segment["confidence"]), 2) for segment in segments], [0.95, 0.9, 0.9])

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

    def test_generic_detect_vector_filter_keeps_first_ties_and_target_subset(self) -> None:
        detector = GenericYoloSegmenter.__new__(GenericYoloSegmenter)
        detector.input_size = 10; detector.class_names = ("vagina", "penis", "arm")
        channels = 4 + len(detector.class_names) + 32
        prediction = np.zeros((1, channels, 3), dtype=np.float32)
        prediction[0, :4, :] = np.asarray([[2, 8, 2], [2, 8, 2], [2, 2, 2], [2, 2, 2]], dtype=np.float32)
        prediction[0, 4:6, 0] = 0.9  # tie remains vagina (pussy)
        prediction[0, 5, 1] = 0.95  # penis
        prediction[0, 6, 2] = 0.99  # unrelated class is discarded
        prediction[0, 4 + len(detector.class_names):, :] = 1.0
        detector.run = lambda _tensor: [prediction, np.ones((1, 32, 4, 4), dtype=np.float32)]
        transform = Letterbox(1, 0, 0, 10, 10, 10, 10)
        with patch("mozarie.inference.generic_yolo_segment.letterbox_bgr", return_value=(np.zeros((1, 3, 10, 10)), transform)):
            segments = detector.detect(np.zeros((10, 10, 3), dtype=np.uint8), 0.5, "generic")
        self.assertEqual([segment["class_name"] for segment in segments], ["penis", "pussy"])
        self.assertEqual([round(float(segment["confidence"]), 2) for segment in segments], [0.95, 0.9])

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
