import ast
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mozarie.fluid import white_fluid_mask  # noqa: E402
from mozarie.masks import compose_masks  # noqa: E402


class FluidTests(unittest.TestCase):
    def test_white_fluid_mask_accepts_a_small_strong_white_penis_component(self):
        rgb = np.zeros((24, 24, 3), dtype=np.uint8)
        penis = np.zeros((24, 24), dtype=np.uint8)
        penis[2:22, 2:22] = 255
        rgb[8:12, 8:12] = 255
        fluid = white_fluid_mask(rgb, penis)
        self.assertEqual(np.count_nonzero(fluid), 16)

    def test_white_fluid_mask_expands_an_accepted_white_core_into_a_translucent_deposit(self):
        rgb = np.zeros((40, 40, 3), dtype=np.uint8)
        penis = np.zeros((40, 40), dtype=np.uint8)
        penis[5:35, 5:35] = 255
        rgb[12:24, 12:24] = (210, 205, 200)
        rgb[16:20, 16:20] = 255
        fluid = white_fluid_mask(rgb, penis)
        self.assertEqual(np.count_nonzero(fluid), 12 * 12)
        self.assertEqual(np.count_nonzero(fluid[12:24, 12:24]) - np.count_nonzero(fluid[16:20, 16:20]), 12 * 12 - 16)

    def test_white_fluid_mask_limits_translucent_expansions_to_four_components(self):
        rgb = np.zeros((100, 100, 3), dtype=np.uint8)
        penis = np.zeros((100, 100), dtype=np.uint8)
        penis[10:90, 10:90] = 255
        for top, left in ((20, 15), (20, 30), (20, 45), (20, 60), (20, 75)):
            rgb[top:top + 8, left:left + 10] = (210, 205, 200)
            rgb[top + 2:top + 6, left + 3:left + 7] = 255
        fluid = white_fluid_mask(rgb, penis)
        self.assertEqual(np.count_nonzero(fluid), 5 * 16 + 4 * (8 * 10 - 16))

    def test_white_fluid_mask_accepts_small_lines_and_drops(self):
        rgb = np.zeros((32, 32, 3), dtype=np.uint8)
        penis = np.zeros((32, 32), dtype=np.uint8)
        penis[3:29, 3:29] = 255
        rgb[8, 8:14] = 255
        rgb[18:20, 18:20] = 255
        fluid = white_fluid_mask(rgb, penis)
        self.assertEqual(np.count_nonzero(fluid), 10)

    def test_white_fluid_mask_is_subset_of_final_mask_and_ignores_outside_highlights(self):
        rgb = np.zeros((48, 48, 3), dtype=np.uint8)
        penis = np.zeros((48, 48), dtype=np.uint8)
        penis[18:30, 20:32] = 255
        rgb[21:25, 23:27] = 255
        rgb[2:16, 2:16] = 255
        fluid = white_fluid_mask(rgb, penis)
        self.assertTrue(np.all(fluid[penis == 0] == 0))
        self.assertEqual(np.count_nonzero(fluid), 16)
        enabled = compose_masks(penis.shape, [penis], [fluid])
        disabled = compose_masks(penis.shape, [penis], [])
        self.assertFalse(np.any(enabled[fluid > 0]))
        self.assertTrue(np.array_equal(disabled, penis))

    def test_white_fluid_mask_processes_only_the_final_mask_bounding_crop(self):
        rgb = np.zeros((64, 64, 3), dtype=np.uint8)
        penis = np.zeros((64, 64), dtype=np.uint8)
        penis[20:32, 24:40] = 255
        rgb[23:27, 28:32] = 255
        real_cvt_color = cv2.cvtColor
        real_morphology = cv2.morphologyEx
        real_blur = cv2.blur
        shapes = []
        morphology_calls = []
        blur_shapes = []

        def record_crop(image, *args, **kwargs):
            shapes.append(image.shape[:2])
            return real_cvt_color(image, *args, **kwargs)

        def record_morphology(image, operation, kernel, *args, **kwargs):
            morphology_calls.append((image.shape[:2], kernel.shape))
            return real_morphology(image, operation, kernel, *args, **kwargs)

        def record_blur(image, *args, **kwargs):
            blur_shapes.append(image.shape[:2])
            return real_blur(image, *args, **kwargs)

        with patch.object(cv2, "cvtColor", side_effect=record_crop), \
             patch.object(cv2, "morphologyEx", side_effect=record_morphology), \
             patch.object(cv2, "blur", side_effect=record_blur):
            fluid = white_fluid_mask(rgb, penis)
        self.assertEqual(shapes, [(12, 16)])
        self.assertEqual(morphology_calls, [((12, 16), (3, 3)), ((12, 16), (7, 7)), ((12, 16), (15, 15)), ((12, 16), (3, 3))])
        self.assertEqual(blur_shapes, [(12, 16)])
        self.assertEqual(np.count_nonzero(fluid), 16)

    def test_white_fluid_mask_uses_only_small_final_crops_at_large_resolutions(self):
        real_cvt_color = cv2.cvtColor
        for height, width in ((832, 1216), (1440, 2560), (2160, 3840)):
            rgb = np.zeros((height, width, 3), dtype=np.uint8)
            penis = np.zeros((height, width), dtype=np.uint8)
            top, left = height // 2, width // 2
            penis[top:top + 24, left:left + 32] = 255
            rgb[top + 8:top + 12, left + 12:left + 16] = 255
            shapes = []

            def record_crop(image, *args, **kwargs):
                shapes.append(image.shape[:2])
                return real_cvt_color(image, *args, **kwargs)

            with patch.object(cv2, "cvtColor", side_effect=record_crop):
                fluid = white_fluid_mask(rgb, penis)
            self.assertEqual(shapes, [(24, 32)])
            self.assertEqual(np.count_nonzero(fluid), 16)

    def test_white_fluid_mask_rejects_large_high_saturation_and_noise_components(self):
        rgb = np.zeros((24, 24, 3), dtype=np.uint8)
        penis = np.zeros((24, 24), dtype=np.uint8)
        penis[2:22, 2:22] = 255
        rgb[3:13, 3:13] = 255
        rgb[15:19, 3:7] = (255, 40, 40)
        rgb[20, 20] = 255
        fluid = white_fluid_mask(rgb, penis)
        self.assertFalse(np.any(fluid))

    def test_white_fluid_mask_rejects_pale_skin_connected_to_white_seeds(self):
        rgb = np.zeros((24, 24, 3), dtype=np.uint8)
        penis = np.zeros((24, 24), dtype=np.uint8)
        penis[2:22, 2:22] = 255
        rgb[6:11, 6:14] = (245, 230, 215)
        rgb[(6, 6, 10, 10), (6, 10, 6, 10)] = 255
        fluid = white_fluid_mask(rgb, penis)
        self.assertFalse(np.any(fluid))

    def test_white_fluid_mask_rejects_an_isolated_translucent_highlight(self):
        rgb = np.zeros((24, 24, 3), dtype=np.uint8)
        penis = np.zeros((24, 24), dtype=np.uint8)
        penis[2:22, 2:22] = 255
        rgb[8:12, 8:12] = (210, 205, 200)
        fluid = white_fluid_mask(rgb, penis)
        self.assertFalse(np.any(fluid))

    def test_white_fluid_mask_filters_many_components_without_per_label_equality_scans(self):
        class TrackingLabels(np.ndarray):
            equality_scans = 0

            def __eq__(self, other):
                type(self).equality_scans += 1
                return super().__eq__(other)

        rgb = np.zeros((64, 64, 3), dtype=np.uint8)
        penis = np.full((64, 64), 255, dtype=np.uint8)
        labels = np.zeros((64, 64), dtype=np.int32)
        components = []
        for label, (top, left) in enumerate(((row, column) for row in range(2, 52, 10) for column in range(2, 52, 10)), 1):
            labels[top:top + 4, left:left + 4] = label
            rgb[top:top + 4, left:left + 4] = 255
            components.append((top, left))
        tracked_labels = labels.view(TrackingLabels)
        stats = np.zeros((len(components) + 1, 5), dtype=np.int32)
        with patch.object(
            cv2,
            "connectedComponentsWithStats",
            return_value=(len(components) + 1, tracked_labels, stats, np.zeros((len(components) + 1, 2))),
        ):
            fluid = white_fluid_mask(rgb, penis)
        self.assertEqual(TrackingLabels.equality_scans, 0)
        self.assertEqual(np.count_nonzero(fluid), 8 * 16)
        for top, left in components[:8]:
            self.assertTrue(np.all(fluid[top:top + 4, left:left + 4] == 255))

    def test_fluid_module_has_leaf_dependencies_and_one_public_symbol(self):
        root = Path(__file__).resolve().parents[1] / "mozarie"
        imports = ast.parse((root / "fluid.py").read_text(encoding="utf-8"))
        imported_modules = {
            alias.name.split(".")[0]
            for node in ast.walk(imports)
            if isinstance(node, ast.Import)
            for alias in node.names
        }
        self.assertEqual(imported_modules, {"cv2", "heapq", "math", "numpy"})
        self.assertEqual(__import__("mozarie.fluid", fromlist=["__all__"]).__all__, ["white_fluid_mask"])
        detection_imports = ast.parse((root / "detection.py").read_text(encoding="utf-8"))
        self.assertTrue(any(
            isinstance(node, ast.ImportFrom)
            and node.module == "fluid"
            and any(alias.name == "white_fluid_mask" for alias in node.names)
            for node in ast.walk(detection_imports)
        ))
        self.assertNotIn("white_fluid_mask", (root / "core.py").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
