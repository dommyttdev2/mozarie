from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mozarie.inference.onnx import Letterbox, nms_indices, restore_box
from mozarie.inference.yolo_segment import TargetSegmenter


class OnnxAdapterTests(unittest.TestCase):
    def test_restore_box_reverses_letterbox_coordinates(self) -> None:
        transform = Letterbox(2.0, 10, 20, 100, 100, 40, 30)
        self.assertEqual(restore_box(np.asarray((50, 50, 20, 20)), transform), (15, 10, 25, 20))

    def test_nms_removes_overlapping_lower_confidence_box(self) -> None:
        self.assertEqual(nms_indices([(0, 0, 10, 10), (1, 1, 9, 9), (20, 20, 30, 30)], [0.9, 0.8, 0.7], 0.5), [0, 2])

    def test_segment_rows_accept_channel_first_export(self) -> None:
        rows = TargetSegmenter._prediction_rows(np.zeros((1, 43, 10), dtype=np.float32))
        self.assertEqual(rows.shape, (10, 43))
