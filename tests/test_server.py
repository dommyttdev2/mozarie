import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

import numpy as np
from PIL import Image, PngImagePlugin

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import (  # noqa: E402
    ClientError,
    DEFAULT_DETECTION_CONFIDENCE,
    FOLDER_PICKER_LOCK,
    ImageRecord,
    MosaicHandler,
    StudioState,
    calculate_block_size,
    confidence_for_source,
    detection_tiles,
    jpeg_metadata_manifest,
    mask_iou,
    merge_segment,
    pick_windows_folder,
    png_ancillary_manifest,
    restore_tile_mask,
    read_detection_confidence,
    save_with_mask,
    webp_metadata_manifest,
)


class MosaicStudioTests(unittest.TestCase):
    @staticmethod
    def _record(path: Path, width: int, height: int) -> ImageRecord:
        return ImageRecord("test", path, path.name, width, height, path.stat().st_mtime_ns)

    @staticmethod
    def _mask(width: int, height: int) -> np.ndarray:
        mask = np.zeros((height, width), dtype=np.uint8)
        mask[4:12, 4:12] = 255
        return mask

    @staticmethod
    def _jpeg_segment(marker: int, payload: bytes) -> bytes:
        return b"\xff" + bytes([marker]) + (len(payload) + 2).to_bytes(2, "big") + payload

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
            save_with_mask(record, self._mask(16, 16), 4)

            saved = path.read_bytes()
            self.assertEqual(original_manifest, png_ancillary_manifest(saved))
            self.assertEqual(original_mtime_ns, path.stat().st_mtime_ns)
            with Image.open(path) as image:
                self.assertEqual(image.info["prompt"], '{"seed": 123}')
                self.assertEqual(image.info["workflow"], '{"nodes": []}')
                actual = np.asarray(image.convert("RGB"))
            self.assertTrue(np.array_equal(actual[0, 0], pixels[0, 0]))
            self.assertFalse(np.array_equal(actual[5:11, 5:11], pixels[5:11, 5:11]))

    def test_jpeg_app_and_comment_metadata_is_byte_identical_after_save(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.jpg"
            exif = Image.Exif()
            exif[0x010E] = "MosaicStudio test"
            Image.new("RGB", (16, 16), "#6688aa").save(
                path,
                format="JPEG",
                exif=exif.tobytes(),
                icc_profile=b"MosaicStudio ICC profile",
            )
            original = path.read_bytes()
            xmp = b"http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta>MosaicStudio</x:xmpmeta>"
            original = b"\xff\xd8" + self._jpeg_segment(0xE1, xmp) + self._jpeg_segment(0xFE, b"MosaicStudio comment") + original[2:]
            path.write_bytes(original)
            manifest = jpeg_metadata_manifest(original)
            self.assertTrue(any(entry.startswith("FFE1:") for entry in manifest))
            self.assertTrue(any(entry.startswith("FFE2:") for entry in manifest))
            self.assertTrue(any(entry.startswith("FFFE:") for entry in manifest))

            save_with_mask(self._record(path, 16, 16), self._mask(16, 16), 4)
            self.assertEqual(manifest, jpeg_metadata_manifest(path.read_bytes()))
            with Image.open(path) as image:
                image.load()

    def test_webp_icc_exif_xmp_metadata_is_byte_identical_after_save(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.webp"
            exif = Image.Exif()
            exif[0x010E] = "MosaicStudio test"
            Image.new("RGB", (16, 16), "#6688aa").save(
                path,
                format="WEBP",
                exif=exif.tobytes(),
                icc_profile=b"MosaicStudio ICC profile",
                xmp=b"<x:xmpmeta>MosaicStudio</x:xmpmeta>",
            )
            original = path.read_bytes()
            manifest = webp_metadata_manifest(original)
            self.assertTrue(any(entry.startswith("ICCP:") for entry in manifest))
            self.assertTrue(any(entry.startswith("EXIF:") for entry in manifest))
            self.assertTrue(any(entry.startswith("XMP :") for entry in manifest))

            save_with_mask(self._record(path, 16, 16), self._mask(16, 16), 4)
            self.assertEqual(manifest, webp_metadata_manifest(path.read_bytes()))
            with Image.open(path) as image:
                image.load()

    def test_metadata_mismatch_does_not_replace_original_jpeg(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.jpg"
            Image.new("RGB", (16, 16), "#6688aa").save(path, format="JPEG")
            original = path.read_bytes()
            with patch("server.jpeg_metadata_manifest", side_effect=[[], ["mismatch"]]):
                with self.assertRaisesRegex(ClientError, "JPEGメタデータ検証"):
                    save_with_mask(self._record(path, 16, 16), self._mask(16, 16), 4)
            self.assertEqual(original, path.read_bytes())

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

    def test_iou_merge_keeps_the_best_precise_duplicate_mask(self):
        first = np.zeros((12, 12), dtype=np.uint8)
        first[2:8, 2:8] = 255
        duplicate = np.zeros((12, 12), dtype=np.uint8)
        duplicate[2:8, 3:9] = 255
        separate = np.zeros((12, 12), dtype=np.uint8)
        separate[9:11, 9:11] = 255
        self.assertGreater(mask_iou(first, duplicate), 0.5)
        segments = []
        merge_segment(segments, "penis", 0.4, first, "primary")
        merge_segment(segments, "penis", 0.9, duplicate, "primary")
        merge_segment(segments, "penis", 0.7, separate)
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["confidence"], 0.9)
        self.assertTrue(np.array_equal(segments[0]["mask"], duplicate))

    def test_primary_segment_wins_over_secondary_duplicate(self):
        first = np.zeros((12, 12), dtype=np.uint8)
        first[2:8, 2:8] = 255
        secondary = np.zeros((12, 12), dtype=np.uint8)
        secondary[2:8, 3:9] = 255
        segments = []
        merge_segment(segments, "penis", 0.62, first, "primary")
        merge_segment(segments, "penis", 0.91, secondary, "secondary")
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["source"], "primary")
        self.assertTrue(np.array_equal(segments[0]["mask"], first))

    def test_detection_confidence_validation_and_secondary_floor(self):
        self.assertEqual(DEFAULT_DETECTION_CONFIDENCE, 0.60)
        self.assertEqual(read_detection_confidence("0.60"), 0.60)
        self.assertEqual(confidence_for_source("primary", 0.60), 0.60)
        self.assertEqual(confidence_for_source("secondary", 0.60), 0.75)
        self.assertEqual(confidence_for_source("secondary", 0.85), 0.85)
        with self.assertRaises(ClientError):
            read_detection_confidence(0.29)
        with self.assertRaises(ClientError):
            read_detection_confidence(0.91)

    def test_start_detection_propagates_ui_confidence(self):
        state = StudioState()
        record = ImageRecord("test", Path(__file__), "test.png", 1, 1, 0)
        with patch.object(state, "_records_for_ids", return_value=[record]), patch.object(state, "_start_job") as start:
            state.start_detection(["test"], 0.65)
        self.assertEqual(start.call_args.args[0], "detect")
        self.assertEqual(start.call_args.args[-1], 0.65)
        with patch.object(state, "_records_for_ids", return_value=[record]), patch.object(state, "_start_job") as start:
            state.start_detection(["test"])
        self.assertEqual(start.call_args.args[-1], DEFAULT_DETECTION_CONFIDENCE)

    def test_frontend_contract_has_safe_mouse_and_localized_controls(self):
        root = Path(__file__).resolve().parents[1]
        app = (root / "static" / "app.js").read_text(encoding="utf-8")
        page = (root / "static" / "index.html").read_text(encoding="utf-8")
        styles = (root / "static" / "style.css").read_text(encoding="utf-8")
        dictionary = json.loads((root / "static" / "i18n" / "ja.json").read_text(encoding="utf-8"))
        self.assertIn('event.button !== 0', app)
        self.assertIn('event.buttons & 1', app)
        self.assertIn('event.shiftKey', app)
        self.assertIn('canvas.addEventListener("contextmenu"', app)
        self.assertIn('confidence: detectionConfidence()', app)
        self.assertIn('data-i18n="editor.undo"', page)
        self.assertIn('id="detectCurrentButton"', page)
        self.assertIn('id="detectAllButton"', page)
        self.assertIn('id="saveButton"', page)
        self.assertIn('grid-auto-rows: max-content', styles)
        self.assertIn('object-fit: contain', styles)
        self.assertIn('gallery.detectAll', dictionary)

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

    def test_pick_folder_api_uses_sta_common_item_dialog_and_handles_cancel(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            initial = Path(directory).resolve()
            selected = initial / "日本語フォルダ"
            selected.mkdir()
            completed = [
                CompletedProcess([], 0, str(selected).encode("utf-8"), b""),
                CompletedProcess([], 0, b"", b""),
            ]
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            try:
                with patch("server.subprocess.run", side_effect=completed) as run:
                    body = json.dumps({"path": str(initial)}).encode("utf-8")
                    connection.request("POST", "/api/pick-folder", body, {"Content-Type": "application/json"})
                    response = connection.getresponse()
                    payload = json.loads(response.read().decode("utf-8"))
                    self.assertEqual(response.status, 200)
                    self.assertEqual(payload, {"cancelled": False, "path": str(selected.resolve())})
                    command = run.call_args_list[0].args[0]
                    self.assertIn("-NoProfile", command)
                    self.assertIn("-STA", command)
                    self.assertIn("-NonInteractive", command)
                    self.assertEqual(
                        run.call_args_list[0].kwargs["env"]["MOSAIC_STUDIO_INITIAL_FOLDER"],
                        str(initial),
                    )

                    connection.request("POST", "/api/pick-folder", body, {"Content-Type": "application/json"})
                    response = connection.getresponse()
                    payload = json.loads(response.read().decode("utf-8"))
                    self.assertEqual(response.status, 200)
                    self.assertEqual(payload, {"cancelled": True})
            finally:
                connection.close()
                httpd.shutdown()
                httpd.server_close()

    def test_pick_folder_rejects_parallel_dialog(self):
        FOLDER_PICKER_LOCK.acquire()
        try:
            with self.assertRaisesRegex(ClientError, "既に開いています"):
                pick_windows_folder("")
        finally:
            FOLDER_PICKER_LOCK.release()

    def test_folder_picker_script_uses_common_item_dialog_contract(self):
        from server import FOLDER_PICKER_SCRIPT

        self.assertIn("IFileOpenDialog", FOLDER_PICKER_SCRIPT)
        self.assertIn("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7", FOLDER_PICKER_SCRIPT)
        self.assertIn("D57C7288-D4AD-4768-BE02-9D969532D960", FOLDER_PICKER_SCRIPT)
        self.assertIn("FOS.FOS_PICKFOLDERS | FOS.FOS_FORCEFILESYSTEM | FOS.FOS_PATHMUSTEXIST", FOLDER_PICKER_SCRIPT)
        self.assertIn("SetDefaultFolder(defaultFolder)", FOLDER_PICKER_SCRIPT)
        self.assertNotIn("dialog.SetFolder(", FOLDER_PICKER_SCRIPT)
        self.assertIn("Marshal.FinalReleaseComObject", FOLDER_PICKER_SCRIPT)
        self.assertIn("Marshal.FreeCoTaskMem(pathPointer)", FOLDER_PICKER_SCRIPT)
        self.assertNotIn("FolderBrowserDialog", FOLDER_PICKER_SCRIPT)
        self.assertNotIn("System.Windows.Forms", FOLDER_PICKER_SCRIPT)

        interface_start = FOLDER_PICKER_SCRIPT.index("internal interface IFileOpenDialog {")
        interface_end = FOLDER_PICKER_SCRIPT.index("    }", interface_start)
        interface_block = FOLDER_PICKER_SCRIPT[interface_start:interface_end]
        method_order = [
            "Show(",
            "SetFileTypes(",
            "SetFileTypeIndex(",
            "GetFileTypeIndex(",
            "Advise(",
            "Unadvise(",
            "SetOptions(",
            "GetOptions(",
            "SetDefaultFolder(",
            "SetFolder(",
            "GetFolder(",
            "GetCurrentSelection(",
            "SetFileName(",
            "GetFileName(",
            "SetTitle(",
            "SetOkButtonLabel(",
            "SetFileNameLabel(",
            "GetResult(",
            "AddPlace(",
            "SetDefaultExtension(",
            "Close(",
            "SetClientGuid(",
            "ClearClientData(",
            "SetFilter(",
            "GetResults(",
            "GetSelectedItems(",
        ]
        positions = [interface_block.index(method) for method in method_order]
        self.assertEqual(positions, sorted(positions))
        self.assertNotIn("IFileOpenDialog :", FOLDER_PICKER_SCRIPT)


if __name__ == "__main__":
    unittest.main()
