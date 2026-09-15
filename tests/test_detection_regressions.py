from __future__ import annotations

import unittest
from unittest.mock import Mock

import numpy as np

from mozarie.state import StudioState


class SamFallbackRegressionTests(unittest.TestCase):
    def test_nonempty_detector_mask_is_preserved_when_sam_selects_nothing(self) -> None:
        source = np.zeros((8, 8), dtype=np.uint8)
        source[2:6, 2:6] = 255
        segment = {"class_name": "penis", "confidence": 0.61, "source": "target", "mask": source.copy()}
        predictor = Mock()
        predictor.predict.return_value = (np.zeros((1, 8, 8), dtype=bool), np.asarray([0.1]), None)

        result = StudioState._high_precision_segments_with_predictor(None, np.zeros((8, 8, 3), dtype=np.uint8), [segment], predictor)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["refinement"], "sam_fallback")
        self.assertTrue(np.array_equal(result[0]["mask"] > 0, source > 0))
        self.assertTrue(np.array_equal(result[0]["_apply_mask"] > 0, source > 0))

    def test_empty_detector_mask_does_not_publish_an_apply_candidate(self) -> None:
        segment = {
            "class_name": "penis", "confidence": 0.61, "source": "target",
            "mask": np.zeros((8, 8), dtype=np.uint8),
        }
        predictor = Mock()

        result = StudioState._high_precision_segments_with_predictor(None, np.zeros((8, 8, 3), dtype=np.uint8), [segment], predictor)

        self.assertEqual(result, [])
        predictor.predict.assert_not_called()


if __name__ == "__main__":
    unittest.main()
