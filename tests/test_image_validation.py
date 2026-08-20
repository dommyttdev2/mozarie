import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from mozarie.core import ClientError
from mozarie.image_io import inspect_import_image


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

    def test_pillow_bomb_warning_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "small.png"
            Image.new("RGB", (2, 2), "white").save(path)
            with mock.patch.object(Image, "MAX_IMAGE_PIXELS", 1):
                with self.assertRaises(ClientError):
                    inspect_import_image(path, ".png")
