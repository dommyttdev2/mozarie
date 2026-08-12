import http.client
import base64
import hashlib
import io
import json
import logging
import math
import os
import re
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import numpy as np
import cv2
from PIL import Image, ImageOps, PngImagePlugin

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server as server_module  # noqa: E402
from server import (  # noqa: E402
    Candidate,
    ClientError,
    DEFAULT_DETECTION_CONFIDENCE,
    DetectionModels,
    ImageRecord,
    JOB_LABELS,
    LocalModelManifest,
    MosaicHandler,
    PRECISE_MODEL,
    StudioState,
    TARGET_CLASSES,
    accepted_hand_sam_mask,
    arbitrate_segment_sources,
    assert_onnx_cuda_available,
    assert_onnx_cuda_active,
    calculate_block_size,
    clip_mask_to_roi,
    confidence_for_class,
    confidence_for_source,
    precise_confidence,
    detection_tiles,
    jpeg_metadata_manifest,
    mask_iou,
    merge_segment,
    png_ancillary_manifest,
    restore_tile_mask,
    read_boundary_request,
    read_detection_confidence,
    normalize_precise_class,
    padded_hand_box,
    refine_mask_with_hand,
    _read_mosaic_divisor,
    save_with_mask,
    select_best_sam_mask,
    validate_model_manifest,
    webp_metadata_manifest,
    white_fluid_mask,
    LOG_DATE_FORMAT,
    LOG_FORMAT,
    _open_browser,
    _schedule_browser_open,
)


