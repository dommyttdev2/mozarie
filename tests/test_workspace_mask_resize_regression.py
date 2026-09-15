"""Regression coverage for Pillow-compatible workspace mask resizing."""

from __future__ import annotations

import io
import unittest
import warnings

import numpy as np
from PIL import Image

from mozarie.workspace import WorkspaceStore


class WorkspaceMaskResizeRegressionTests(unittest.TestCase):
    def test_resize_binary_mask_succeeds_when_deprecation_warnings_are_errors(self) -> None:
        original = io.BytesIO()
        Image.new("L", (2, 2), 255).save(original, format="PNG")
        with warnings.catch_warnings():
            warnings.simplefilter("error", DeprecationWarning)
            encoded, value = WorkspaceStore._resize_binary_mask(original.getvalue(), (2, 2), (3, 3))
        self.assertEqual(value.shape, (3, 3))
        with Image.open(io.BytesIO(encoded)) as resized:
            self.assertEqual((resized.mode, resized.size), ("L", (3, 3)))


if __name__ == "__main__":
    unittest.main()
