import ast
import unittest
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]


class PillowFromarrayCompatibilityTests(unittest.TestCase):
    def test_fromarray_infers_supported_image_modes(self):
        cases = (
            ("L", np.array([[0, 255], [42, 128]], dtype=np.uint8)),
            ("RGB", np.array([[[1, 2, 3], [4, 5, 6]]], dtype=np.uint8)),
            ("RGBA", np.array([[[1, 2, 3, 4], [5, 6, 7, 8]]], dtype=np.uint8)),
        )

        for expected_mode, pixels in cases:
            with self.subTest(mode=expected_mode):
                image = Image.fromarray(pixels)
                self.assertEqual(image.mode, expected_mode)
                self.assertEqual(image.size, (pixels.shape[1], pixels.shape[0]))
                self.assertEqual(np.asarray(image).shape, pixels.shape)
                np.testing.assert_array_equal(np.asarray(image), pixels)

    def test_bool_masks_are_cast_to_uint8_before_creation(self):
        mask = np.array([[False, True], [True, False]])

        image = Image.fromarray(np.asarray(mask, dtype=np.uint8))

        self.assertEqual(image.mode, "L")
        np.testing.assert_array_equal(np.asarray(image), np.array([[0, 1], [1, 0]], dtype=np.uint8))

    def test_fromarray_calls_do_not_override_inferred_modes(self):
        source_paths = (*ROOT.joinpath("mozarie").rglob("*.py"), *ROOT.joinpath("tests").rglob("*.py"))
        for source_path in source_paths:
            tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
            for node in ast.walk(tree):
                if not self._is_fromarray_call(node):
                    continue
                self.assertEqual(len(node.args), 1, source_path)
                self.assertFalse(any(keyword.arg == "mode" for keyword in node.keywords), source_path)

    def test_detection_mask_writes_cast_to_uint8(self):
        source_path = ROOT / "mozarie" / "detection.py"
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        calls = [node for node in ast.walk(tree) if self._is_fromarray_call(node)]

        self.assertEqual(len(calls), 3)
        for node in calls:
            self.assertTrue(self._is_uint8_asarray(node.args[0]), ast.unparse(node))

    @staticmethod
    def _is_fromarray_call(node):
        return (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "Image"
            and node.func.attr == "fromarray"
        )

    @staticmethod
    def _is_uint8_asarray(node):
        return (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "np"
            and node.func.attr == "asarray"
            and any(
                keyword.arg == "dtype"
                and isinstance(keyword.value, ast.Attribute)
                and isinstance(keyword.value.value, ast.Name)
                and keyword.value.value.id == "np"
                and keyword.value.attr == "uint8"
                for keyword in node.keywords
            )
        )