class MosaicStudioTests(unittest.TestCase):
    def setUp(self) -> None:
        self._cache_directory = tempfile.TemporaryDirectory()
        self.cache_dir = Path(self._cache_directory.name) / "cache"
        self._states: list[StudioState] = []

    def tearDown(self) -> None:
        for state in self._states:
            state.shutdown()
        self._cache_directory.cleanup()

    def new_state(self) -> StudioState:
        state = StudioState(self.cache_dir, self.cache_dir.parent / "sessions")
        self._states.append(state)
        return state

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

    def test_block_size_uses_image_specific_divisor_and_minimum(self):
        self.assertEqual(calculate_block_size(300, 200, 100), 4)
        self.assertEqual(calculate_block_size(400, 220, 100), 4)
        self.assertEqual(calculate_block_size(401, 220, 100), 5)
        self.assertEqual(calculate_block_size(1000, 999, 100), 10)
        self.assertEqual(calculate_block_size(1216, 832, 100), 13)
        self.assertEqual(calculate_block_size(1301, 832, 100), 14)
        self.assertEqual(calculate_block_size(1301, 832, 200), 7)
        self.assertEqual(_read_mosaic_divisor("100"), 100)
        with self.assertRaises(ClientError):
            _read_mosaic_divisor(0)

    @staticmethod
    def _png_data_url(image: Image.Image) -> str:
        encoded = io.BytesIO()
        image.save(encoded, format="PNG")
        return "data:image/png;base64," + base64.b64encode(encoded.getvalue()).decode("ascii")

    def test_decode_mask_uses_alpha_not_transparent_rgb(self):
        rgba = np.full((8, 8, 4), 255, dtype=np.uint8)
        rgba[..., 3] = 0
        rgba[2:4, 3:5, 3] = 255

        decoded = server_module._decode_mask(self._png_data_url(Image.fromarray(rgba, "RGBA")), 8, 8)

        self.assertEqual(np.count_nonzero(decoded), 4)
        self.assertTrue(np.all(decoded[2:4, 3:5] == 255))

    def test_decode_mask_rejects_rgb_and_non_png_payloads(self):
        with self.assertRaises(ClientError):
            server_module._decode_mask(self._png_data_url(Image.new("RGB", (8, 8), "white")), 8, 8)

        encoded = io.BytesIO()
        Image.new("L", (8, 8), 255).save(encoded, format="JPEG")
        data_url = "data:image/png;base64," + base64.b64encode(encoded.getvalue()).decode("ascii")
        with self.assertRaises(ClientError):
            server_module._decode_mask(data_url, 8, 8)

    def test_rgba_mosaic_uses_alpha_aware_average(self):
        rgba = np.zeros((2, 2, 4), dtype=np.uint8)
        rgba[0, 0] = (255, 0, 0, 255)
        output = server_module._apply_mosaic_to_image(
            Image.fromarray(rgba, "RGBA"), np.full((2, 2), 255, dtype=np.uint8), 2,
        )

        self.assertEqual(tuple(np.asarray(output)[0, 0]), (255, 0, 0, 255))

    def test_standard_log_format_has_timestamp_level_and_message(self):
        record = logging.LogRecord("test", logging.INFO, __file__, 1, "起動: %s", ("OK",), None)
        output = logging.Formatter(LOG_FORMAT, datefmt=LOG_DATE_FORMAT).format(record)
        self.assertRegex(output, r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| INFO \| 起動: OK$")

    def test_browser_opener_logs_result_without_raising(self):
        with patch("server.webbrowser.open", return_value=True) as open_browser:
            with self.assertLogs(server_module.LOGGER, "INFO") as logs:
                _open_browser("http://127.0.0.1:8765")
        open_browser.assert_called_once_with("http://127.0.0.1:8765")
        self.assertIn("既定ブラウザを開きました", "\n".join(logs.output))

        with patch("server.webbrowser.open", return_value=False):
            with self.assertLogs(server_module.LOGGER, "WARNING") as logs:
                _open_browser("http://127.0.0.1:8765")
        self.assertIn("既定ブラウザを開けませんでした", "\n".join(logs.output))

    def test_browser_open_is_scheduled_once_as_daemon(self):
        with patch("server.threading.Timer") as timer_class:
            timer = timer_class.return_value
            _schedule_browser_open("http://127.0.0.1:8765")
        timer_class.assert_called_once_with(0.1, _open_browser, args=("http://127.0.0.1:8765",))
        self.assertTrue(timer.daemon)
        timer.start.assert_called_once_with()

    def test_main_configures_logging_and_schedules_one_browser_open(self):
        fake_server = Mock()
        fake_server.serve_forever.side_effect = KeyboardInterrupt
        with patch("server.logging.basicConfig") as basic_config, \
               patch("server.ThreadingHTTPServer", return_value=fake_server) as server_class, \
               patch("server._schedule_browser_open") as schedule_browser, \
               patch.object(server_module.STATE, "shutdown") as shutdown, \
               patch.object(server_module.STATE, "cache_dir", self.cache_dir), \
              patch.object(sys, "argv", ["server.py", "--port", "9876"]):
            server_module.main()

        basic_config.assert_called_once_with(level=logging.INFO, format=LOG_FORMAT, datefmt=LOG_DATE_FORMAT)
        server_class.assert_called_once_with(("127.0.0.1", 9876), MosaicHandler)
        schedule_browser.assert_called_once_with("http://127.0.0.1:9876")
        fake_server.server_close.assert_called_once_with()
        shutdown.assert_called_once_with()

    def test_http_log_message_logs_successful_api_posts_and_errors_only(self):
        handler = object.__new__(MosaicHandler)
        handler.command = "GET"
        with patch.object(server_module.LOGGER, "info") as info, patch.object(server_module.LOGGER, "warning") as warning:
            handler.path = "/api/health"
            handler.log_message('"%s" %s %s', "GET /api/health HTTP/1.1", "200", "10")
            info.assert_not_called()
            warning.assert_not_called()

            handler.path = "/static/style.css"
            handler.log_message('"%s" %s %s', "GET /static/style.css HTTP/1.1", "200", "10")
            info.assert_not_called()
            warning.assert_not_called()

            handler.command = "POST"
            handler.path = "/api/detect"
            handler.log_message('"%s" %s %s', "POST /api/detect HTTP/1.1", "200", "10")
            info.assert_called_once()

            handler.command = "GET"
            handler.path = "/missing"
            handler.log_message('"%s" %s %s', "GET /missing HTTP/1.1", "404", "10")
            warning.assert_called_once()

    def test_job_lifecycle_logs_start_completion_and_failure(self):
        state = self.new_state()
        record = ImageRecord("test", Path(__file__), "test.png", 1, 1, 0)
        with patch("server.threading.Thread"):
            with self.assertLogs(server_module.LOGGER, "INFO") as logs:
                state._start_job("detect", [record], lambda *_args, **_kwargs: None)
        self.assertIn("バックグラウンド処理を開始", "\n".join(logs.output))
        self.assertIn(JOB_LABELS["detect"], "\n".join(logs.output))

        with self.assertLogs(server_module.LOGGER, "INFO") as logs:
            state._finish_job()
        self.assertIn("バックグラウンド処理が完了", "\n".join(logs.output))

        try:
            raise RuntimeError("test failure")
        except RuntimeError as exc:
            with self.assertLogs(server_module.LOGGER, "ERROR") as logs:
                state._fail_job(exc)
        self.assertIn("バックグラウンド処理に失敗", "\n".join(logs.output))

    def test_main_logs_bind_failure_and_exits(self):
        with patch("server.logging.basicConfig"), \
              patch("server.ThreadingHTTPServer", side_effect=OSError("port in use")), \
              patch.object(server_module.STATE, "shutdown") as shutdown, \
              patch.object(server_module.STATE, "cache_dir", self.cache_dir), \
              patch.object(sys, "argv", ["server.py", "--port", "9876"]):
            with self.assertLogs(server_module.LOGGER, "ERROR") as logs:
                with self.assertRaises(SystemExit) as raised:
                    server_module.main()
        self.assertEqual(raised.exception.code, 1)
        shutdown.assert_called_once_with()
        self.assertIn("サーバーを起動できません", "\n".join(logs.output))

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

    def test_exif_rotated_png_swaps_dimensions_and_preserves_other_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rotated.png"
            exif = Image.Exif()
            exif[274] = 6
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("prompt", '{"seed": 1}')
            metadata.add_itxt("workflow", '{"nodes": []}', lang="ja", tkey="workflow")
            Image.new("RGB", (40, 20), "#6688aa").save(path, format="PNG", exif=exif.tobytes(), pnginfo=metadata)
            source = path.read_bytes()
            record = ImageRecord("test", path, path.name, 20, 40, path.stat().st_mtime_ns)
            mask = np.zeros((40, 20), dtype=np.uint8)
            mask[4:12, 4:12] = 255

            output = server_module.render_with_mask(record, mask, 4)

            self.assertEqual(
                png_ancillary_manifest(source, exclude={b"eXIf"}),
                png_ancillary_manifest(output, exclude={b"eXIf"}),
            )
            with Image.open(io.BytesIO(output)) as saved:
                self.assertEqual(saved.size, (20, 40))
                self.assertEqual(saved.getexif().get(274), 1)
                self.assertEqual(saved.text["prompt"], '{"seed": 1}')
                self.assertEqual(saved.info["workflow"], '{"nodes": []}')
                saved.load()

    def test_exif_rotated_webp_swaps_dimensions_and_preserves_other_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rotated.webp"
            exif = Image.Exif()
            exif[274] = 6
            Image.new("RGB", (40, 20), "#6688aa").save(
                path, format="WEBP", exif=exif.tobytes(), icc_profile=b"Mosaic ICC", xmp=b"<x:xmpmeta>test</x:xmpmeta>",
            )
            source = path.read_bytes()
            record = ImageRecord("test", path, path.name, 20, 40, path.stat().st_mtime_ns)
            mask = np.zeros((40, 20), dtype=np.uint8)
            mask[4:12, 4:12] = 255

            output = server_module.render_with_mask(record, mask, 4)

            self.assertEqual(
                webp_metadata_manifest(source, exclude={b"EXIF"}),
                webp_metadata_manifest(output, exclude={b"EXIF"}),
            )
            with Image.open(io.BytesIO(output)) as saved:
                self.assertEqual(saved.size, (20, 40))
                self.assertEqual(saved.getexif().get(274), 1)
                saved.load()

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
            state = self.new_state()
            images = state.set_root(str(root))
            self.assertEqual(len(images), 1)
            self.assertEqual(state.image_for_id(images[0]["id"]).path, (nested / "one.png").resolve())
            with self.assertRaises(ClientError):
                state.image_for_id("..%2foutside")

    def test_rootless_import_is_available_for_lookup_and_detection_targets(self):
        raw_buffer = io.BytesIO()
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("prompt", '{"seed": 123}')
        metadata.add_text("workflow", '{"nodes": []}')
        Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG", pnginfo=metadata)
        state = self.new_state()

        imported = state.import_images([{"name": "dropped.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii")}])[0]
        record = state.image_for_id(imported["id"])
        records, _generation = state._records_for_ids_with_catalog([imported["id"]])

        self.assertIsNone(state.root)
        self.assertEqual(record.source_kind, "session")
        self.assertEqual(records, [record])
        self.assertEqual(Image.open(record.path).text["prompt"], '{"seed": 123}')
        self.assertEqual(Image.open(record.path).text["workflow"], '{"nodes": []}')

    def test_import_preserves_safe_nested_relative_paths_and_same_names(self):
        with tempfile.TemporaryDirectory() as directory:
            raw = io.BytesIO()
            Image.new("RGB", (8, 8), "white").save(raw, format="PNG")
            encoded = base64.b64encode(raw.getvalue()).decode("ascii")
            state = self.new_state()

            images = state.import_images([
                {"name": "same.png", "relativePath": "album/one/same.png", "data": encoded},
                {"name": "same.png", "relativePath": "album/two/same.png", "data": encoded},
            ])

            self.assertEqual([image["relativePath"] for image in images], ["album/one/same.png", "album/two/same.png"])
            self.assertTrue((state.session_imports_dir / "album" / "one" / "same.png").is_file())
            self.assertTrue((state.session_imports_dir / "album" / "two" / "same.png").is_file())

    def test_import_rejects_unsafe_relative_paths(self):
        raw = io.BytesIO()
        Image.new("RGB", (8, 8), "white").save(raw, format="PNG")
        encoded = base64.b64encode(raw.getvalue()).decode("ascii")
        state = self.new_state()

        for relative_path in ("", "/absolute.png", "C:/drive.png", "one//two.png", "./image.png", "one/../image.png"):
            with self.subTest(relative_path=relative_path), self.assertRaisesRegex(ClientError, "^画像の相対パスが不正です。$"):
                state.import_images([{"name": "image.png", "relativePath": relative_path, "data": encoded}])
    def test_import_keeps_original_bytes_under_the_session_folder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = io.BytesIO()
            Image.new("RGB", (10, 8), "white").save(source, format="PNG")
            raw = source.getvalue()
            state = self.new_state()
            state.set_root(str(root))
            images = state.import_images([{"name": "dropped.png", "data": base64.b64encode(raw).decode("ascii")}])
            self.assertEqual(len(images), 1)
            imported = state.session_imports_dir / "dropped.png"
            self.assertEqual(imported.read_bytes(), raw)
            state.import_images([{"name": "dropped.png", "data": base64.b64encode(raw).decode("ascii")}])
            self.assertTrue((state.session_imports_dir / "dropped_2.png").is_file())
            self.assertFalse((root / ".mosaicstudio_imports").exists())

    def test_clear_masks_removes_candidates_without_touching_image(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(path)
            original = path.read_bytes()
            state = self.new_state()
            images = state.set_root(directory)
            image_id = images[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            self.assertEqual(state.clear_masks([image_id]), 1)
            self.assertEqual(state.list_candidates(image_id), [])
            self.assertEqual(path.read_bytes(), original)

    def test_delete_candidate_is_idempotent_and_removes_its_mask(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(path)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]

            self.assertTrue(state.delete_candidate(image_id, "candidate"))
            self.assertFalse(mask_path.exists())
            self.assertEqual(state.list_candidates(image_id), [])
            self.assertFalse(state.delete_candidate(image_id, "candidate"))

    def test_image_listing_reports_enabled_candidates_for_gallery_filtering(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(path)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate-enabled.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [
                Candidate("enabled", "penis", 0.9, mask_path, enabled=True),
                Candidate("disabled", "penis", 0.9, mask_path, enabled=False),
            ]
            listed = state.list_images()[0]
            self.assertEqual(listed["candidateCount"], 2)
            self.assertEqual(listed["enabledCandidateCount"], 1)

    def test_clear_catalog_only_removes_images_from_the_screen_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(path)
            original = path.read_bytes()
            state = self.new_state()
            state.set_root(directory)

            state.clear_catalog()

            self.assertEqual(state.list_images(), [])
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(state.root, Path(directory).resolve())

    def test_remove_image_from_catalog_discards_working_state_but_keeps_source(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(path)
            original = path.read_bytes()
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            state._touch_candidates(image_id)

            self.assertEqual(state.remove_image_from_catalog(image_id), [])

            self.assertEqual(path.read_bytes(), original)
            self.assertNotIn(image_id, state.images)
            self.assertNotIn(image_id, state.order)
            self.assertNotIn(image_id, state.candidates)
            self.assertNotIn(image_id, state.candidate_revisions)
            self.assertFalse((state.cache_dir / image_id).exists())

    def test_remove_image_from_catalog_rejects_active_work(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(path)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            state.job.state = "running"

            with self.assertRaisesRegex(ClientError, "処理が終了"):
                state.remove_image_from_catalog(image_id)
            self.assertIn(image_id, state.images)

    def test_remove_session_image_cleans_masks_thumbnails_and_import_copy(self):
        encoded = io.BytesIO()
        Image.new("RGB", (16, 16), "white").save(encoded, format="PNG")
        state = self.new_state()
        images, _imported = state.import_images_for_api([{
            "clientKey": "session", "name": "nested/source.png", "data": base64.b64encode(encoded.getvalue()).decode("ascii"),
        }])
        image_id = images[0]["id"]
        record = state.image_for_id(image_id)
        mask_path = state.cache_dir / image_id / "candidate.png"
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
        state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
        thumbnail_dir = state.cache_dir / "thumbnails"
        thumbnail_dir.mkdir(parents=True, exist_ok=True)
        thumbnail = thumbnail_dir / f"{image_id}-test.jpg"
        thumbnail.write_bytes(b"thumbnail")

        state.remove_image_from_catalog(image_id)

        self.assertFalse(record.path.exists())
        self.assertFalse(mask_path.exists())
        self.assertFalse(thumbnail.exists())
        self.assertFalse((state.cache_dir / image_id).exists())

    def test_apply_is_overwrite_only_and_rejects_session_images(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "#6688aa").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            with patch.object(state, "combined_candidate_mask", return_value=self._mask(16, 16)), patch.object(state, "_start_job") as start_job:
                state.start_apply([image_id], 100, {})
            self.assertEqual(start_job.call_args.args[3], 100)
            self.assertEqual(start_job.call_args.args[4], {})
            buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "white").save(buffer, format="PNG")
            imported = state.import_images([{"name": "dropped.png", "data": base64.b64encode(buffer.getvalue()).decode("ascii")}])
            session_id = next(item["id"] for item in imported if item["sourceKind"] == "session")
            with self.assertRaisesRegex(ClientError, "コピー保存"):
                state.start_apply([session_id], 100, {})

    def test_apply_pause_resume_and_cancel_state_transitions(self):
        state = self.new_state()
        state.job = server_module.Job(kind="apply", state="running", total=2)
        state.job_control = server_module.JobControl()

        state.request_pause()
        self.assertTrue(state.job_control.pause_requested.is_set())

        state.job.state = "paused"
        state.resume_apply()
        self.assertEqual(state.job.state, "running")
        self.assertFalse(state.job_control.pause_requested.is_set())

        state.request_cancel()
        self.assertTrue(state.job_control.cancel_requested.is_set())
        self.assertFalse(state.job_control.pause_requested.is_set())

        state.job.state = "paused"
        state.request_cancel()
        self.assertEqual(state.job.state, "cancelled")

    def test_detect_cancel_is_cooperative_and_discards_the_inflight_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "first.png")
            Image.new("RGB", (16, 16), "black").save(root / "second.png")
            state = self.new_state()
            first_id, second_id = (image["id"] for image in state.set_root(str(root)))
            records = [state.image_for_id(first_id), state.image_for_id(second_id)]
            control = server_module.JobControl()
            state.job = server_module.Job(kind="detect", state="running", total=2, image_ids=(first_id, second_id))

            def detect_image(_models, record, _confidence):
                mask_path = state.cache_dir / record.image_id / "candidate.png"
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
                if record.image_id == second_id:
                    control.cancel_requested.set()
                return [Candidate(record.image_id, "penis", 0.9, mask_path)]

            with patch.object(state, "_ensure_models", return_value=[]), patch.object(state, "_detect_image", side_effect=detect_image):
                state._detect_worker(records, DEFAULT_DETECTION_CONFIDENCE, 1, control=control)

            self.assertEqual(state.job.state, "cancelled")
            self.assertEqual(state.job.completed, 1)
            self.assertEqual(state.job.completed_image_ids, (first_id,))
            self.assertEqual(len(state.candidates[first_id]), 1)
            self.assertEqual(state.candidates.get(second_id, []), [])
            self.assertFalse((state.cache_dir / second_id / "candidate.png").exists())

    def test_detect_cancel_between_inference_and_commit_preserves_existing_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            record = state.image_for_id(image_id)
            control = server_module.JobControl()
            state.job = server_module.Job(kind="detect", state="running", total=1, image_ids=(image_id,))

            old_mask_path = state.cache_dir / image_id / "old.png"
            old_mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(old_mask_path)
            old_candidate = Candidate("old", "penis", 0.8, old_mask_path)
            state.candidates[image_id] = [old_candidate]
            new_mask_path = state.cache_dir / image_id / "new.png"
            inject_cancel = False
            original_lock = state.lock

            class CancelBeforeCommit:
                def __enter__(self):
                    original_lock.__enter__()
                    if inject_cancel:
                        control.cancel_requested.set()
                    return self

                def __exit__(self, *args):
                    return original_lock.__exit__(*args)

            def detect_image(*_args):
                nonlocal inject_cancel
                Image.fromarray(self._mask(16, 16), mode="L").save(new_mask_path)
                inject_cancel = True
                return [Candidate("new", "penis", 0.9, new_mask_path)]

            state.lock = CancelBeforeCommit()
            try:
                with patch.object(state, "_ensure_models", return_value=[]), patch.object(state, "_detect_image", side_effect=detect_image):
                    state._detect_worker([record], DEFAULT_DETECTION_CONFIDENCE, control=control)
            finally:
                state.lock = original_lock

            self.assertEqual(state.job.state, "cancelled")
            self.assertEqual(state.job.completed, 0)
            self.assertEqual(state.job.completed_image_ids, ())
            self.assertEqual(state.candidates[image_id], [old_candidate])
            self.assertTrue(old_mask_path.is_file())
            self.assertFalse(new_mask_path.exists())

    def test_detect_job_can_be_cancelled_with_the_shared_control(self):
        state = self.new_state()
        state.job = server_module.Job(kind="detect", state="running", total=1)
        state.job_control = server_module.JobControl()
        state.request_cancel()
        self.assertTrue(state.job_control.cancel_requested.is_set())

    def test_detection_parallelism_is_limited_to_one_through_four(self):
        self.assertEqual(server_module._read_detection_parallelism(1), 1)
        self.assertEqual(server_module._read_detection_parallelism(4), 4)
        for value in (0, 5, True, "2"):
            with self.subTest(value=value), self.assertRaisesRegex(ClientError, "1から4"):
                server_module._read_detection_parallelism(value)

    def test_parallel_detection_assigns_a_dedicated_model_to_each_worker_and_commits_revisions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "first.png")
            Image.new("RGB", (16, 16), "black").save(root / "second.png")
            state = self.new_state()
            images = state.set_root(directory)
            records = [state.image_for_id(image["id"]) for image in images]
            state.job = server_module.Job(kind="detect", state="running", total=2, image_ids=tuple(record.image_id for record in records))
            base_models = object()
            second_models = object()
            seen_models: list[int] = []

            def detect_image(models, record, _confidence):
                seen_models.append(id(models))
                mask_path = state.cache_dir / record.image_id / "candidate.png"
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
                return [Candidate(record.image_id, "penis", 0.9, mask_path)]

            with patch.object(state, "_ensure_models", return_value=base_models), patch.object(state, "_load_detection_models", return_value=second_models), patch.object(state, "_detect_image", side_effect=detect_image):
                state._detect_worker(records, DEFAULT_DETECTION_CONFIDENCE, 2)

            self.assertEqual(set(seen_models), {id(base_models), id(second_models)})
            self.assertEqual(state.job.state, "complete")
            self.assertEqual(state.job.completed, 2)
            self.assertEqual(set(state.job.completed_image_ids), {record.image_id for record in records})
            self.assertTrue(all(state._candidate_revision(record.image_id) == 1 for record in records))

    def test_parallel_detection_progress_never_moves_backward(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "first.png")
            Image.new("RGB", (16, 16), "black").save(root / "second.png")
            state = self.new_state()
            records = [state.image_for_id(image["id"]) for image in state.set_root(directory)]
            state.job = server_module.Job(kind="detect", state="running", total=2, image_ids=tuple(record.image_id for record in records))
            second_started = threading.Event()
            first_completed = threading.Event()
            release_second = threading.Event()
            observed_progress: list[int] = []
            original_set_current = state._set_job_current

            def set_current(current, *args, **kwargs):
                if current == records[1].relative_path and not second_started.is_set():
                    second_started.set()
                    self.assertTrue(release_second.wait(2))
                result = original_set_current(current, *args, **kwargs)
                observed_progress.append(state.job.completed)
                if current == records[0].relative_path and state.job.completed == 1:
                    first_completed.set()
                return result

            def detect_image(_models, record, _confidence):
                if record is records[0]:
                    self.assertTrue(second_started.wait(2))
                mask_path = state.cache_dir / record.image_id / "candidate.png"
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
                return [Candidate(record.image_id, "penis", 0.9, mask_path)]

            thread = threading.Thread(
                target=state._detect_worker,
                args=(records, DEFAULT_DETECTION_CONFIDENCE, 2),
            )
            with patch.object(state, "_ensure_models", return_value=object()), patch.object(state, "_load_detection_models", return_value=object()), patch.object(state, "_detect_image", side_effect=detect_image), patch.object(state, "_set_job_current", side_effect=set_current):
                thread.start()
                self.assertTrue(first_completed.wait(2))
                release_second.set()
                thread.join(2)

            self.assertFalse(thread.is_alive())
            self.assertEqual(observed_progress, sorted(observed_progress))
            self.assertEqual(state.job.completed, 2)

    def test_parallel_detection_cancellation_discards_all_inflight_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "first.png")
            Image.new("RGB", (16, 16), "black").save(root / "second.png")
            state = self.new_state()
            records = [state.image_for_id(image["id"]) for image in state.set_root(directory)]
            control = server_module.JobControl()
            started = threading.Event()
            release = threading.Event()

            def detect_image(_models, record, _confidence):
                mask_path = state.cache_dir / record.image_id / "candidate.png"
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
                if record is records[0]:
                    started.set()
                    self.assertTrue(release.wait(2))
                else:
                    self.assertTrue(started.wait(2))
                    control.cancel_requested.set()
                    release.set()
                return [Candidate(record.image_id, "penis", 0.9, mask_path)]

            state.job = server_module.Job(kind="detect", state="running", total=2, image_ids=tuple(record.image_id for record in records))
            with patch.object(state, "_ensure_models", return_value=object()), patch.object(state, "_load_detection_models", return_value=object()), patch.object(state, "_detect_image", side_effect=detect_image):
                state._detect_worker(records, DEFAULT_DETECTION_CONFIDENCE, 2, control=control)

            self.assertEqual(state.job.state, "cancelled")
            self.assertEqual(state.job.completed, 0)
            self.assertTrue(all(not state.candidates.get(record.image_id) for record in records))
            self.assertTrue(all(state._candidate_revision(record.image_id) == 0 for record in records))

    def test_cancelled_or_failed_apply_reports_only_successfully_completed_images(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.png"
            second = root / "second.png"
            Image.new("RGB", (16, 16), "#6688aa").save(first)
            Image.new("RGB", (16, 16), "#aa8866").save(second)
            state = self.new_state()
            first_id, second_id = (image["id"] for image in state.set_root(str(root)))
            records = [state.image_for_id(first_id), state.image_for_id(second_id)]
            masks = {first_id: self._mask(16, 16), second_id: self._mask(16, 16)}
            control = server_module.JobControl()
            state.job = server_module.Job(kind="apply", state="running", total=2, image_ids=(first_id, second_id))
            original_save = server_module.save_with_mask

            def save_then_cancel(*args, **kwargs):
                original_save(*args, **kwargs)
                control.cancel_requested.set()

            with patch.object(server_module, "save_with_mask", side_effect=save_then_cancel):
                state._apply_worker(records, 100, masks, control=control)
            self.assertEqual(state.job.state, "cancelled")
            self.assertEqual(state.job.completed_image_ids, (first_id,))

            state.job = server_module.Job(kind="apply", state="running", total=2, image_ids=(first_id, second_id))
            call_count = 0

            def save_then_fail(*args, **kwargs):
                nonlocal call_count
                call_count += 1
                if call_count == 2:
                    raise RuntimeError("second image failed")
                original_save(*args, **kwargs)

            with patch.object(server_module, "save_with_mask", side_effect=save_then_fail):
                state._apply_worker(records, 100, masks)
            self.assertEqual(state.job.state, "error")
            self.assertEqual(state.job.completed_image_ids, (first_id,))

    def test_combined_mask_includes_draft_add_and_exclusion(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(path)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            add = np.zeros((16, 16), dtype=np.uint8)
            add[2:10, 2:10] = 255
            exclusion = np.zeros((16, 16), dtype=np.uint8)
            exclusion[4:6, 4:6] = 255
            combined = state.combined_candidate_mask(image_id, (add, exclusion))
            self.assertEqual(combined[3, 3], 255)
            self.assertEqual(combined[4, 4], 0)

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
        duplicate[2:8, 2:8] = 255
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
        secondary[2:8, 2:8] = 255
        segments = []
        merge_segment(segments, "penis", 0.62, first, "primary")
        merge_segment(segments, "penis", 0.91, secondary, "secondary")
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["source"], "primary")
        self.assertTrue(np.array_equal(segments[0]["mask"], first))

    def test_detection_confidence_validation_and_secondary_floor(self):
        self.assertEqual(DEFAULT_DETECTION_CONFIDENCE, 0.50)
        self.assertAlmostEqual(precise_confidence(DEFAULT_DETECTION_CONFIDENCE), 0.50)
        self.assertAlmostEqual(precise_confidence(0.10), 0.10)
        self.assertEqual(read_detection_confidence("0.10"), 0.10)
        self.assertEqual(read_detection_confidence("1.00"), 1.00)
        self.assertAlmostEqual(confidence_for_source("primary", 0.60), 0.45)
        self.assertEqual(confidence_for_source("secondary", 0.10), 0.50)
        self.assertEqual(confidence_for_source("secondary", 0.85), 0.85)
        self.assertEqual(confidence_for_class("primary", "penis", 0.60), 0.60)
        self.assertEqual(confidence_for_class("secondary", "penis", 0.10), 0.50)
        with self.assertRaises(ClientError):
            read_detection_confidence(0.09)
        with self.assertRaisesRegex(ClientError, "0.10から1.00"):
            read_detection_confidence(1.01)

    def test_precise_class_normalization_keeps_only_stable_genital_classes(self):
        self.assertEqual(TARGET_CLASSES, {"penis", "pussy"})
        self.assertEqual(normalize_precise_class("penis"), "penis")
        self.assertEqual(normalize_precise_class("Vagina"), "pussy")
        self.assertIsNone(normalize_precise_class("anus"))
        self.assertIsNone(normalize_precise_class("testicles"))

    def test_precise_source_replaces_only_overlapping_legacy_segments(self):
        precise = np.zeros((40, 40), dtype=np.uint8)
        precise[5:15, 5:15] = 255
        overlapping_legacy = np.zeros((40, 40), dtype=np.uint8)
        overlapping_legacy[4:18, 4:18] = 255
        unmatched_legacy = np.zeros((40, 40), dtype=np.uint8)
        unmatched_legacy[24:34, 24:34] = 255
        result = arbitrate_segment_sources([
            {"class_name": "penis", "confidence": 0.55, "mask": unmatched_legacy, "source": "primary"},
            {"class_name": "penis", "confidence": 0.80, "mask": overlapping_legacy, "source": "primary"},
            {"class_name": "penis", "confidence": 0.20, "mask": precise, "source": "precise"},
        ])
        self.assertEqual(len(result), 2)
        self.assertEqual([segment["source"] for segment in result], ["precise", "primary"])
        self.assertTrue(any(np.array_equal(segment["mask"], unmatched_legacy) for segment in result))

    def test_precise_arbitration_does_not_merge_nearby_organs(self):
        left = np.zeros((40, 40), dtype=np.uint8)
        left[5:13, 5:13] = 255
        right = np.zeros((40, 40), dtype=np.uint8)
        right[15:23, 15:23] = 255
        result = arbitrate_segment_sources([
            {"class_name": "pussy", "confidence": 0.5, "mask": left, "source": "precise"},
            {"class_name": "pussy", "confidence": 0.5, "mask": right, "source": "precise"},
        ])
        self.assertEqual(len(result), 2)

    def test_hand_refinement_removes_valid_overlap(self):
        genital = np.zeros((30, 30), dtype=np.uint8)
        genital[5:25, 5:25] = 255
        hand = np.zeros_like(genital)
        hand[5:8, 10:20] = 255
        refined, decision = refine_mask_with_hand(genital, hand)
        self.assertEqual(decision, "refined")
        self.assertTrue(np.all(refined[5:8, 10:20] == 0))
        self.assertLess(np.count_nonzero(refined), np.count_nonzero(genital))

    def test_hand_refinement_skips_over_cap(self):
        genital = np.zeros((30, 30), dtype=np.uint8)
        genital[5:25, 5:25] = 255
        large_hand = np.zeros_like(genital)
        large_hand[5:25, 5:25] = 255
        unchanged, decision = refine_mask_with_hand(genital, large_hand)
        self.assertEqual(decision, "over_cap")
        self.assertTrue(np.array_equal(unchanged, genital))

    def test_hand_refinement_requires_a_minimum_remaining_mask(self):
        genital = np.zeros((20, 20), dtype=np.uint8)
        genital[5:15, 5:15] = 255
        hand = np.zeros_like(genital)
        hand[5:15, 5:12] = 255
        unchanged, decision = refine_mask_with_hand(genital, hand)
        self.assertEqual(decision, "too_small")
        self.assertTrue(np.array_equal(unchanged, genital))

    def test_hand_sam_mask_rejects_low_quality_invalid_shape_and_empty_masks(self):
        mask = np.zeros((8, 8), dtype=bool)
        mask[2:6, 2:6] = True
        box = (0, 0, 8, 8)
        self.assertIsNone(accepted_hand_sam_mask(np.array([mask]), np.array([0.87]), (8, 8), box))
        self.assertIsNone(accepted_hand_sam_mask(np.array([mask]), np.array([0.95]), (9, 9), box))
        self.assertIsNone(accepted_hand_sam_mask(np.zeros((1, 8, 8), dtype=bool), np.array([0.95]), (8, 8), box))
        outside = np.zeros((8, 8), dtype=bool)
        outside[:2, :2] = True
        self.assertIsNone(accepted_hand_sam_mask(np.array([outside]), np.array([0.95]), (8, 8), (2, 2, 8, 8)))
        accepted = accepted_hand_sam_mask(np.array([mask]), np.array([0.88]), (8, 8), box)
        self.assertIsNotNone(accepted)
        self.assertTrue(np.all(accepted[2:6, 2:6] == 255))

    def test_hand_sam_mask_uses_next_highest_scoring_valid_proposal(self):
        outside = np.ones((10, 10), dtype=bool)
        valid = np.zeros((10, 10), dtype=bool)
        valid[3:7, 3:7] = True
        accepted = accepted_hand_sam_mask(
            np.array([outside, valid]), np.array([0.97, 0.95]), (10, 10), (2, 2, 8, 8)
        )
        self.assertTrue(np.array_equal(accepted, valid.astype(np.uint8) * 255))

    def test_padded_hand_box_uses_the_specified_bounded_padding(self):
        self.assertEqual(padded_hand_box((10, 10, 20, 30), (50, 50)), (8, 8, 22, 32))
        self.assertEqual(padded_hand_box((5, 5, 505, 505), (512, 512)), (0, 0, 512, 512))

    def test_white_fluid_mask_accepts_a_small_strong_white_penis_component(self):
        rgb = np.zeros((24, 24, 3), dtype=np.uint8)
        penis = np.zeros((24, 24), dtype=np.uint8)
        penis[2:22, 2:22] = 255
        rgb[8:12, 8:12] = 255
        fluid = white_fluid_mask(Image.fromarray(rgb, mode="RGB"), penis)
        self.assertEqual(np.count_nonzero(fluid), 16)

    def test_white_fluid_mask_rejects_large_high_saturation_and_noise_components(self):
        rgb = np.zeros((24, 24, 3), dtype=np.uint8)
        penis = np.zeros((24, 24), dtype=np.uint8)
        penis[2:22, 2:22] = 255
        rgb[3:13, 3:13] = 255
        rgb[15:19, 3:7] = (255, 40, 40)
        rgb[20, 20] = 255
        fluid = white_fluid_mask(Image.fromarray(rgb, mode="RGB"), penis)
        self.assertFalse(np.any(fluid))

    def test_white_fluid_mask_rejects_pale_skin_connected_to_white_seeds(self):
        rgb = np.zeros((24, 24, 3), dtype=np.uint8)
        penis = np.zeros((24, 24), dtype=np.uint8)
        penis[2:22, 2:22] = 255
        rgb[6:11, 6:14] = (245, 230, 215)
        rgb[(6, 6, 10, 10), (6, 10, 6, 10)] = 255
        fluid = white_fluid_mask(Image.fromarray(rgb, mode="RGB"), penis)
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
            server_module.cv2,
            "connectedComponentsWithStats",
            return_value=(len(components) + 1, tracked_labels, stats, np.zeros((len(components) + 1, 2))),
        ):
            fluid = white_fluid_mask(Image.fromarray(rgb, mode="RGB"), penis)
        self.assertEqual(TrackingLabels.equality_scans, 0)
        self.assertEqual(np.count_nonzero(fluid), 8 * 16)
        for top, left in components[:8]:
            self.assertTrue(np.all(fluid[top:top + 4, left:left + 4] == 255))

    def test_import_rejects_malformed_and_suffix_mismatched_images(self):
        valid = io.BytesIO()
        Image.new("RGB", (8, 8), "white").save(valid, format="PNG")
        state = self.new_state()
        with self.assertRaises(ClientError):
            state.import_images([{
                "name": "wrong.jpg", "data": base64.b64encode(valid.getvalue()).decode("ascii"),
            }])
        with self.assertRaises(ClientError):
            state.import_images([{
                "name": "broken.png", "data": base64.b64encode(valid.getvalue()[:20]).decode("ascii"),
            }])

    def test_model_manifest_rejects_missing_size_and_hash_mismatches(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.onnx"
            path.write_bytes(b"verified")
            manifest = LocalModelManifest("test", path, 8, hashlib.sha256(b"verified").hexdigest(), "r", "MIT", "https://example.invalid")
            validate_model_manifest(manifest)
            with self.assertRaisesRegex(ClientError, "サイズ"):
                validate_model_manifest(LocalModelManifest("test", path, 7, manifest.sha256, "r", "MIT", "https://example.invalid"))
            with self.assertRaisesRegex(ClientError, "SHA-256"):
                validate_model_manifest(LocalModelManifest("test", path, 8, "0" * 64, "r", "MIT", "https://example.invalid"))
            path.unlink()
            with self.assertRaisesRegex(ClientError, "見つかりません"):
                validate_model_manifest(manifest)

    def test_model_manifest_reuses_hash_until_the_file_stat_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.onnx"
            path.write_bytes(b"verified")
            manifest = LocalModelManifest("test", path, 8, hashlib.sha256(b"verified").hexdigest(), "r", "MIT", "https://example.invalid")
            with patch("server.model_sha256", wraps=server_module.model_sha256) as digest:
                validate_model_manifest(manifest)
                validate_model_manifest(manifest)
                self.assertEqual(digest.call_count, 1)
                stat = path.stat()
                os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
                validate_model_manifest(manifest)
                self.assertEqual(digest.call_count, 2)

    def test_onnx_provider_check_requires_cuda_without_loading_a_gpu(self):
        class FakeSession:
            def __init__(self, providers): self.providers = providers
            def get_providers(self): return self.providers
        class FakeModel:
            def __init__(self, providers):
                onnx_backend = type("OnnxBackend", (), {"session": FakeSession(providers)})()
                auto_backend = type("AutoBackend", (), {"backend": onnx_backend})()
                self.predictor = type("Predictor", (), {"model": auto_backend})()
        assert_onnx_cuda_active(FakeModel(["CUDAExecutionProvider", "CPUExecutionProvider"]), PRECISE_MODEL)
        with self.assertRaisesRegex(ClientError, "CUDA"):
            assert_onnx_cuda_active(FakeModel(["CPUExecutionProvider"]), PRECISE_MODEL)

    def test_onnx_provider_preflight_rejects_cpu_only_runtime(self):
        with patch("onnxruntime.get_available_providers", return_value=["CPUExecutionProvider"]):
            with self.assertRaisesRegex(ClientError, "CUDAExecutionProvider"):
                assert_onnx_cuda_available()

    def test_model_verification_occurs_once_for_a_loaded_model_set(self):
        state = self.new_state()
        precise = Mock()
        primary = Mock()
        secondary = Mock()
        with patch.object(server_module, "validate_model_manifest") as validate, patch.object(
            server_module, "assert_onnx_cuda_available"
        ), patch.object(server_module, "YOLO", side_effect=[precise, primary, secondary]):
            first = state._ensure_models()
            second = state._ensure_models()
        self.assertIs(first, second)
        self.assertEqual(validate.call_count, 1)

    def test_precise_model_loads_without_optional_legacy_models(self):
        state = self.new_state()
        missing = Path(tempfile.gettempdir()) / "mosaicstudio-missing-model.pt"
        with patch.object(server_module, "validate_model_manifest"), patch.object(
            server_module, "assert_onnx_cuda_available"
        ), patch.object(server_module, "MODEL_PATH", missing), patch.object(
            server_module, "SECOND_MODEL_PATH", missing
        ), patch.object(server_module, "YOLO", return_value=Mock()) as yolo:
            models = state._ensure_models()
        self.assertIsNone(models.primary)
        self.assertIsNone(models.secondary)
        self.assertEqual(yolo.call_count, 1)

    def test_hand_model_verification_occurs_once_after_first_load(self):
        state = self.new_state()
        models = DetectionModels(Mock(), Mock())
        hand = Mock()
        with patch.object(server_module, "validate_model_manifest") as validate, patch.object(
            server_module, "assert_onnx_cuda_available"
        ), patch.object(server_module, "YOLO", return_value=hand):
            first = state._ensure_hand_model(models)
            second = state._ensure_hand_model(models)
        self.assertIs(first, second)
        self.assertEqual(validate.call_count, 1)

    def test_precise_segments_receive_hand_refinement(self):
        state = self.new_state()
        precise_mask = np.zeros((16, 16), dtype=np.uint8)
        precise_mask[4:12, 4:12] = 255
        record = ImageRecord("image", Path(__file__), "image.png", 16, 16, 0)
        sam_mask = np.zeros((1, 16, 16), dtype=bool)
        sam_mask[0, 4:8, 4:8] = True
        predictor = Mock()
        predictor.predict.return_value = sam_mask, np.asarray([0.95]), None
        with patch.object(state, "_hand_boxes", return_value=[(4, 4, 12, 12)]), patch.object(
            state, "_sam_predictor_for", return_value=predictor
        ):
            result = state._refine_detected_segments(
                Mock(), record, Image.new("RGB", (16, 16), "white"),
                [{"class_name": "penis", "confidence": 0.8, "mask": precise_mask, "source": "precise"}],
            )
        self.assertEqual(result[0]["refinement"], "hand")
        self.assertEqual(np.count_nonzero(result[0]["mask"]), 48)
        predictor.predict.assert_called_once()

    def test_hand_sam_runs_once_per_intersecting_hand_and_is_reused_by_all_segments(self):
        state = self.new_state()
        record = ImageRecord("image", Path(__file__), "image.png", 16, 16, 0)
        base_mask = np.zeros((16, 16), dtype=np.uint8)
        base_mask[4:12, 4:12] = 255

        def predict(*, box, **_kwargs):
            mask = np.zeros((1, 16, 16), dtype=bool)
            if box[0] < 5:
                mask[0, 4:6, 4:6] = True
            else:
                mask[0, 10:12, 10:12] = True
            return mask, np.asarray([0.95]), None

        predictor = Mock()
        predictor.predict.side_effect = predict
        segments = [
            {"class_name": "penis", "confidence": 0.8, "mask": base_mask.copy(), "source": source}
            for source in ("precise", "primary", "secondary")
        ]
        with patch.object(state, "_hand_boxes", return_value=[(4, 4, 8, 8), (8, 8, 12, 12), (0, 0, 2, 2)]) as hand_boxes, patch.object(
            state, "_sam_predictor_for", return_value=predictor
        ):
            result = state._refine_detected_segments(Mock(), record, Image.new("RGB", (16, 16), "white"), segments)
        hand_boxes.assert_called_once()
        self.assertEqual(predictor.predict.call_count, 2)
        self.assertTrue(all(segment["refinement"] == "hand" for segment in result))
        self.assertTrue(all(np.count_nonzero(segment["mask"]) == 56 for segment in result))

    def test_pussy_skips_white_fluid_refinement(self):
        state = self.new_state()
        pussy = np.zeros((16, 16), dtype=np.uint8)
        pussy[4:12, 4:12] = 255
        record = ImageRecord("image", Path(__file__), "image.png", 16, 16, 0)
        with patch.object(state, "_hand_boxes", return_value=[]), patch.object(server_module, "white_fluid_mask") as fluid_mask:
            result = state._refine_detected_segments(
                Mock(), record, Image.new("RGB", (16, 16), "white"),
                [{"class_name": "pussy", "confidence": 0.8, "mask": pussy, "source": "precise"}],
            )
        fluid_mask.assert_not_called()
        self.assertNotIn("refinement", result[0])

    def test_hand_and_fluid_refinement_metadata(self):
        state = self.new_state()
        penis = np.zeros((24, 24), dtype=np.uint8)
        penis[2:22, 2:22] = 255
        rgb = np.zeros((24, 24, 3), dtype=np.uint8)
        rgb[14:18, 14:18] = 255
        sam_mask = np.zeros((1, 24, 24), dtype=bool)
        sam_mask[0, 4:8, 4:8] = True
        predictor = Mock()
        predictor.predict.return_value = sam_mask, np.asarray([0.95]), None
        record = ImageRecord("image", Path(__file__), "image.png", 24, 24, 0)
        with patch.object(state, "_hand_boxes", return_value=[(4, 4, 8, 8)]), patch.object(
            state, "_sam_predictor_for", return_value=predictor
        ):
            result = state._refine_detected_segments(
                Mock(), record, Image.fromarray(rgb, mode="RGB"),
                [{"class_name": "penis", "confidence": 0.8, "mask": penis, "source": "precise"}],
            )
        self.assertEqual(result[0]["refinement"], "hand_fluid")
        self.assertEqual(server_module.REFINEMENT_LABELS[result[0]["refinement"]], "手の重なりと白い体液を除外")
        self.assertEqual(np.count_nonzero(result[0]["mask"]), 368)

    def test_boundary_request_requires_a_valid_roi_and_click(self):
        roi, point = read_boundary_request(
            {"roi": {"left": 2.2, "top": 3.1, "right": 12.6, "bottom": 15.8}, "point": {"x": 7, "y": 9}},
            20,
            20,
        )
        self.assertEqual(roi, (2, 3, 13, 16))
        self.assertEqual(point, (7.0, 9.0))
        _, fractional_point = read_boundary_request(
            {"roi": {"left": 1, "top": 1, "right": 10.4, "bottom": 10.4}, "point": {"x": 9.6, "y": 8.4}},
            20,
            20,
        )
        self.assertEqual(fractional_point, (9.6, 8.4))
        with self.assertRaises(ClientError):
            read_boundary_request(
                {"roi": {"left": 2, "top": 3, "right": 12, "bottom": 15}, "point": {"x": 12, "y": 9}},
                20,
                20,
            )

    def test_boundary_candidate_does_not_start_during_a_background_job(self):
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"
            Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            state = self.new_state()
            state.root = Path(directory)
            state.images = {record.image_id: record}
            state.order = [record.image_id]
            state.job.state = "running"
            with patch.object(state, "_sam_predictor_for") as predictor:
                with self.assertRaises(ClientError):
                    state.add_boundary_candidate(
                        record.image_id,
                        {"roi": {"left": 2, "top": 2, "right": 10, "bottom": 10}, "point": {"x": 5, "y": 5}},
                    )
            predictor.assert_not_called()

    def test_single_image_detection_uses_its_model_without_the_shared_inference_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"
            Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            state = self.new_state()
            state.root = Path(directory)
            state.images = {record.image_id: record}
            state.order = [record.image_id]

            def detect_image(*_args):
                self.assertFalse(state.inference_lock.locked())
                return []

            with patch.object(state, "_ensure_models", return_value=[]), patch.object(state, "_detect_image", side_effect=detect_image):
                state._detect_worker([record], DEFAULT_DETECTION_CONFIDENCE)

    def test_boundary_result_is_discarded_after_folder_reload(self):
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"
            Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            state = self.new_state()
            state.root = Path(directory)
            state.images = {record.image_id: record}
            state.order = [record.image_id]

            class ReloadingPredictor:
                def predict(self, **_kwargs):
                    state.set_root(directory)
                    masks = np.zeros((3, 12, 12), dtype=bool)
                    masks[0, 2:10, 2:10] = True
                    return masks, np.asarray([0.9, 0.4, 0.2]), None

            with patch.object(state, "_sam_predictor_for", return_value=ReloadingPredictor()):
                with self.assertRaisesRegex(ClientError, "再読み込み"):
                    state.add_boundary_candidate(
                        record.image_id,
                        {"roi": {"left": 2, "top": 2, "right": 10, "bottom": 10}, "point": {"x": 5, "y": 5}},
                    )
            self.assertFalse(state.candidates)

    def test_sam_mask_selection_and_roi_clip_are_deterministic(self):
        masks = np.zeros((3, 8, 8), dtype=bool)
        masks[0, 1:5, 1:5] = True
        masks[1, 0:7, 0:7] = True
        masks[2, 3:8, 3:8] = True
        selected, score = select_best_sam_mask(masks, np.asarray([0.31, 0.95, 0.71]))
        clipped = clip_mask_to_roi(selected, (2, 2, 6, 6))
        self.assertEqual(score, 0.95)
        self.assertTrue(np.all(clipped[:2] == 0))
        self.assertTrue(np.all(clipped[:, :2] == 0))
        self.assertTrue(np.all(clipped[6:] == 0))
        self.assertTrue(np.all(clipped[:, 6:] == 0))

    def test_boundary_candidate_uses_the_normal_candidate_mask_path(self):
        class FakePredictor:
            def predict(self, **_kwargs):
                self_outer.assertTrue(state.inference_lock.locked())
                masks = np.zeros((3, 12, 12), dtype=bool)
                masks[1, 1:11, 1:11] = True
                return masks, np.asarray([0.2, 0.9, 0.4]), None

        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"
            Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            state = self.new_state()
            self_outer = self
            state.root = Path(directory)
            state.images = {record.image_id: record}
            state.order = [record.image_id]
            with patch.object(state, "_sam_predictor_for", return_value=FakePredictor()):
                created = state.add_boundary_candidate(
                    record.image_id,
                    {"roi": {"left": 3, "top": 3, "right": 9, "bottom": 9}, "point": {"x": 5, "y": 5}},
                )

            self.assertEqual(created["source"], "boundary")
            self.assertEqual(created["className"], "境界")
            self.assertEqual(state.list_candidates(record.image_id), [created])
            combined = state.combined_candidate_mask(record.image_id)
            self.assertTrue(np.any(combined[3:9, 3:9]))
            self.assertFalse(np.any(combined[:3]))
            self.assertFalse(np.any(combined[:, :3]))

    def test_redetection_preserves_boundary_candidates_and_replaces_auto_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image_path = root / "image.png"
            Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            cache = root / "cache"
            cache.mkdir()
            boundary_path = cache / "boundary.png"
            old_auto_path = cache / "old-auto.png"
            new_auto_path = cache / "new-auto.png"
            Image.fromarray(self._mask(12, 12), mode="L").save(boundary_path)
            Image.fromarray(self._mask(12, 12), mode="L").save(old_auto_path)
            Image.fromarray(self._mask(12, 12), mode="L").save(new_auto_path)
            boundary = Candidate("boundary", "境界", 0.9, boundary_path, source="boundary")
            old_auto = Candidate("old-auto", "penis", 0.8, old_auto_path)
            new_auto = Candidate("new-auto", "penis", 0.7, new_auto_path)
            state = self.new_state()
            state.root = root
            state.images = {record.image_id: record}
            state.order = [record.image_id]
            state.candidates = {record.image_id: [boundary, old_auto]}
            with patch.object(state, "_ensure_models", return_value=[]), patch.object(state, "_detect_image", return_value=[new_auto]):
                state._detect_worker([record], DEFAULT_DETECTION_CONFIDENCE)

            self.assertEqual(state.candidates[record.image_id], [boundary, new_auto])
            self.assertTrue(boundary_path.is_file())
            self.assertFalse(old_auto_path.exists())
            self.assertTrue(new_auto_path.is_file())

    def test_boundary_api_returns_the_created_candidate(self):
        from http.server import ThreadingHTTPServer

        expected = {"id": "boundary", "className": "境界", "confidence": 0.87, "enabled": True, "color": "#ffffff", "source": "boundary"}
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        try:
            with patch.object(server_module.STATE, "add_boundary_candidate", return_value=expected) as add_candidate:
                body = json.dumps({"imageId": "image", "roi": {"left": 1, "top": 2, "right": 3, "bottom": 4}, "point": {"x": 2, "y": 3}}).encode("utf-8")
                connection.request("POST", "/api/boundary", body, {
                    "Content-Type": "application/json",
                    "X-Lets-Censoring-Token": server_module.STATE.session_token,
                    "Origin": f"http://127.0.0.1:{httpd.server_port}",
                })
                response = connection.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(payload, {"candidate": expected})
            self.assertEqual(add_candidate.call_args.args[0], "image")
        finally:
            connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_candidate_delete_api_returns_the_idempotent_result(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        try:
            with patch.object(server_module.STATE, "delete_candidate", side_effect=[True, False]) as delete_candidate:
                for expected in (True, False):
                    connection.request("DELETE", "/api/candidate/image/candidate", headers={
                        "X-Lets-Censoring-Token": server_module.STATE.session_token,
                        "Origin": f"http://127.0.0.1:{httpd.server_port}",
                    })
                    response = connection.getresponse()
                    payload = json.loads(response.read().decode("utf-8"))
                    self.assertEqual(response.status, 200)
                    self.assertEqual(payload, {"deleted": expected})
            self.assertEqual(delete_candidate.call_count, 2)
            delete_candidate.assert_called_with("image", "candidate")
        finally:
            connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_catalog_image_delete_api_removes_only_the_catalog_record(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        try:
            with patch.object(server_module.STATE, "remove_image_from_catalog", return_value=[{"id": "other"}]) as remove_image:
                connection.request("DELETE", "/api/catalog/image/current", headers={
                    "X-Lets-Censoring-Token": server_module.STATE.session_token,
                    "Origin": f"http://127.0.0.1:{httpd.server_port}",
                })
                response = connection.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(payload, {"images": [{"id": "other"}]})
            remove_image.assert_called_once_with("current")
        finally:
            connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_mutation_api_rejects_invalid_request_context(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{httpd.server_port}"
        cases = [
            ({"Content-Type": "application/json", "Origin": origin}, 403),
            ({
                "Content-Type": "application/json",
                "Origin": "http://127.0.0.1:1",
                "X-Lets-Censoring-Token": server_module.STATE.session_token,
            }, 403),
            ({
                "Content-Type": "text/plain",
                "Origin": origin,
                "X-Lets-Censoring-Token": server_module.STATE.session_token,
            }, 400),
        ]
        try:
            for headers, expected_status in cases:
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                try:
                    connection.request("POST", "/api/catalog/clear", b"{}", headers)
                    response = connection.getresponse()
                    response.read()
                    self.assertEqual(response.status, expected_status)
                finally:
                    connection.close()
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_start_detection_propagates_ui_confidence(self):
        state = self.new_state()
        record = ImageRecord("test", Path(__file__), "test.png", 1, 1, 0)
        with patch.object(state, "_records_for_ids_with_catalog", return_value=([record], 7)), patch.object(state, "_start_job") as start:
            state.start_detection(["test"], 0.65)
        self.assertEqual(start.call_args.args[0], "detect")
        self.assertEqual(start.call_args.args[-2:], (0.65, 2))
        self.assertEqual(start.call_args.kwargs["expected_catalog_generation"], 7)
        with patch.object(state, "_records_for_ids_with_catalog", return_value=([record], 8)), patch.object(state, "_start_job") as start:
            state.start_detection(["test"])
        self.assertEqual(start.call_args.args[-2:], (DEFAULT_DETECTION_CONFIDENCE, 2))
        self.assertEqual(start.call_args.kwargs["expected_catalog_generation"], 8)

    def test_detection_start_rejects_a_catalog_switch_after_records_are_captured(self):
        with tempfile.TemporaryDirectory() as directory:
            first_root = Path(directory) / "first"
            second_root = Path(directory) / "second"
            first_root.mkdir()
            second_root.mkdir()
            Image.new("RGB", (16, 16), "white").save(first_root / "first.png")
            Image.new("RGB", (16, 16), "black").save(second_root / "second.png")
            state = self.new_state()
            first_id = state.set_root(str(first_root))[0]["id"]
            original_start_job = state._start_job

            def switch_then_start(*args, **kwargs):
                state.set_root(str(second_root))
                return original_start_job(*args, **kwargs)

            with patch.object(state, "_start_job", side_effect=switch_then_start):
                with self.assertRaisesRegex(ClientError, "画像一覧が更新されたため"):
                    state.start_detection([first_id])

            self.assertEqual(state.root, second_root.resolve())
            self.assertEqual(state.job.state, "idle")

    def test_apply_start_rejects_a_catalog_switch_without_touching_old_source(self):
        with tempfile.TemporaryDirectory() as directory:
            first_root = Path(directory) / "first"
            second_root = Path(directory) / "second"
            first_root.mkdir()
            second_root.mkdir()
            source = first_root / "first.png"
            Image.new("RGB", (16, 16), "#6688aa").save(source)
            original_source = source.read_bytes()
            Image.new("RGB", (16, 16), "black").save(second_root / "second.png")
            state = self.new_state()
            first_id = state.set_root(str(first_root))[0]["id"]
            original_start_job = state._start_job

            def switch_then_start(*args, **kwargs):
                state.set_root(str(second_root))
                return original_start_job(*args, **kwargs)

            with patch.object(state, "combined_candidate_mask", return_value=self._mask(16, 16)), \
                 patch.object(state, "_start_job", side_effect=switch_then_start):
                with self.assertRaisesRegex(ClientError, "画像一覧が更新されたため"):
                    state.start_apply([first_id], 100, {})

            self.assertEqual(source.read_bytes(), original_source)
            self.assertEqual(state.root, second_root.resolve())

    def test_same_root_reload_waits_for_import_commit_and_replaces_the_session_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            state = self.new_state()
            state.set_root(str(root))
            entered = threading.Event()
            release = threading.Event()
            imported = threading.Event()
            reloaded = threading.Event()
            errors: list[Exception] = []
            original_verify = server_module._verify_decodable_image

            def blocked_verify(raw):
                original_verify(raw)
                entered.set()
                self.assertTrue(release.wait(2))

            def import_worker():
                try:
                    state.import_images([{"name": "imported.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii")}])
                except Exception as exc:  # pragma: no cover - asserted below
                    errors.append(exc)
                finally:
                    imported.set()

            def reload_worker():
                try:
                    state.set_root(str(root))
                except Exception as exc:  # pragma: no cover - asserted below
                    errors.append(exc)
                finally:
                    reloaded.set()

            with patch.object(server_module, "_verify_decodable_image", side_effect=blocked_verify):
                importer = threading.Thread(target=import_worker)
                importer.start()
                self.assertTrue(entered.wait(2))
                reloader = threading.Thread(target=reload_worker)
                reloader.start()
                self.assertFalse(reloaded.wait(0.1))
                release.set()
                importer.join(2)
                reloader.join(2)

            self.assertEqual(errors, [])
            self.assertTrue(imported.is_set())
            self.assertTrue(reloaded.is_set())
            self.assertFalse((root / ".mosaicstudio_imports").exists())
            self.assertEqual([image["relativePath"] for image in state.list_images()], ["source.png"])
            self.assertIsNone(state.session_dir)

    def test_concurrent_same_name_imports_commit_to_two_unique_intact_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            raw = raw_buffer.getvalue()
            state = self.new_state()
            state.set_root(str(root))
            barrier = threading.Barrier(3)
            errors: list[Exception] = []

            def import_worker():
                try:
                    barrier.wait()
                    state.import_images([{"name": "same.png", "data": base64.b64encode(raw).decode("ascii")}])
                except Exception as exc:  # pragma: no cover - asserted below
                    errors.append(exc)

            first = threading.Thread(target=import_worker)
            second = threading.Thread(target=import_worker)
            first.start()
            second.start()
            barrier.wait()
            first.join(2)
            second.join(2)

            self.assertEqual(errors, [])
            destination_dir = state.session_imports_dir
            self.assertIsNotNone(destination_dir)
            assert destination_dir is not None
            self.assertEqual((destination_dir / "same.png").read_bytes(), raw)
            self.assertEqual((destination_dir / "same_2.png").read_bytes(), raw)
            self.assertFalse((root / ".mosaicstudio_imports").exists())
            self.assertEqual(len(state.list_images()), 2)

    def test_drag_import_uses_a_session_without_writing_to_the_source_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "images"
            root.mkdir()
            raw_buffer = io.BytesIO()
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("workflow", "kept exactly")
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG", pnginfo=metadata)
            raw = raw_buffer.getvalue()
            state = self.new_state()
            state.set_root(str(root))

            images = state.import_images([{"name": "dropped.png", "data": base64.b64encode(raw).decode("ascii")}])

            imported = next(image for image in images if image["relativePath"] == "dropped.png")
            record = state.image_for_id(imported["id"])
            self.assertEqual(imported["sourceKind"], "session")
            self.assertEqual(record.path.read_bytes(), raw)
            self.assertEqual(Image.open(record.path).text["workflow"], "kept exactly")
            self.assertFalse((root / ".mosaicstudio_imports").exists())
            self.assertTrue(record.path.is_relative_to(state.session_imports_dir))

    def test_clear_catalog_removes_only_session_imports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "images"
            root.mkdir()
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            state = self.new_state()
            state.set_root(str(root))
            state.import_images([{"name": "dropped.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii")}])
            session_dir = state.session_dir

            state.clear_catalog()

            self.assertTrue(source.is_file())
            self.assertFalse((root / ".mosaicstudio_imports").exists())
            self.assertFalse(session_dir.exists())
            self.assertEqual(state.list_images(), [])

    def test_browser_session_save_preserves_nested_relative_path_and_temp_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "images"
            root.mkdir()
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            state = self.new_state()
            state.set_root(str(root))
            session_id = state.import_images([{
                "name": "dropped.png", "relativePath": "nested/dropped.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii"),
            }])[0]["id"]
            source = state.image_for_id(session_id)
            mask_path = state.cache_dir / session_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[session_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(session_id)

            entry = state.prepare_browser_save([session_id], 100, "_censored", False)[0]
            output, _record, output_revision, _save_token = state.render_browser_save(session_id, revision, 100, None)

            self.assertEqual(entry["relativePath"], "nested/dropped.png")
            self.assertEqual(output_revision, revision)
            self.assertEqual(Image.open(io.BytesIO(output)).size, (16, 16))
            self.assertTrue(source.path.is_file())
            self.assertEqual(source.source_kind, "session")

    def test_stale_session_is_cleaned_immediately_but_an_active_session_is_not(self):
        with tempfile.TemporaryDirectory() as directory:
            session_base = Path(directory) / "sessions"
            stale = session_base / "session-stale"
            stale.mkdir(parents=True)
            (stale / ".active.lock").write_bytes(b"1")

            first = StudioState(Path(directory) / "cache-first", session_base)
            self.assertFalse(stale.exists())
            root = Path(directory) / "images"
            root.mkdir()
            first.set_root(str(root))
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            first.import_images([{"name": "active.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii")}])
            active = first.session_dir

            second = StudioState(Path(directory) / "cache-second", session_base)

            self.assertTrue(active.exists())
            first.shutdown()
            second._cleanup_stale_sessions()
            self.assertFalse(active.exists())

    def test_fresh_session_without_a_lock_uses_a_short_grace_period(self):
        with tempfile.TemporaryDirectory() as directory:
            session_base = Path(directory) / "sessions"
            pending = session_base / "session-pending"
            pending.mkdir(parents=True)

            StudioState(Path(directory) / "cache-fresh", session_base)
            self.assertTrue(pending.exists())

            old = time.time() - 120
            os.utime(pending, (old, old))
            StudioState(Path(directory) / "cache-expired", session_base)
            self.assertFalse(pending.exists())

    def test_fresh_process_cache_without_a_lock_uses_a_short_grace_period(self):
        with tempfile.TemporaryDirectory() as directory:
            cache_base = Path(directory) / "cache"
            pending = cache_base / "process-pending"
            pending.mkdir(parents=True)

            with patch.object(server_module, "CACHE_BASE_DIR", cache_base):
                StudioState._cleanup_stale_process_caches()
                self.assertTrue(pending.exists())

                old = time.time() - 120
                os.utime(pending, (old, old))
                StudioState._cleanup_stale_process_caches()
                self.assertFalse(pending.exists())

    def test_import_rejects_when_a_job_has_already_started(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            record = state.image_for_id(image_id)
            entered = threading.Event()
            release = threading.Event()

            def worker(_records, **kwargs):
                entered.set()
                self.assertTrue(release.wait(2))
                state._finish_job(kwargs["job_generation"], kwargs["catalog_generation"])

            state._start_job("detect", [record], worker)
            self.assertTrue(entered.wait(2))
            with self.assertRaisesRegex(ClientError, "処理中は画像を追加できません"):
                state.import_images([{"name": "imported.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii")}])
            release.set()
            assert state.worker_thread is not None
            state.worker_thread.join(2)

    def test_job_start_rejects_while_import_is_still_private(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            record = state.image_for_id(image_id)
            entered = threading.Event()
            release = threading.Event()
            errors: list[Exception] = []
            original_verify = server_module._verify_decodable_image

            def blocked_verify(raw):
                original_verify(raw)
                entered.set()
                self.assertTrue(release.wait(2))

            def import_worker():
                try:
                    state.import_images([{"name": "imported.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii")}])
                except Exception as exc:  # pragma: no cover - asserted below
                    errors.append(exc)

            with patch.object(server_module, "_verify_decodable_image", side_effect=blocked_verify):
                importer = threading.Thread(target=import_worker)
                importer.start()
                self.assertTrue(entered.wait(2))
                with self.assertRaisesRegex(ClientError, "画像の追加中"):
                    state._start_job("detect", [record], lambda *_args, **_kwargs: None)
                release.set()
                importer.join(2)

            self.assertEqual(errors, [])
            self.assertFalse((root / ".mosaicstudio_imports").exists())
            self.assertIsNotNone(state.session_imports_dir)

    def test_job_api_exposes_immutable_target_image_ids(self):
        state = self.new_state()
        records = [
            ImageRecord("first", Path(__file__), "first.png", 1, 1, 0),
            ImageRecord("second", Path(__file__), "second.png", 1, 1, 0),
        ]
        with patch("server.threading.Thread"):
            state._start_job("apply", records, lambda *_args, **_kwargs: None)
        payload = state.job.as_dict()
        self.assertEqual(payload["imageIds"], ["first", "second"])
        self.assertEqual(payload["completedImageIds"], [])
        payload["imageIds"].append("other")
        self.assertEqual(state.job.image_ids, ("first", "second"))

    def test_injected_test_cache_never_touches_the_production_cache_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "images"
            root.mkdir()
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            simulated_production_cache = Path(directory) / "production-cache"
            simulated_production_cache.mkdir()
            sentinel = simulated_production_cache / "keep-me.txt"
            sentinel.write_text("sentinel", encoding="utf-8")

            state = self.new_state()
            state.set_root(str(root))

            self.assertEqual(sentinel.read_text(encoding="utf-8"), "sentinel")
            self.assertTrue(state.cache_dir.is_dir())
            self.assertNotEqual(state.cache_dir, simulated_production_cache)

    def test_candidate_mask_read_is_atomic_against_clear(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]

            opened = threading.Event()
            release = threading.Event()
            cleared = threading.Event()
            original_open = server_module.Image.open

            def delayed_open(path, *args, **kwargs):
                if Path(path) == mask_path:
                    opened.set()
                    self.assertTrue(release.wait(2))
                return original_open(path, *args, **kwargs)

            with patch.object(server_module.Image, "open", side_effect=delayed_open):
                reader = threading.Thread(target=state.read_candidate_mask_png, args=(image_id, "candidate"))
                clearer = threading.Thread(target=lambda: (state.clear_masks([image_id]), cleared.set()))
                reader.start()
                self.assertTrue(opened.wait(2))
                clearer.start()
                self.assertFalse(cleared.wait(0.1))
                self.assertTrue(mask_path.exists())
                release.set()
                reader.join(2)
                clearer.join(2)

            self.assertTrue(cleared.is_set())
            self.assertFalse(mask_path.exists())
            self.assertEqual(state.list_candidates(image_id), [])

    def test_list_candidates_prunes_missing_masks_and_advances_revision_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            missing_one = state.cache_dir / image_id / "missing-one.png"
            missing_two = state.cache_dir / image_id / "missing-two.png"
            state.candidates[image_id] = [
                Candidate("missing-one", "penis", 0.9, missing_one),
                Candidate("missing-two", "testicles", 0.8, missing_two),
            ]
            revision_before_prune = state._touch_candidates(image_id)

            self.assertEqual(state.list_candidates(image_id), [])
            self.assertEqual(state.candidates.get(image_id, []), [])
            revision_after_prune = state._candidate_revision(image_id)
            self.assertEqual(revision_after_prune, revision_before_prune + 1)

            self.assertEqual(state.list_candidates(image_id), [])
            self.assertEqual(state._candidate_revision(image_id), revision_after_prune)

    def test_missing_candidate_mask_removes_stale_candidate_and_returns_404(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            missing = state.cache_dir / image_id / "missing.png"
            state.candidates[image_id] = [Candidate("missing", "penis", 0.9, missing)]
            revision_before_read = state._touch_candidates(image_id)
            previous_state = server_module.STATE
            server_module.STATE = state
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            try:
                with patch.object(server_module.LOGGER, "exception") as logged:
                    connection.request("GET", f"/api/mask/{image_id}/missing")
                    response = connection.getresponse()
                    payload = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 404)
                self.assertIn("検出候補", payload["error"])
                logged.assert_not_called()
                revision_after_read = state._candidate_revision(image_id)
                self.assertEqual(revision_after_read, revision_before_read + 1)
                self.assertEqual(state.candidates.get(image_id, []), [])
                self.assertEqual(state.list_candidates(image_id), [])
                self.assertEqual(state._candidate_revision(image_id), revision_after_read)
            finally:
                connection.close()
                httpd.shutdown()
                httpd.server_close()
                server_module.STATE = previous_state

    def test_missing_enabled_mask_aborts_apply_before_any_file_or_candidate_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.png"
            second = root / "second.png"
            Image.new("RGB", (16, 16), "#6688aa").save(first)
            Image.new("RGB", (16, 16), "#aa8866").save(second)
            originals = {path: path.read_bytes() for path in (first, second)}
            state = self.new_state()
            listed = state.set_root(str(root))
            first_id, second_id = (image["id"] for image in listed)
            valid = state.cache_dir / first_id / "valid.png"
            valid.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(valid)
            missing = state.cache_dir / second_id / "missing.png"
            state.candidates[first_id] = [Candidate("valid", "penis", 0.9, valid)]
            state.candidates[second_id] = [Candidate("missing", "penis", 0.9, missing)]

            with self.assertRaisesRegex(ClientError, "自動検出をやり直してください"):
                state.start_apply([first_id, second_id], 100, {})

            self.assertEqual({path: path.read_bytes() for path in (first, second)}, originals)
            self.assertTrue(valid.exists())
            self.assertEqual(len(state.candidates[first_id]), 1)
            self.assertEqual(len(state.candidates[second_id]), 1)

    def test_catalog_reload_is_rejected_while_worker_is_alive_and_stale_worker_cannot_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            record = state.image_for_id(image_id)
            entered = threading.Event()
            release = threading.Event()

            def worker(_records, **kwargs):
                entered.set()
                self.assertTrue(release.wait(2))
                state._finish_job(kwargs["job_generation"], kwargs["catalog_generation"])

            state._start_job("detect", [record], worker)
            self.assertTrue(entered.wait(2))
            with self.assertRaisesRegex(ClientError, "画像一覧を変更できません"):
                state.set_root(str(root))
            release.set()
            self.assertTrue(state.worker_thread is not None)
            state.worker_thread.join(2)
            state.set_root(str(root))

            stale = Candidate("stale", "penis", 0.9, state.cache_dir / image_id / "stale.png")
            stale.mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(stale.mask_path)
            def stale_detection(*_args):
                state.catalog_generation += 1
                return [stale]
            with patch.object(state, "_ensure_models", return_value=[]), patch.object(state, "_detect_image", side_effect=stale_detection):
                state._detect_worker([record], DEFAULT_DETECTION_CONFIDENCE, job_generation=state.job_generation, catalog_generation=state.catalog_generation)
            self.assertFalse(stale.mask_path.exists())
            self.assertEqual(state.candidates.get(image_id, []), [])

    def test_cancelled_worker_blocks_a_new_job_until_it_exits(self):
        state = self.new_state()
        entered = threading.Event()
        release = threading.Event()

        def worker(_records, control, **kwargs):
            entered.set()
            while not control.cancel_requested.is_set():
                time.sleep(0.01)
            self.assertTrue(release.wait(2))
            state._cancel_job(kwargs["job_generation"], kwargs["catalog_generation"])

        record = ImageRecord("test", Path(__file__), "test.png", 1, 1, 0)
        state._start_job("apply", [record], worker)
        self.assertTrue(entered.wait(2))
        state.request_cancel()
        with self.assertRaisesRegex(ClientError, "別の処理が進行中"):
            state._start_job("detect", [record], lambda *_args, **_kwargs: None)
        release.set()
        assert state.worker_thread is not None
        state.worker_thread.join(2)
        state._start_job("detect", [record], lambda *_args, **_kwargs: None)
        assert state.worker_thread is not None
        state.worker_thread.join(2)

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
        self.assertIn('async function startDetectionFromDialog', app)
        self.assertIn('data-i18n="editor.undo"', page)
        self.assertIn('id="detectCurrentButton"', page)
        self.assertNotIn('id="loadFolder"', page)
        self.assertEqual(page.count('max="1.00"'), 3)
        self.assertIn('id="clearCurrentMasksButton"', page)
        self.assertIn('id="mosaicPreviewButton"', page)
        self.assertIn('aria-pressed="true"', page)
        self.assertNotIn('id="fileBrowserDialog"', page)
        self.assertIn('id="pickerMenu"', page)
        self.assertIn('popover', page)
        self.assertIn('id="pickImages"', page)
        self.assertIn('id="pickFolderFiles"', page)
        self.assertNotIn('pickNativeFolder', page)
        self.assertEqual(page.count('id="pickFolder"'), 1)
        self.assertEqual(page.count('type="file"'), 2)
        self.assertIn('id="importImagesInput" type="file" multiple accept=".png,.jpg,.jpeg,.webp" hidden', page)
        self.assertIn('id="importFolderInput" type="file" webkitdirectory multiple accept=".png,.jpg,.jpeg,.webp" hidden', page)
        self.assertNotIn('file-browser-dialog', page)
        self.assertNotIn('file-browser-list', page)
        self.assertNotIn('id="addImagesButton"', page)
        self.assertIn('data-i18n="folder.browse">画像を追加', page)
        self.assertNotIn('id="browseDialog"', page)
        self.assertNotIn('id="fileBrowserDialog"', page)
        self.assertIn('id="jobProgressText"', page)
        self.assertIn('id="clearAllMasksButton"', page)
        self.assertIn('id="clearCatalogButton"', page)
        self.assertIn('id="batchMoreButton"', page)
        self.assertIn('id="batchMoreMenu"', page)
        self.assertIn('id="applyDialog"', page)
        self.assertIn('id="applyOverwriteMode"', page)
        self.assertIn('id="applyTemporarySourceNote"', page)
        self.assertIn('id="detectAllButton"', page)
        self.assertIn('id="detectDialog"', page)
        self.assertIn('id="detectConfidenceRange"', page)
        self.assertIn('id="detectConfidenceNumber"', page)
        self.assertIn('id="detectStartButton"', page)
        self.assertIn('id="saveButton"', page)
        self.assertIn('id="galleryMaskedTab"', page)
        self.assertIn('id="saveAllButton"', page)
        self.assertIn('id="overviewPane"', page)
        self.assertIn('id="overviewGrid"', page)
        self.assertIn('id="navigationShortcutsEnabled" type="checkbox"', page)
        self.assertIn('id="reviewAndNextButton"', page)
        self.assertIn('id="reviewStatus"', page)
        self.assertIn('gallery-review-badge', page)
        self.assertIn('id="previousImageButton"', page)
        self.assertIn('id="nextImageButton"', page)
        self.assertIn('id="divisor"', page)
        self.assertNotIn('id="selectAllButton"', page)
        self.assertNotIn('id="applyButton"', page)
        self.assertIn('id="boundaryTool"', page)
        self.assertIn('path == "/api/boundary"', (root / "server.py").read_text(encoding="utf-8"))
        self.assertIn('drawBoundaryRoi()', app)
        self.assertIn('pointInBoundaryRoi(point)', app)
        self.assertIn('if (state.mosaicPreviewEnabled) paintMosaicPreview();', app)
        self.assertIn('input.value = ""', app)
        self.assertIn('$("#pickerMenu").hidePopover()', app)
        self.assertIn('function pickImageFiles(', app)
        self.assertIn('pickFolderFiles', app)
        self.assertNotIn('pickNativeFolder', app)
        self.assertIn('entry.webkitRelativePath || entry.name', app)
        self.assertIn('async function importSingleFile(entry, clientKey)', app)
        self.assertIn('"/api/import/file"', app)
        self.assertIn('"application/octet-stream"', app)
        self.assertNotIn('entry.file.arrayBuffer()', app)
        self.assertNotIn('bytesToBase64', app)
        self.assertNotIn('function pickNativeSource(', app)
        self.assertNotIn('/api/picker/', app)
        self.assertNotIn('fileBrowserDialog', app)
        self.assertNotIn('/api/browser/list', app)
        self.assertNotIn('/api/catalog/select', app)
        self.assertIn('async function importFiles(files)', app)
        self.assertNotIn('spacePressed', app)
        self.assertIn('const scrollTop = gallery.scrollTop;', app)
        self.assertIn('gallery.scrollTop = scrollTop;', app)
        self.assertIn('document.querySelectorAll("button, input, select, textarea")', app)
        self.assertIn('status.progressCount', app)
        self.assertIn("status.boundaryReady", dictionary)
        self.assertIn("editor.mosaicPreview", dictionary)
        self.assertIn("folder.pickImages", dictionary)
        self.assertIn("folder.pickFolder", dictionary)
        self.assertIn("review.reviewedBadge", dictionary)
        self.assertIn("status.progressCount", dictionary)
        self.assertIn('grid-auto-rows: max-content', styles)
        self.assertIn('object-fit: contain', styles)
        self.assertIn('#applyProgressPanel[hidden] { display: none; }', styles)
        self.assertIn('gallery.detectAll', dictionary)
        self.assertIn('editor.clearMasks', dictionary)
        self.assertIn('confirm.clearCurrent.message', dictionary)
        self.assertIn("通常の参照元画像は削除しません", dictionary["confirm.clearCatalog.message"])
        self.assertIn("焼き込み済みのモザイク画素は復元しません", dictionary["confirm.clearAllMasks.message"])
        self.assertNotIn("画像一覧を閉じる", page)
        self.assertEqual(dictionary["folder.browse"], "画像を追加")
        self.assertNotIn("folder.load", dictionary)
        self.assertNotIn('$("#loadFolder")', app)
        self.assertIn('if (event.key === "Enter") loadFolder()', app)
        self.assertIn("batch.clear", dictionary)
        self.assertNotIn("batch.more", dictionary)
        self.assertIn('async function cancelDetection()', app)
        self.assertIn('"/api/job/cancel"', app)
        self.assertIn('control.cancel_requested.is_set()', (root / "server.py").read_text(encoding="utf-8"))
        self.assertIn('navigation.shortcuts', dictionary)
        self.assertIn('overview.searchPlaceholder', dictionary)
        self.assertIn('getAsFileSystemHandle', app)
        self.assertIn('webkitGetAsEntry', app)
        self.assertIn('event.preventDefault(); if (!state.applyRunning)', app)
        self.assertIn('paintMosaicPreview()', app)
        self.assertIn('saveTargets()', app)
        self.assertIn('lets-censoring.reviewed.v1:', app)
        self.assertIn('state.sourceAccess', app)
        self.assertIn('await api("/api/images")', app)
        self.assertIn("apply.handleSource", dictionary)
        self.assertIn('lets-censoring.navigation-shortcuts.v1', app)
        self.assertIn('function renderOverview(', app)
        self.assertIn('function markImagesUnreviewed(', app)
        self.assertIn('function handleNavigationKeydown(', app)
        self.assertIn('function finishDetectionJob(', app)
        self.assertIn('function renderCatalogViews()', app)
        self.assertIn('async function removeImageFromCatalog(', app)
        self.assertIn('function openCatalogContextMenu(', app)
        self.assertIn('function setGalleryDropOverlay(', app)
        self.assertIn('DELETE" });', app)
        self.assertIn('id="galleryEmptyState"', page)
        self.assertIn('id="galleryDropOverlay"', page)
        self.assertIn('id="catalogContextMenu"', page)
        self.assertIn('id="removeCurrentImageButton"', page)
        self.assertIn('class="batch-actions"', page)
        self.assertIn('gallery-empty-state', styles)
        self.assertIn('.batch-actions {', styles)
        self.assertEqual(dictionary["gallery.saveTargetCount"], "モザイクあり {count}件")
        self.assertEqual(dictionary["gallery.saveAll"], "モザイク画像を一括保存...")
        self.assertEqual(dictionary["batch.clear"], "クリア")
        self.assertNotIn('data-i18n="batch.more"', page)
        self.assertIn('data-i18n="batch.clear"', page)
        self.assertIn('function positionCatalogContextMenu(', app)
        self.assertIn('menu.showPopover?.();\n  positionCatalogContextMenu(menu, event.clientX, event.clientY);', app)
        self.assertIn("confirm.removeImage.message", dictionary)
        self.assertNotIn('Math.sin(Date.now()', app)
        backend = (root / "server.py").read_text(encoding="utf-8")
        self.assertIn('path == "/api/import"', backend)
        self.assertNotIn('path == "/api/picker/images"', backend)
        self.assertNotIn('path == "/api/picker/folder"', backend)
        self.assertNotIn('choose_native_image_files', backend)
        self.assertNotIn('import_file_paths', backend)
        self.assertIn('def safe_import_relative_path(', backend)
        self.assertNotIn('path == "/api/browser/list"', backend)
        self.assertNotIn('path == "/api/catalog/select"', backend)
        self.assertIn('payload.get("divisor")', backend)
        self.assertNotIn('payload.get("blockSize")', backend)
        self.assertIn('iou=0.85', backend)
        self.assertIn('path == "/api/masks/clear"', backend)
        self.assertIn('path == "/api/job/pause"', backend)
        self.assertIn('inset: auto; left: anchor(left); top: anchor(bottom); margin-top: 6px;', styles)
        self.assertIn('body { margin: 0; min-width: 0;', styles)

        referenced_keys = set(re.findall(r'data-i18n(?:-title|-aria-label|-placeholder)?="([^"]+)"', page))
        referenced_keys.update(re.findall(r'\bt\("([^"]+)"', app))
        self.assertEqual(referenced_keys - dictionary.keys(), set())

    def test_api_returns_utf8_japanese_client_error(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = None
        try:
            connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            body = json.dumps({"path": ""}).encode("utf-8")
            connection.request("POST", "/api/folder", body, {
                "Content-Type": "application/json",
                "X-Lets-Censoring-Token": server_module.STATE.session_token,
                "Origin": f"http://127.0.0.1:{httpd.server_port}",
            })
            response = connection.getresponse()
            payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 400)
            self.assertEqual(payload["error"], "Windowsフォルダを入力してください。")
        finally:
            if connection is not None:
                connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_save_render_returns_the_one_time_token_in_a_response_header(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = None
        try:
            record = ImageRecord("image", Path("image.png"), "image.png", 16, 16, 1)
            with patch.object(server_module.STATE, "render_browser_save", return_value=(b"png", record, 3, "one-time-token")):
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                body = json.dumps({"imageId": "image", "candidateRevision": 3, "divisor": 100, "draft": None}).encode("utf-8")
                connection.request("POST", "/api/save/render", body, {
                    "Content-Type": "application/json",
                    "X-Lets-Censoring-Token": server_module.STATE.session_token,
                    "Origin": f"http://127.0.0.1:{httpd.server_port}",
                })
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader("X-Lets-Censoring-Save-Token"), "one-time-token")
                response.read()
        finally:
            if connection is not None:
                connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_save_commit_forwards_the_render_token_to_the_state(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = None
        try:
            with patch.object(server_module.STATE, "commit_browser_save", return_value={"cleared": True}) as commit:
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                body = json.dumps({
                    "imageId": "image",
                    "candidateRevision": 3,
                    "saveToken": "one-time-token",
                    "sourceAction": "keep",
                }).encode("utf-8")
                connection.request("POST", "/api/save/commit", body, {
                    "Content-Type": "application/json",
                    "X-Lets-Censoring-Token": server_module.STATE.session_token,
                    "Origin": f"http://127.0.0.1:{httpd.server_port}",
                })
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
                self.assertEqual(commit.call_args.args, ("image", 3, "one-time-token", "keep"))
        finally:
            if connection is not None:
                connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_api_import_mapping_keeps_client_keys_with_the_new_image_ids(self):
        raw = io.BytesIO()
        Image.new("RGB", (8, 8), "white").save(raw, format="PNG")
        state = self.new_state()

        images, imported = state.import_images_for_api([
            {"clientKey": "first", "name": "first.png", "data": base64.b64encode(raw.getvalue()).decode("ascii")},
            {"clientKey": "second", "name": "second.png", "data": base64.b64encode(raw.getvalue()).decode("ascii")},
        ])

        self.assertEqual(len(images), 2)
        self.assertEqual([entry["clientKey"] for entry in imported], ["first", "second"])
        self.assertEqual({entry["imageId"] for entry in imported}, {image["id"] for image in images})
        with self.assertRaisesRegex(ClientError, "clientKey"):
            state.import_images_for_api([{"name": "missing.png", "data": base64.b64encode(raw.getvalue()).decode("ascii")}])

    def test_import_endpoint_returns_images_and_client_key_mapping(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = None
        try:
            expected_images = [{"id": "image-a"}]
            expected_imported = [{"clientKey": "client-a", "imageId": "image-a"}]
            with patch.object(server_module.STATE, "import_images_for_api", return_value=(expected_images, expected_imported)) as imported:
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                body = json.dumps({"files": [{"clientKey": "client-a"}]}).encode("utf-8")
                connection.request("POST", "/api/import", body, {
                    "Content-Type": "application/json",
                    "X-Lets-Censoring-Token": server_module.STATE.session_token,
                    "Origin": f"http://127.0.0.1:{httpd.server_port}",
                })
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read().decode("utf-8")), {"images": expected_images, "imported": expected_imported})
                imported.assert_called_once_with([{"clientKey": "client-a"}])
        finally:
            if connection is not None:
                connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_detect_endpoint_forwards_validated_parallelism(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = None
        try:
            with patch.object(server_module.STATE, "start_detection") as start:
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                body = json.dumps({"imageIds": ["image-a"], "confidence": 0.65, "parallelism": 3}).encode("utf-8")
                connection.request("POST", "/api/detect", body, {
                    "Content-Type": "application/json",
                    "X-Lets-Censoring-Token": server_module.STATE.session_token,
                    "Origin": f"http://127.0.0.1:{httpd.server_port}",
                })
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
                start.assert_called_once_with(["image-a"], 0.65, 3)
        finally:
            if connection is not None:
                connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_http_responses_prevent_framing_and_content_type_sniffing(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        try:
            connection.request("GET", "/api/health")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Content-Security-Policy"), "frame-ancestors 'none'")
            self.assertEqual(response.getheader("X-Frame-Options"), "DENY")
            self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")
            response.read()
        finally:
            connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_thumbnail_response_is_not_persistently_cached(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            with patch.object(server_module, "STATE", state):
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                try:
                    connection.request("GET", f"/api/thumbnail/{image_id}")
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.getheader("Cache-Control"), "no-store")
                    response.read()
                finally:
                    connection.close()
                    httpd.shutdown()
                    httpd.server_close()

    def test_browser_save_overwrite_updates_state_when_timestamp_restore_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            record = state.image_for_id(image_id)
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)

            with patch("server.os.utime", side_effect=OSError("denied")):
                committed = state.commit_browser_save(image_id, rendered_revision, token, "overwrite")

            self.assertTrue(committed["cleared"])
            self.assertEqual(source.read_bytes(), output)
            self.assertEqual(record.size_bytes, source.stat().st_size)
            self.assertGreater(record.content_version, 0)

    def test_browser_save_session_overwrite_synchronizes_the_session_image(self):
        raw = io.BytesIO()
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("prompt", '{"seed": 9}')
        Image.new("RGB", (16, 16), "white").save(raw, format="PNG", pnginfo=metadata)
        state = self.new_state()
        images, _imported = state.import_images_for_api([
            {"clientKey": "session", "name": "source.png", "data": base64.b64encode(raw.getvalue()).decode("ascii")},
        ])
        image_id = images[0]["id"]
        record = state.image_for_id(image_id)
        mask_path = state.cache_dir / image_id / "candidate.png"
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
        state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
        revision = state._touch_candidates(image_id)

        _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
        rendered_path = state.browser_save_tokens[token].rendered_path
        self.assertTrue(rendered_path.is_file())
        committed = state.commit_browser_save(image_id, rendered_revision, token, "overwrite")

        self.assertTrue(committed["cleared"])
        self.assertFalse(rendered_path.exists())
        self.assertEqual(Image.open(record.path).text["prompt"], '{"seed": 9}')
        self.assertEqual(state.candidates.get(image_id, []), [])
        self.assertGreater(record.content_version, 0)

    def test_browser_save_session_deleted_removes_the_session_record_and_render(self):
        raw = io.BytesIO()
        Image.new("RGB", (16, 16), "white").save(raw, format="PNG")
        state = self.new_state()
        images, _imported = state.import_images_for_api([
            {"clientKey": "session", "name": "source.png", "data": base64.b64encode(raw.getvalue()).decode("ascii")},
        ])
        image_id = images[0]["id"]
        record = state.image_for_id(image_id)
        mask_path = state.cache_dir / image_id / "candidate.png"
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
        state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
        revision = state._touch_candidates(image_id)

        _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
        rendered_path = state.browser_save_tokens[token].rendered_path
        committed = state.commit_browser_save(image_id, rendered_revision, token, "deleted")

        self.assertTrue(committed["deleted"])
        self.assertNotIn(image_id, state.images)
        self.assertFalse(record.path.exists())
        self.assertFalse(rendered_path.exists())

    def test_browser_save_token_render_file_is_removed_when_expired_and_cannot_be_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
            details = state.browser_save_tokens[token]
            state.browser_save_tokens[token] = type(details)(
                details.image_id, details.candidate_revision, details.source_fingerprint,
                details.catalog_generation, time.monotonic() - server_module.SAVE_TOKEN_TTL_SECONDS - 1,
                details.rendered_path,
            )

            with self.assertRaisesRegex(ClientError, "無効または期限切れ"):
                state.commit_browser_save(image_id, rendered_revision, token, "keep")
            self.assertFalse(details.rendered_path.exists())
            with self.assertRaisesRegex(ClientError, "無効または期限切れ"):
                state.commit_browser_save(image_id, rendered_revision, token, "keep")

    def test_browser_save_uses_1_over_100_block_size_and_keeps_png_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            width, height = 832, 1216
            pixels = np.zeros((height, width, 3), dtype=np.uint8)
            pixels[..., 0] = np.arange(width, dtype=np.uint16)[None, :] % 256
            pixels[..., 1] = np.arange(height, dtype=np.uint16)[:, None] % 256
            pixels[..., 2] = (pixels[..., 0].astype(np.uint16) + pixels[..., 1]) % 256
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("prompt", '{"seed": 13}')
            Image.fromarray(pixels, "RGB").save(source, pnginfo=metadata)

            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            record = state.image_for_id(image_id)
            rgba_mask = np.full((height, width, 4), 255, dtype=np.uint8)
            rgba_mask[..., 3] = 0
            rgba_mask[600:616, 400:416, 3] = 255
            draft = {"add": self._png_data_url(Image.fromarray(rgba_mask, "RGBA"))}
            binary_mask = np.zeros((height, width), dtype=np.uint8)
            binary_mask[600:616, 400:416] = 255

            output, _record, revision, token = state.render_browser_save(image_id, 0, 100, draft)
            expected = server_module.render_with_mask(record, binary_mask, 13)

            self.assertEqual(calculate_block_size(width, height, 100), 13)
            self.assertEqual(output, expected)
            self.assertTrue(token)
            with Image.open(io.BytesIO(output)) as rendered:
                rendered_pixels = np.asarray(rendered.convert("RGB"))
                self.assertEqual(rendered.text["prompt"], '{"seed": 13}')
            outside = binary_mask == 0
            self.assertTrue(np.array_equal(rendered_pixels[outside], pixels[outside]))
            self.assertFalse(np.array_equal(rendered_pixels[600:616, 400:416], pixels[600:616, 400:416]))
            state.commit_browser_save(image_id, revision, token, "keep")

    def test_browser_save_renders_then_clears_only_matching_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            info = PngImagePlugin.PngInfo()
            info.add_text("prompt", '{"seed": 1}')
            Image.new("RGB", (16, 16), "white").save(source, pnginfo=info)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            state._touch_candidates(image_id)

            entry = state.prepare_browser_save([image_id], 100, "_censored", False)[0]
            output, record, revision, save_token = state.render_browser_save(image_id, entry["candidateRevision"], 100, None)
            self.assertEqual(record.image_id, image_id)
            self.assertEqual(revision, entry["candidateRevision"])
            self.assertEqual(Image.open(io.BytesIO(output)).text["prompt"], '{"seed": 1}')
            committed = state.commit_browser_save(image_id, revision, save_token, "keep")
            self.assertTrue(committed["cleared"])
            self.assertEqual(state.candidates.get(image_id, []), [])

    def test_browser_save_does_not_clear_candidates_changed_after_render(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            state._touch_candidates(image_id)

            entry = state.prepare_browser_save([image_id], 100, "_censored", False)[0]
            _output, _record, revision, save_token = state.render_browser_save(
                image_id, entry["candidateRevision"], 100, None,
            )
            state._touch_candidates(image_id)

            committed = state.commit_browser_save(image_id, revision, save_token, "keep")
            self.assertFalse(committed["cleared"])
            self.assertEqual(len(state.candidates[image_id]), 1)

    def test_browser_save_commit_is_idempotent_for_matching_token(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)

            _output, _record, rendered_revision, save_token = state.render_browser_save(image_id, revision, 100, None)
            with self.assertRaisesRegex(ClientError, "保存確認トークン"):
                state.commit_browser_save(image_id, rendered_revision, "", "keep")
            with self.assertRaisesRegex(ClientError, "keep、overwrite、deleted"):
                state.commit_browser_save(image_id, rendered_revision, save_token, "invalid")
            with self.assertRaisesRegex(ClientError, "保存対象と一致"):
                state.commit_browser_save(image_id, rendered_revision + 1, save_token, "keep")

            committed = state.commit_browser_save(image_id, rendered_revision, save_token, "keep")
            self.assertTrue(committed["cleared"])
            retried = state.commit_browser_save(image_id, rendered_revision, save_token, "keep")
            self.assertEqual(retried["cleared"], committed["cleared"])
            self.assertEqual(retried["stale"], committed["stale"])
            self.assertEqual(retried["deleted"], committed["deleted"])
            with self.assertRaisesRegex(ClientError, "保存対象と一致"):
                state.commit_browser_save(image_id, rendered_revision, save_token, "overwrite")

    def test_browser_save_token_expires_and_catalog_change_discards_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, expired_token = state.render_browser_save(image_id, revision, 100, None)
            details = state.browser_save_tokens[expired_token]
            state.browser_save_tokens[expired_token] = type(details)(
                details.image_id,
                details.candidate_revision,
                details.source_fingerprint,
                details.catalog_generation,
                time.monotonic() - server_module.SAVE_TOKEN_TTL_SECONDS - 1,
                details.rendered_path,
            )
            with self.assertRaisesRegex(ClientError, "無効または期限切れ"):
                state.commit_browser_save(image_id, rendered_revision, expired_token, "keep")

            _output, _record, rendered_revision, catalog_token = state.render_browser_save(image_id, revision, 100, None)
            state.clear_catalog()
            with self.assertRaisesRegex(ClientError, "無効または期限切れ"):
                state.commit_browser_save(image_id, rendered_revision, catalog_token, "keep")

    def test_shutdown_discards_pending_browser_save_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, _rendered_revision, save_token = state.render_browser_save(image_id, revision, 100, None)

            state.shutdown()
            self.assertNotIn(save_token, state.browser_save_tokens)

    def test_browser_save_stale_deleted_commit_removes_the_working_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)

            _output, _record, rendered_revision, save_token = state.render_browser_save(image_id, revision, 100, None)
            state._touch_candidates(image_id)

            committed = state.commit_browser_save(image_id, rendered_revision, save_token, "deleted")

            self.assertTrue(committed["deleted"])
            self.assertFalse(committed["cleared"])
            self.assertTrue(committed["stale"])
            self.assertFalse(source.exists())
            self.assertNotIn(image_id, state.images)
            self.assertNotIn(image_id, state.order)

    def test_browser_save_stale_overwrite_updates_the_working_copy_and_keeps_candidates(self):
        raw = io.BytesIO()
        Image.new("RGB", (16, 16), "white").save(raw, format="PNG")
        state = self.new_state()
        images, _imported = state.import_images_for_api([
            {"clientKey": "session", "name": "source.png", "data": base64.b64encode(raw.getvalue()).decode("ascii")},
        ])
        image_id = images[0]["id"]
        record = state.image_for_id(image_id)
        mask_path = state.cache_dir / image_id / "candidate.png"
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
        state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
        revision = state._touch_candidates(image_id)

        output, _record, rendered_revision, save_token = state.render_browser_save(image_id, revision, 100, None)
        state._touch_candidates(image_id)
        committed = state.commit_browser_save(image_id, rendered_revision, save_token, "overwrite")

        self.assertFalse(committed["cleared"])
        self.assertTrue(committed["stale"])
        self.assertFalse(committed["deleted"])
        self.assertEqual(record.path.read_bytes(), output)
        self.assertEqual(len(state.candidates[image_id]), 1)
        self.assertGreater(state._candidate_revision(image_id), rendered_revision)

    def test_browser_save_rejects_a_token_when_content_changes_with_same_size_and_mtime(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            pixels = np.zeros((16, 16, 3), dtype=np.uint8)
            pixels[..., 0] = 50
            Image.fromarray(pixels, "RGB").save(source, compress_level=0)
            state = self.new_state()
            image_id = state.set_root(str(source.parent))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, save_token = state.render_browser_save(image_id, revision, 100, None)
            original_stat = source.stat()
            pixels[..., 0] = 200
            Image.fromarray(pixels, "RGB").save(source, compress_level=0)
            self.assertEqual(source.stat().st_size, original_stat.st_size)
            os.utime(source, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))

            with self.assertRaises(ClientError):
                state.commit_browser_save(image_id, rendered_revision, save_token, "keep")
            self.assertNotIn(save_token, state.browser_save_tokens)

    def test_browser_save_rejects_a_token_after_the_source_fingerprint_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, save_token = state.render_browser_save(image_id, revision, 100, None)

            Image.new("RGB", (16, 16), "black").save(source)
            with self.assertRaisesRegex(ClientError, "元画像が.*変更"):
                state.commit_browser_save(image_id, rendered_revision, save_token, "keep")
            self.assertEqual(len(state.candidates[image_id]), 1)
            self.assertNotIn(save_token, state.browser_save_tokens)

    def test_browser_save_keeps_candidates_and_token_when_source_unlink_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, save_token = state.render_browser_save(image_id, revision, 100, None)

            original_unlink = Path.unlink

            def fail_only_for_source(path: Path, *args, **kwargs):
                if path == source:
                    raise PermissionError("locked")
                return original_unlink(path, *args, **kwargs)

            with patch.object(Path, "unlink", fail_only_for_source):
                with self.assertRaisesRegex(ClientError, "候補は保持"):
                    state.commit_browser_save(image_id, rendered_revision, save_token, "deleted")

            self.assertTrue(source.is_file())
            self.assertEqual(len(state.candidates[image_id]), 1)
            self.assertNotIn(save_token, state.browser_save_tokens)
            with self.assertRaisesRegex(ClientError, "無効または期限切れ"):
                state.commit_browser_save(image_id, rendered_revision, save_token, "deleted")
            self.assertTrue(source.exists())

    def test_browser_save_uses_one_candidate_snapshot_when_candidates_change_during_render(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            mask = self._mask(16, 16)
            mask[2:6, 2:6] = 255
            Image.fromarray(mask, mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            render_started = threading.Event()
            allow_render_to_finish = threading.Event()
            observed: dict[str, np.ndarray] = {}
            outcome: dict[str, Any] = {}

            def capture_snapshot(_record, snapshot, _divisor):
                observed["mask"] = snapshot.copy()
                render_started.set()
                self.assertTrue(allow_render_to_finish.wait(2))
                return b"rendered"

            def run_render():
                try:
                    outcome["result"] = state.render_browser_save(image_id, revision, 100, None)
                except Exception as exc:  # pragma: no cover - asserted below
                    outcome["error"] = exc

            with patch.object(server_module, "render_with_mask", side_effect=capture_snapshot):
                thread = threading.Thread(target=run_render)
                thread.start()
                self.assertTrue(render_started.wait(2))
                state.set_candidate_state(image_id, "candidate", {"enabled": False})
                allow_render_to_finish.set()
                thread.join(2)

            self.assertFalse(thread.is_alive())
            self.assertNotIn("error", outcome)
            self.assertTrue(np.any(observed["mask"]))
            _output, _record, rendered_revision, save_token = outcome["result"]
            self.assertEqual(rendered_revision, revision)
            committed = state.commit_browser_save(image_id, rendered_revision, save_token, "deleted")
            self.assertTrue(committed["deleted"])
            self.assertTrue(committed["stale"])
            self.assertFalse(source.exists())

    def test_browser_save_prunes_missing_candidates_and_advances_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            mask_path.unlink()

            with self.assertRaisesRegex(ClientError, "候補が変更"):
                state.render_browser_save(image_id, revision, 100, None)
            self.assertEqual(state.candidates[image_id], [])
            self.assertGreater(state._candidate_revision(image_id), revision)

    def test_browser_save_rejects_duplicate_image_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]

            with self.assertRaises(ClientError):
                state.prepare_browser_save([image_id, image_id], 100, "_censored", False)

    def test_browser_save_rejects_changed_source_and_preserves_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            Image.new("RGB", (16, 16), "black").save(source)
            with self.assertRaises(ClientError):
                state.prepare_browser_save([image_id], 100, "_censored", False)
            self.assertEqual(len(state.candidates[image_id]), 1)

    def test_exif_rotated_jpeg_uses_normalized_mask_coordinates(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "rotated.jpg"
            exif = Image.Exif()
            exif[274] = 6
            Image.new("RGB", (40, 20), "white").save(source, exif=exif)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            record = state.image_for_id(image_id)
            self.assertEqual((record.width, record.height), (20, 40))
            mask = np.zeros((40, 20), dtype=np.uint8)
            mask[4:12, 4:12] = 255
            output = server_module.render_with_mask(record, mask, 4)
            with Image.open(io.BytesIO(output)) as saved:
                self.assertEqual(saved.getexif().get(274), 1)
                self.assertEqual(ImageOps.exif_transpose(saved).size, (20, 40))

    def test_browser_save_receipt_retries_without_repeating_file_work(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16), mode="L").save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
            with patch.object(state, "_clear_masks_unchecked", wraps=state._clear_masks_unchecked) as clear_masks:
                first = state.commit_browser_save(image_id, rendered_revision, token, "keep")
                retried = state.commit_browser_save(image_id, rendered_revision, token, "keep")
            self.assertEqual(clear_masks.call_count, 1)
            self.assertEqual(retried["cleared"], first["cleared"])
            self.assertIn(token, state.browser_save_receipts)
            state.clear_catalog()
            self.assertIn(token, state.browser_save_receipts)
            self.assertEqual(state.commit_browser_save(image_id, rendered_revision, token, "keep")["images"], [])
            with self.assertRaises(ClientError):
                state.commit_browser_save(image_id, rendered_revision, token, "overwrite")

    def test_binary_import_uses_raw_bytes_and_preserves_client_mapping(self):
        with tempfile.TemporaryDirectory() as directory:
            source = io.BytesIO()
            Image.new("RGB", (12, 8), "white").save(source, format="PNG")
            state = self.new_state()
            images, imported = state.import_image_bytes_for_api(
                source.getvalue(),
                name="first.png",
                relative_path="nested/first.png",
                client_key="client-1",
            )
            self.assertEqual(imported, [{"clientKey": "client-1", "imageId": images[0]["id"]}])
            self.assertEqual(images[0]["relativePath"], "nested/first.png")
            self.assertEqual(state.image_for_id(images[0]["id"]).source_kind, "session")

if __name__ == "__main__":
    unittest.main()
