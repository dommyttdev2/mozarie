from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import numpy as np
import onnx
from onnx import TensorProto, helper

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mozarie.inference.onnx import Letterbox, class_aware_nms_indices, create_session, nms_indices, restore_box
from mozarie.inference.yolo_detect import HandDetector
from mozarie.inference.generic_yolo_segment import GenericYoloSegmenter
from mozarie.inference.yolo_segment import TargetSegmenter
from mozarie.inference.profiles import ModelProfileError, validate_generic_yolo_segment_profile, validate_hand_profile, validate_target_profile


class OnnxAdapterTests(unittest.TestCase):
    def _write_model(self, directory: Path, name: str, inputs, outputs, *, metadata: dict[str, str] | None = None) -> Path:
        path = directory / name
        graph = helper.make_graph([], "profile", inputs, outputs)
        model = helper.make_model(graph)
        for key, value in (metadata or {}).items():
            entry = model.metadata_props.add()
            entry.key = key
            entry.value = value
        onnx.save(model, path)
        return path

    def test_restore_box_reverses_letterbox_coordinates(self) -> None:
        transform = Letterbox(2.0, 10, 20, 100, 100, 40, 30)
        self.assertEqual(restore_box(np.asarray((50, 50, 20, 20)), transform), (15, 10, 25, 20))

    def test_nms_removes_overlapping_lower_confidence_box(self) -> None:
        self.assertEqual(nms_indices([(0, 0, 10, 10), (1, 1, 9, 9), (20, 20, 30, 30)], [0.9, 0.8, 0.7], 0.5), [0, 2])

    def test_class_aware_nms_keeps_overlapping_different_classes(self) -> None:
        boxes = [(0, 0, 10, 10), (1, 1, 9, 9), (1, 1, 9, 9)]
        self.assertEqual(class_aware_nms_indices(boxes, [0.9, 0.8, 0.7], ["penis", "pussy", "penis"], 0.5), [0, 1])

    def test_gpu_session_preloads_dlls_and_rejects_cpu_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.onnx"
            path.write_bytes(b"model")
            session = Mock()
            session.get_providers.return_value = ["CPUExecutionProvider"]
            with patch("mozarie.inference.onnx.ort.preload_dlls") as preload, patch(
                "mozarie.inference.onnx.ort.get_available_providers",
                return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
            ), patch("mozarie.inference.onnx.ort.InferenceSession", return_value=session):
                with self.assertRaisesRegex(RuntimeError, "CUDAExecutionProvider"):
                    create_session(path, "gpu")
            preload.assert_called_once_with()

    def test_segment_rows_accept_channel_first_export(self) -> None:
        rows = TargetSegmenter._prediction_rows(np.zeros((1, 43, 10), dtype=np.float32))
        self.assertEqual(rows.shape, (10, 43))

    def test_target_decoder_identifies_outputs_without_session_order(self) -> None:
        prediction = np.zeros((1, 43, 10), dtype=np.float32)
        prototype = np.zeros((1, 32, 20, 20), dtype=np.float32)
        resolved_prediction, resolved_prototype = TargetSegmenter._outputs([prototype, prediction])
        self.assertEqual(resolved_prediction.shape, prediction.shape)
        self.assertEqual(resolved_prototype.shape, prototype.shape)

    def test_generic_segment_decoder_accepts_both_prediction_orientations(self) -> None:
        detector = GenericYoloSegmenter.__new__(GenericYoloSegmenter)
        detector.class_names = ("vagina", "penis", "arm")
        channels = 4 + len(detector.class_names) + 32
        self.assertEqual(detector._prediction_rows(np.zeros((1, channels, 5), dtype=np.float32)).shape, (5, channels))
        self.assertEqual(detector._prediction_rows(np.zeros((1, 5, channels), dtype=np.float32)).shape, (5, channels))
        prediction = np.zeros((1, channels, 5), dtype=np.float32)
        prototype = np.zeros((1, 32, 20, 20), dtype=np.float32)
        resolved_prediction, resolved_prototype = detector._outputs([prototype, prediction])
        self.assertEqual(resolved_prediction.shape, prediction.shape)
        self.assertEqual(resolved_prototype.shape, prototype.shape)

    def test_generic_segment_decoder_returns_only_pussy_and_penis(self) -> None:
        detector = GenericYoloSegmenter.__new__(GenericYoloSegmenter)
        detector.class_names = ("vagina", "penis", "arm")
        detector.input_size = 1024
        channels = 4 + len(detector.class_names) + 32
        prediction = np.zeros((1, channels, 3), dtype=np.float32)
        for index, class_id in enumerate((0, 1, 2)):
            prediction[0, :4, index] = (2 + index * 4, 5, 3, 6)
            prediction[0, 4 + class_id, index] = 0.9
            prediction[0, 4 + len(detector.class_names):, index] = 1.0
        detector.run = lambda _tensor: [prediction, np.ones((1, 32, 4, 4), dtype=np.float32)]
        tensor = np.zeros((1, 3, 1024, 1024), dtype=np.float32)
        with patch("mozarie.inference.generic_yolo_segment.letterbox_bgr", return_value=(tensor, Letterbox(1, 0, 0, 10, 10, 10, 10))):
            segments = detector.detect(np.zeros((10, 10, 3), dtype=np.uint8), 0.5, "ntd11")
        self.assertEqual([segment["class_name"] for segment in segments], ["pussy", "penis"])
        self.assertTrue(all(segment["source"] == "ntd11" for segment in segments))

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

    def test_hand_decoder_rejects_unsupported_runtime_outputs(self) -> None:
        valid = np.zeros((1, 5, 1), dtype=np.float32)
        valid[0, 4, 0] = 0.5
        invalid_outputs = [
            [valid, valid],
            [np.zeros((5, 1), dtype=np.float32)],
            [np.zeros((1, 1, 5, 1), dtype=np.float32)],
            [np.zeros((2, 5, 1), dtype=np.float32)],
            [valid.astype(np.float16)],
            [np.zeros((1, 4, 1), dtype=np.float32)],
            [np.zeros((1, 5, 0), dtype=np.float32)],
            [np.full((1, 5, 1), np.nan, dtype=np.float32)],
            [np.full((1, 5, 1), np.inf, dtype=np.float32)],
            [np.zeros((1, 5, 5), dtype=np.float32)],
        ]
        invalid_outputs[-1][0][0, 4, :] = 0.5
        for outputs in invalid_outputs:
            with self.subTest(shape=[list(item.shape) for item in outputs]):
                with self.assertRaises(ValueError):
                    HandDetector._prediction_rows(outputs)

        bad_score = valid.copy()
        bad_score[0, 4, 0] = 1.1
        with self.assertRaises(ValueError):
            HandDetector._prediction_rows([bad_score])

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
            batch_two = helper.make_tensor_value_info("images", TensorProto.FLOAT, [2, 3, 1280, 1280])
            with self.assertRaises(ModelProfileError):
                validate_target_profile(self._write_model(root, "target-batch-two.onnx", [batch_two], [prediction, prototype]))
            prediction_batch_axis = helper.make_tensor_value_info("prediction", TensorProto.FLOAT, [43, 1, None])
            with self.assertRaises(ModelProfileError):
                validate_target_profile(self._write_model(root, "target-batch-axis.onnx", [image], [prediction_batch_axis, prototype]))
            bad_prototype = helper.make_tensor_value_info("prototype", TensorProto.FLOAT, [1, 31, None, None])
            with self.assertRaises(ModelProfileError):
                validate_target_profile(self._write_model(root, "target-prototype-channels.onnx", [image], [prediction, bad_prototype]))
            float16_prediction = helper.make_tensor_value_info("prediction", TensorProto.FLOAT16, [1, 43, None])
            with self.assertRaises(ModelProfileError):
                validate_target_profile(self._write_model(root, "target-f16-output.onnx", [image], [float16_prediction, prototype]))
            batch_two_prediction = helper.make_tensor_value_info("prediction", TensorProto.FLOAT, [2, 43, None])
            with self.assertRaises(ModelProfileError):
                validate_target_profile(self._write_model(root, "target-output-batch-two.onnx", [image], [batch_two_prediction, prototype]))
            scalar_prediction = helper.make_tensor_value_info("prediction", TensorProto.FLOAT, [])
            with self.assertRaises(ModelProfileError):
                validate_target_profile(self._write_model(root, "target-scalar-output.onnx", [image], [scalar_prediction, prototype]))
            wrong_rank_prediction = helper.make_tensor_value_info("prediction", TensorProto.FLOAT, [1, 43])
            with self.assertRaises(ModelProfileError):
                validate_target_profile(self._write_model(root, "target-wrong-rank-output.onnx", [image], [wrong_rank_prediction, prototype]))
            dynamic = helper.make_tensor_value_info("images", TensorProto.FLOAT, [None, 3, None, None])
            self.assertEqual(validate_target_profile(self._write_model(root, "target-dynamic.onnx", [dynamic], [prediction, prototype])).kind, "target_segmentation")

    def test_generic_segment_profile_requires_1024_raw_yolo_outputs_and_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = helper.make_tensor_value_info("images", TensorProto.FLOAT, [1, 3, 1024, 1024])
            prediction = helper.make_tensor_value_info("output0", TensorProto.FLOAT, [1, 39, None])
            prototype = helper.make_tensor_value_info("output1", TensorProto.FLOAT, [1, 32, None, None])
            metadata = {"names": "{0: 'vagina', 1: 'penis', 2: 'arm'}"}
            path = self._write_model(root, "generic.onnx", [image], [prediction, prototype], metadata=metadata)
            self.assertEqual(validate_generic_yolo_segment_profile(path).kind, "generic_yolo_segmentation")
            reversed_path = self._write_model(root, "generic-reversed.onnx", [image], [prototype, helper.make_tensor_value_info("output0", TensorProto.FLOAT, [1, None, 39])], metadata=metadata)
            self.assertEqual(validate_generic_yolo_segment_profile(reversed_path).kind, "generic_yolo_segmentation")
            with self.assertRaises(ModelProfileError):
                validate_generic_yolo_segment_profile(self._write_model(root, "generic-no-names.onnx", [image], [prediction, prototype]))
            wrong_size = helper.make_tensor_value_info("images", TensorProto.FLOAT, [1, 3, 1280, 1280])
            with self.assertRaises(ModelProfileError):
                validate_generic_yolo_segment_profile(self._write_model(root, "generic-size.onnx", [wrong_size], [prediction, prototype], metadata=metadata))

    def test_hand_profile_requires_single_xywh_score_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = helper.make_tensor_value_info("images", TensorProto.FLOAT, [1, 3, 640, 640])
            output = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, None, 5])
            path = self._write_model(root, "hand.onnx", [image], [output])
            self.assertEqual(validate_hand_profile(path).kind, "hand_detection")
            transposed = self._write_model(root, "hand-transposed.onnx", [image], [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 5, None])])
            self.assertEqual(validate_hand_profile(transposed).kind, "hand_detection")
            ambiguous = self._write_model(root, "hand-ambiguous.onnx", [image], [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 5, 5])])
            with self.assertRaises(ModelProfileError):
                validate_hand_profile(ambiguous)
            incompatible = self._write_model(root, "bad-hand.onnx", [image], [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, None, 6])])
            with self.assertRaises(ModelProfileError):
                validate_hand_profile(incompatible)
            wrong_size = helper.make_tensor_value_info("images", TensorProto.FLOAT, [1, 3, 1280, 1280])
            with self.assertRaises(ModelProfileError):
                validate_hand_profile(self._write_model(root, "hand-size.onnx", [wrong_size], [output]))
            batch_two = helper.make_tensor_value_info("images", TensorProto.FLOAT, [2, 3, 640, 640])
            with self.assertRaises(ModelProfileError):
                validate_hand_profile(self._write_model(root, "hand-batch-two.onnx", [batch_two], [output]))
            bad_dtype = helper.make_tensor_value_info("output", TensorProto.FLOAT16, [1, None, 5])
            with self.assertRaises(ModelProfileError):
                validate_hand_profile(self._write_model(root, "hand-f16-output.onnx", [image], [bad_dtype]))
            batch_two_output = helper.make_tensor_value_info("output", TensorProto.FLOAT, [2, None, 5])
            with self.assertRaises(ModelProfileError):
                validate_hand_profile(self._write_model(root, "hand-output-batch-two.onnx", [image], [batch_two_output]))
            scalar_output = helper.make_tensor_value_info("output", TensorProto.FLOAT, [])
            with self.assertRaises(ModelProfileError):
                validate_hand_profile(self._write_model(root, "hand-scalar-output.onnx", [image], [scalar_output]))
            wrong_rank_output = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 5])
            with self.assertRaises(ModelProfileError):
                validate_hand_profile(self._write_model(root, "hand-wrong-rank-output.onnx", [image], [wrong_rank_output]))

    def test_hand_profile_allows_dynamic_orientation_only_for_confirmed_hand_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = helper.make_tensor_value_info("images", TensorProto.FLOAT, [1, 3, 640, 640])
            output = helper.make_tensor_value_info("output0", TensorProto.FLOAT, [1, None, None])
            metadata = {"names": "{0: ' hand '}", "stride": "32", "task": "detect"}
            self.assertEqual(
                validate_hand_profile(self._write_model(root, "hand-dynamic.onnx", [image], [output], metadata=metadata)).kind,
                "hand_detection",
            )

            invalid_metadata = [
                {"names": "{not valid", "stride": "32"},
                {"names": "{0: 'hand'}"},
                {"names": "{0: 'person'}", "stride": "32"},
                {"names": "{1: 'hand'}", "stride": "32"},
                {"names": "{False: 'hand'}", "stride": "32"},
                {"names": "{0.0: 'hand'}", "stride": "32"},
                {"names": "{0: 'hand', 1: 'hand'}", "stride": "32"},
                {"names": "{0: 'hand'}", "stride": "16"},
                {"names": "{0: 'hand'}", "stride": "32", "task": "segment"},
            ]
            for index, values in enumerate(invalid_metadata):
                with self.subTest(values=values):
                    with self.assertRaises(ModelProfileError):
                        validate_hand_profile(self._write_model(root, f"hand-dynamic-bad-{index}.onnx", [image], [output], metadata=values))

            wrong_name = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, None, None])
            with self.assertRaises(ModelProfileError):
                validate_hand_profile(self._write_model(root, "hand-dynamic-name.onnx", [image], [wrong_name], metadata=metadata))

            static_unknown = helper.make_tensor_value_info("output0", TensorProto.FLOAT, [1, 6, 7])
            with self.assertRaises(ModelProfileError):
                validate_hand_profile(self._write_model(root, "hand-static-unknown.onnx", [image], [static_unknown], metadata=metadata))
