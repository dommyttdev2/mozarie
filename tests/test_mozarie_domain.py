from __future__ import annotations

import unittest
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mozarie.boundary import polygon_roi_and_point, validate_polygon
from mozarie.domain import CandidateRole
from mozarie.masks import compose_masks


class MozarieDomainTests(unittest.TestCase):
    def test_apply_union_minus_exclude_and_manual_masks(self) -> None:
        apply = np.zeros((4, 4), dtype=np.uint8); apply[:3, :3] = 255
        extra = np.zeros((4, 4), dtype=np.uint8); extra[3, 3] = 255
        exclude = np.zeros((4, 4), dtype=np.uint8); exclude[1, 1] = 255
        result = compose_masks((4, 4), [apply], [exclude], extra)
        self.assertEqual(int(result[1, 1]), 0)
        self.assertEqual(int(result[3, 3]), 255)

    def test_candidate_role_has_stable_api_values(self) -> None:
        self.assertEqual(CandidateRole.APPLY.value, "apply")
        self.assertEqual(CandidateRole.EXCLUDE.value, "exclude")

    def test_polygon_returns_interior_prompt_and_clip_mask(self) -> None:
        roi, point, mask = polygon_roi_and_point(((3, 3), (16, 4), (15, 14), (4, 15)), 20, 20)
        self.assertEqual(roi, (3, 3, 17, 16))
        self.assertGreater(mask[int(point[1]), int(point[0])], 0)

    def test_polygon_rejects_crossing_edges(self) -> None:
        with self.assertRaises(ValueError):
            validate_polygon(((1, 1), (8, 8), (1, 8), (8, 1)), 10, 10)

    def test_polygon_mask_clips_the_sam_result_shape(self) -> None:
        _roi, _point, mask = polygon_roi_and_point(((2, 2), (12, 2), (11, 9), (3, 9)), 16, 16)
        self.assertEqual(int(mask[0, 0]), 0)
        self.assertEqual(int(mask[5, 6]), 255)
