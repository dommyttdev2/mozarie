import io
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image, PngImagePlugin

from mozarie.core import ClientError
from mozarie.image_io import inspect_import_image, open_image


class InputImageValidationTests(unittest.TestCase):
    def test_truncated_jpeg_is_rejected_without_pixel_decode(self):
        output = io.BytesIO()
        Image.new("RGB", (4, 4), "white").save(output, format="JPEG")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "truncated.jpg"
            path.write_bytes(output.getvalue()[:-2])
            with mock.patch.object(Image.Image, "load", side_effect=AssertionError("input validation must not decode pixels")):
                with self.assertRaises(ClientError):
                    inspect_import_image(path, ".jpg")

    def test_pillow_pixel_guard_is_disabled_only_while_opening(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "small.png"
            Image.new("RGB", (2, 2), "white").save(path)
            with mock.patch.object(Image, "MAX_IMAGE_PIXELS", 1):
                self.assertEqual(inspect_import_image(path, ".png"), (2, 2))
                self.assertEqual(Image.MAX_IMAGE_PIXELS, 1)

    def test_pixel_guard_is_restored_after_concurrent_openers_finish(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "small.png"
            Image.new("RGB", (2, 2), "white").save(path)
            entered = threading.Barrier(3)
            release = threading.Event()
            failures: list[BaseException] = []

            def worker() -> None:
                try:
                    with open_image(path):
                        entered.wait(timeout=2)
                        release.wait(2)
                except BaseException as exc:  # test thread failures must be reported by the parent.
                    failures.append(exc)

            with mock.patch.object(Image, "MAX_IMAGE_PIXELS", 1):
                threads = [threading.Thread(target=worker) for _index in range(2)]
                for thread in threads:
                    thread.start()
                entered.wait(timeout=2)
                self.assertIsNone(Image.MAX_IMAGE_PIXELS)
                release.set()
                for thread in threads:
                    thread.join(2)
                self.assertEqual(failures, [])
                self.assertEqual(Image.MAX_IMAGE_PIXELS, 1)

    def test_open_failures_are_reported_as_image_read_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "broken.png"
            path.write_bytes(b"not an image")
            with self.assertRaises(ClientError) as raised:
                inspect_import_image(path, ".png")
            self.assertEqual(raised.exception.error_code, "image_read_failed")

    def test_png_with_large_text_metadata_is_inspected_from_pixels(self):
        """A valid image must not disappear because optional PNG text is huge."""
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("parameters", "x" * 3_000_000)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metadata.png"
            Image.new("RGB", (11, 7), "white").save(path, pnginfo=metadata)
            self.assertEqual(inspect_import_image(path, ".png"), (11, 7))
