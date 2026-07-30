import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

import numpy as np
from PIL import Image, PngImagePlugin

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import (  # noqa: E402
    ClientError,
    ImageRecord,
    MosaicHandler,
    StudioState,
    calculate_block_size,
    detection_tiles,
    mask_iou,
    merge_segment,
    png_ancillary_manifest,
    restore_tile_mask,
    save_with_mask,
)


class MosaicStudioTests(unittest.TestCase):
    def test_block_size_uses_long_edge_and_minimum(self):
        self.assertEqual(calculate_block_size(300, 200), 4)
        self.assertEqual(calculate_block_size(401, 220), 5)
        self.assertEqual(calculate_block_size(1000, 999), 10)

    def test_png_ancillary_metadata_is_byte_identical_after_save(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            pixels = np.zeros((16, 16, 3), dtype=np.uint8)
            pixels[:, :, 0] = np.arange(16, dtype=np.uint8)[None, :] * 15
            pixels[:, :, 1] = np.arange(16, dtype=np.uint8)[:, None] * 15
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("prompt", '{"seed": 123}')
            metadata.add_itxt("workflow", '{"nodes": []}', lang="ja", tkey="workflow")
            Image.fromarray(pixels, "RGB").save(path, format="PNG", pnginfo=metadata)
            original = path.read_bytes()
            original_manifest = png_ancillary_manifest(original)
            original_mtime_ns = path.stat().st_mtime_ns

            record = ImageRecord("test", path, "source.png", 16, 16, original_mtime_ns)
            mask = np.zeros((16, 16), dtype=np.uint8)
            mask[4:12, 4:12] = 255
            save_with_mask(record, mask, 4)

            saved = path.read_bytes()
            self.assertEqual(original_manifest, png_ancillary_manifest(saved))
            self.assertEqual(original_mtime_ns, path.stat().st_mtime_ns)
            with Image.open(path) as image:
                self.assertEqual(image.info["prompt"], '{"seed": 123}')
                self.assertEqual(image.info["workflow"], '{"nodes": []}')
                actual = np.asarray(image.convert("RGB"))
            self.assertTrue(np.array_equal(actual[0, 0], pixels[0, 0]))
            self.assertFalse(np.array_equal(actual[5:11, 5:11], pixels[5:11, 5:11]))

    def test_catalogue_only_accepts_scanned_images(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            nested = root / "nested"
            nested.mkdir()
            Image.new("RGB", (8, 8), "white").save(nested / "one.png")
            state = StudioState()
            images = state.set_root(str(root))
            self.assertEqual(len(images), 1)
            self.assertEqual(state.image_for_id(images[0]["id"]).path, (nested / "one.png").resolve())
            with self.assertRaises(ClientError):
                state.image_for_id("..%2foutside")

    def test_tile_layout_restores_masks_to_original_coordinates(self):
        specs = detection_tiles(100, 80)
        self.assertEqual(len(specs), 9)
        self.assertIn((35, 28, 65, 52), specs)
        local = np.zeros((52, 65), dtype=np.uint8)
        local[7:12, 9:15] = 255
        restored = restore_tile_mask(local, 100, 80, 35, 28)
        self.assertEqual(restored.shape, (80, 100))
        self.assertTrue(np.all(restored[35:40, 44:50] == 255))
        self.assertEqual(np.count_nonzero(restored), 30)

    def test_iou_merge_unions_tiled_duplicates_but_keeps_separate_objects(self):
        first = np.zeros((12, 12), dtype=np.uint8)
        first[2:8, 2:8] = 255
        duplicate = np.zeros((12, 12), dtype=np.uint8)
        duplicate[2:8, 3:9] = 255
        separate = np.zeros((12, 12), dtype=np.uint8)
        separate[9:11, 9:11] = 255
        self.assertGreater(mask_iou(first, duplicate), 0.5)
        segments = []
        merge_segment(segments, "penis", 0.4, first)
        merge_segment(segments, "penis", 0.9, duplicate)
        merge_segment(segments, "penis", 0.7, separate)
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["confidence"], 0.9)
        self.assertTrue(np.all(segments[0]["mask"][2:8, 2:9] == 255))

    def test_api_returns_utf8_japanese_client_error(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = None
        try:
            connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            body = json.dumps({"path": ""}).encode("utf-8")
            connection.request("POST", "/api/folder", body, {"Content-Type": "application/json"})
            response = connection.getresponse()
            payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 400)
            self.assertEqual(payload["error"], "Windowsフォルダを入力してください。")
        finally:
            if connection is not None:
                connection.close()
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
