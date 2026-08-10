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
from PIL import Image, PngImagePlugin

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server as server_module  # noqa: E402
from server import (  # noqa: E402
    Candidate,
    CACHE_DIR,
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
    refine_mask_with_hand,
    _read_mosaic_divisor,
    save_with_mask,
    select_best_sam_mask,
    validate_model_manifest,
    webp_metadata_manifest,
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
              patch.object(server_module.STATE, "cache_dir", self.cache_dir), \
              patch.object(sys, "argv", ["server.py", "--port", "9876"]):
            with self.assertLogs(server_module.LOGGER, "ERROR") as logs:
                with self.assertRaises(SystemExit) as raised:
                    server_module.main()
        self.assertEqual(raised.exception.code, 1)
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

    def test_file_browser_lists_direct_children_and_selected_images_stay_in_one_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "child").mkdir()
            Image.new("RGB", (8, 8), "white").save(root / "one.png")
            Image.new("RGB", (8, 8), "white").save(root / "two.webp")
            (root / "ignored.txt").write_text("not an image", encoding="utf-8")
            outside = root.parent / "outside.png"
            Image.new("RGB", (8, 8), "white").save(outside)
            state = self.new_state()

            listing = state.browse_folder(str(root))

            self.assertEqual(listing["path"], str(root.resolve()))
            self.assertEqual([entry["name"] for entry in listing["directories"]], ["child"])
            self.assertEqual([entry["name"] for entry in listing["images"]], ["one.png", "two.webp"])
            images = state.set_selected_images(str(root), ["two.webp", "one.png"])
            self.assertEqual([image["relativePath"] for image in images], ["one.png", "two.webp"])
            self.assertEqual(state.root, root.resolve())
            with self.assertRaisesRegex(ClientError, "選択できない画像"):
                state.set_selected_images(str(root), ["../outside.png"])
            outside.unlink(missing_ok=True)

    def test_file_browser_rejects_missing_folder_and_non_image_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "note.txt").write_text("note", encoding="utf-8")
            state = self.new_state()
            with self.assertRaisesRegex(ClientError, "指定フォルダが見つかりません"):
                state.browse_folder(str(root / "missing"))
            with self.assertRaisesRegex(ClientError, "選択できない画像"):
                state.set_selected_images(str(root), ["note.txt"])

    def test_file_browser_api_lists_and_catalogues_selected_direct_images(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (8, 8), "white").save(root / "one.png")
            Image.new("RGB", (8, 8), "white").save(root / "two.jpg")
            state = self.new_state()
            with patch("server.STATE", state):
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                try:
                    body = json.dumps({"path": str(root)}).encode("utf-8")
                    connection.request("POST", "/api/browser/list", body, {"Content-Type": "application/json"})
                    response = connection.getresponse()
                    listing = json.loads(response.read().decode("utf-8"))
                    self.assertEqual(response.status, 200)
                    self.assertEqual([entry["name"] for entry in listing["images"]], ["one.png", "two.jpg"])

                    body = json.dumps({"path": str(root), "names": ["two.jpg"]}).encode("utf-8")
                    connection.request("POST", "/api/catalog/select", body, {"Content-Type": "application/json"})
                    response = connection.getresponse()
                    selected = json.loads(response.read().decode("utf-8"))
                    self.assertEqual(response.status, 200)
                    self.assertEqual([image["relativePath"] for image in selected["images"]], ["two.jpg"])
                finally:
                    connection.close()
                    httpd.shutdown()
                    httpd.server_close()

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

    def test_copy_save_preserves_png_metadata_and_leaves_source_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.image.png"
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("workflow", '{"nodes":[]}')
            Image.new("RGB", (16, 16), "#6688aa").save(source, pnginfo=metadata)
            original = source.read_bytes()
            source_mtime_ns = source.stat().st_mtime_ns
            destination = Path(directory) / "source.image_censored.png"
            save_with_mask(self._record(source, 16, 16), self._mask(16, 16), 4, destination)
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(png_ancillary_manifest(original), png_ancillary_manifest(destination.read_bytes()))
            self.assertEqual(destination.stat().st_mtime_ns, source_mtime_ns)

    def test_copy_apply_adds_a_suffix_before_the_extension_and_resolves_collisions(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.image.png"
            Image.new("RGB", (16, 16), "#6688aa").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            record = state.image_for_id(image_id)
            state.job = server_module.Job(kind="apply", state="running", total=1, image_ids=(image_id,))
            state._apply_worker([record], 100, "copy", "_censored", False, {image_id: self._mask(16, 16)})
            self.assertEqual(state.job.completed_image_ids, (image_id,))
            state.job = server_module.Job(kind="apply", state="running", total=1, image_ids=(image_id,))
            state._apply_worker([record], 100, "copy", "_censored", False, {image_id: self._mask(16, 16)})
            names = [image["relativePath"] for image in state.list_images()]
            self.assertEqual(state.job.state, "complete")
            self.assertEqual(names, ["source.image.png", "source.image_censored.png", "source.image_censored_2.png"])
            self.assertEqual((Path(directory) / "source.image_censored.png").stat().st_mtime_ns, source.stat().st_mtime_ns)

    def test_overwrite_ignores_suffix_and_copy_rejects_invalid_suffix(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "#6688aa").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            with patch.object(state, "combined_candidate_mask", return_value=self._mask(16, 16)), patch.object(state, "_start_job") as start_job:
                state.start_apply([image_id], 100, "overwrite", "../ignored", False, {})
            self.assertEqual(start_job.call_args.args[5], "")
            with self.assertRaisesRegex(ClientError, "ファイル名の末尾"), patch.object(state, "combined_candidate_mask", return_value=self._mask(16, 16)):
                state.start_apply([image_id], 100, "copy", "../invalid", False, {})

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
                state._apply_worker(records, 100, "overwrite", "", False, masks, control=control)
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
                state._apply_worker(records, 100, "overwrite", "", False, masks)
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
        self.assertAlmostEqual(confidence_for_source("primary", 0.60), 0.45)
        self.assertEqual(confidence_for_source("secondary", 0.10), 0.50)
        self.assertEqual(confidence_for_source("secondary", 0.85), 0.85)
        self.assertEqual(confidence_for_class("primary", "penis", 0.60), 0.60)
        self.assertEqual(confidence_for_class("secondary", "penis", 0.10), 0.50)
        with self.assertRaises(ClientError):
            read_detection_confidence(0.09)
        with self.assertRaises(ClientError):
            read_detection_confidence(0.91)

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

    def test_hand_refinement_preserves_core_and_removes_valid_fringe_only(self):
        genital = np.zeros((30, 30), dtype=np.uint8)
        genital[5:25, 5:25] = 255
        hand = np.zeros_like(genital)
        hand[5:8, 5:25] = 255
        refined, decision = refine_mask_with_hand(genital, hand)
        distance = cv2.distanceTransform((genital > 0).astype(np.uint8), cv2.DIST_L2, 3)
        core = distance >= max(1.0, min(float(distance.max()), math.sqrt(400) * 0.12))
        self.assertEqual(decision, "refined")
        self.assertTrue(np.all(refined[core] == 255))
        self.assertLess(np.count_nonzero(refined), np.count_nonzero(genital))

    def test_hand_refinement_skips_over_cap(self):
        genital = np.zeros((30, 30), dtype=np.uint8)
        genital[5:25, 5:25] = 255
        large_hand = np.zeros_like(genital)
        large_hand[5:25, 5:25] = 255
        unchanged, decision = refine_mask_with_hand(genital, large_hand)
        self.assertEqual(decision, "over_cap")
        self.assertTrue(np.array_equal(unchanged, genital))

    def test_hand_sam_mask_rejects_low_quality_invalid_shape_and_empty_masks(self):
        mask = np.ones((8, 8), dtype=bool)
        self.assertIsNone(accepted_hand_sam_mask(np.array([mask]), np.array([0.87]), (8, 8)))
        self.assertIsNone(accepted_hand_sam_mask(np.array([mask]), np.array([0.95]), (9, 9)))
        self.assertIsNone(accepted_hand_sam_mask(np.zeros((1, 8, 8), dtype=bool), np.array([0.95]), (8, 8)))
        accepted = accepted_hand_sam_mask(np.array([mask]), np.array([0.88]), (8, 8))
        self.assertIsNotNone(accepted)
        self.assertTrue(np.all(accepted == 255))

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

    def test_precise_segments_never_enter_hand_refinement(self):
        state = self.new_state()
        precise_mask = np.zeros((16, 16), dtype=np.uint8)
        precise_mask[4:12, 4:12] = 255
        record = ImageRecord("image", Path(__file__), "image.png", 16, 16, 0)
        with patch.object(state, "_hand_boxes") as hand_boxes:
            result = state._refine_fallback_segments(
                Mock(), record, Image.new("RGB", (16, 16), "white"),
                [{"class_name": "penis", "confidence": 0.8, "mask": precise_mask, "source": "precise"}],
            )
        hand_boxes.assert_not_called()
        self.assertTrue(np.array_equal(result[0]["mask"], precise_mask))

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

    def test_yolo_detection_uses_the_shared_inference_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"
            Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            state = self.new_state()
            state.root = Path(directory)
            state.images = {record.image_id: record}
            state.order = [record.image_id]

            def detect_image(*_args):
                self.assertTrue(state.inference_lock.locked())
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
                connection.request("POST", "/api/boundary", body, {"Content-Type": "application/json"})
                response = connection.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(payload, {"candidate": expected})
            self.assertEqual(add_candidate.call_args.args[0], "image")
        finally:
            connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_start_detection_propagates_ui_confidence(self):
        state = self.new_state()
        record = ImageRecord("test", Path(__file__), "test.png", 1, 1, 0)
        with patch.object(state, "_records_for_ids_with_catalog", return_value=([record], 7)), patch.object(state, "_start_job") as start:
            state.start_detection(["test"], 0.65)
        self.assertEqual(start.call_args.args[0], "detect")
        self.assertEqual(start.call_args.args[-1], 0.65)
        self.assertEqual(start.call_args.kwargs["expected_catalog_generation"], 7)
        with patch.object(state, "_records_for_ids_with_catalog", return_value=([record], 8)), patch.object(state, "_start_job") as start:
            state.start_detection(["test"])
        self.assertEqual(start.call_args.args[-1], DEFAULT_DETECTION_CONFIDENCE)
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
                    state.start_apply([first_id], 100, "copy", "_censored", True, {})

            self.assertEqual(source.read_bytes(), original_source)
            self.assertFalse((first_root / "first_censored.png").exists())
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

    def test_session_apply_keeps_output_when_the_session_is_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "images"
            root.mkdir()
            raw_buffer = io.BytesIO()
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("workflow", "preserved")
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG", pnginfo=metadata)
            state = self.new_state()
            state.set_root(str(root))
            imported = state.import_images([{"name": "dropped.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii")}])[0]
            record = state.image_for_id(imported["id"])
            session_path = record.path

            state._apply_worker([record], 100, "overwrite", "_censored", False, {record.image_id: self._mask(16, 16)})

            output = root / "dropped_censored.png"
            self.assertTrue(output.is_file())
            self.assertTrue(session_path.is_file())
            self.assertEqual(Image.open(output).text["workflow"], "preserved")
            state.set_root(str(root))
            self.assertTrue(output.is_file())
            self.assertFalse(session_path.exists())

    def test_direct_session_save_creates_a_root_copy_without_replacing_the_temp_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "images"
            root.mkdir()
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            state = self.new_state()
            state.set_root(str(root))
            session_id = state.import_images([{"name": "dropped.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii")}])[0]["id"]
            source = state.image_for_id(session_id)

            output = state.save_image(session_id, self._mask(16, 16), 100)

            self.assertEqual(output, root / "dropped_censored.png")
            self.assertTrue(output.is_file())
            self.assertTrue(source.path.is_file())
            self.assertEqual(source.source_kind, "session")
            self.assertTrue(any(image["relativePath"] == "dropped_censored.png" for image in state.list_images()))

    def test_mixed_apply_copies_every_source_when_a_session_image_is_present(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "images"
            root.mkdir()
            filesystem_path = root / "normal.png"
            filesystem_image = Image.new("RGB", (16, 16), "#ffffff")
            filesystem_image.putpixel((5, 5), (0, 0, 0))
            filesystem_image.save(filesystem_path)
            original_filesystem_bytes = filesystem_path.read_bytes()
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            state = self.new_state()
            filesystem_id = state.set_root(str(root))[0]["id"]
            session_id = next(
                image["id"] for image in state.import_images([{"name": "dropped.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii")}])
                if image["sourceKind"] == "session"
            )
            filesystem_record = state.image_for_id(filesystem_id)
            session_record = state.image_for_id(session_id)

            state._apply_worker(
                [filesystem_record, session_record], 100, "overwrite", "_censored", False,
                {filesystem_id: self._mask(16, 16), session_id: self._mask(16, 16)},
            )

            self.assertEqual(filesystem_path.read_bytes(), original_filesystem_bytes)
            self.assertTrue((root / "normal_censored.png").is_file())
            self.assertTrue((root / "dropped_censored.png").is_file())
            self.assertTrue(session_record.path.is_file())
            self.assertEqual(session_record.source_kind, "session")

    def test_start_apply_forces_copy_and_disables_delete_for_a_mixed_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "images"
            root.mkdir()
            Image.new("RGB", (16, 16), "#ffffff").save(root / "normal.png")
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            state = self.new_state()
            filesystem_id = state.set_root(str(root))[0]["id"]
            session_id = next(
                image["id"] for image in state.import_images([{"name": "dropped.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii")}])
                if image["sourceKind"] == "session"
            )
            with patch.object(state, "combined_candidate_mask", return_value=self._mask(16, 16)), \
                 patch.object(state, "_start_job") as start_job:
                state.start_apply([filesystem_id, session_id], 100, "overwrite", "_censored", True, {})

            self.assertEqual(start_job.call_args.args[4], "copy")
            self.assertEqual(start_job.call_args.args[5], "_censored")
            self.assertFalse(start_job.call_args.args[6])

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

            with patch.object(server_module, "CACHE_DIR", simulated_production_cache):
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

    def test_list_candidates_prunes_all_missing_masks_before_returning(self):
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

            self.assertEqual(state.list_candidates(image_id), [])
            self.assertEqual(state.candidates[image_id], [])

    def test_missing_candidate_mask_removes_stale_candidate_and_returns_404(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            missing = state.cache_dir / image_id / "missing.png"
            state.candidates[image_id] = [Candidate("missing", "penis", 0.9, missing)]
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
                self.assertEqual(state.list_candidates(image_id), [])
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
                state.start_apply([first_id, second_id], 100, "copy", "_censored", True, {})

            self.assertEqual({path: path.read_bytes() for path in (first, second)}, originals)
            self.assertTrue(valid.exists())
            self.assertEqual(len(state.candidates[first_id]), 1)
            self.assertEqual(len(state.candidates[second_id]), 1)
            self.assertFalse((root / "first_censored.png").exists())
            self.assertFalse((root / "second_censored.png").exists())

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
        self.assertIn('confidence: detectionConfidence()', app)
        self.assertIn('data-i18n="editor.undo"', page)
        self.assertIn('id="detectCurrentButton"', page)
        self.assertIn('id="clearCurrentMasksButton"', page)
        self.assertIn('id="mosaicPreviewButton"', page)
        self.assertIn('aria-pressed="true"', page)
        self.assertIn('id="fileBrowserDialog"', page)
        self.assertEqual(page.count('id="pickFolder"'), 1)
        self.assertIn('id="fileBrowserList"', page)
        self.assertIn('id="fileBrowserLoadButton"', page)
        self.assertNotIn('id="addImagesButton"', page)
        self.assertNotIn('画像を追加', page)
        self.assertNotIn('id="browseDialog"', page)
        self.assertNotIn('id="importFilesInput"', page)
        self.assertIn('id="jobProgressText"', page)
        self.assertIn('id="clearAllMasksButton"', page)
        self.assertIn('id="clearCatalogButton"', page)
        self.assertIn('id="applyDialog"', page)
        self.assertIn('id="applyOverwriteMode"', page)
        self.assertIn('id="applyTemporarySourceNote"', page)
        self.assertIn('id="detectAllButton"', page)
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
        self.assertIn('async function openFileBrowser()', app)
        self.assertIn('async function loadFromFileBrowser()', app)
        self.assertIn('/api/browser/list', app)
        self.assertIn('/api/catalog/select', app)
        self.assertIn('async function importFiles(files)', app)
        self.assertNotIn('spacePressed', app)
        self.assertIn('const scrollTop = gallery.scrollTop;', app)
        self.assertIn('gallery.scrollTop = scrollTop;', app)
        self.assertIn('document.querySelectorAll("button, input, select, textarea")', app)
        self.assertIn('status.progressCount', app)
        self.assertIn("status.boundaryReady", dictionary)
        self.assertIn("editor.mosaicPreview", dictionary)
        self.assertIn("folder.loadSelected", dictionary)
        self.assertIn("review.reviewedBadge", dictionary)
        self.assertIn("status.progressCount", dictionary)
        self.assertIn('grid-auto-rows: max-content', styles)
        self.assertIn('object-fit: contain', styles)
        self.assertIn('#applyProgressPanel[hidden] { display: none; }', styles)
        self.assertIn('gallery.detectAll', dictionary)
        self.assertIn('editor.clearMasks', dictionary)
        self.assertIn('confirm.clearCurrent.message', dictionary)
        self.assertEqual(
            dictionary["confirm.clearCatalog.message"],
            "通常の参照画像は削除しません。ドラッグ追加画像の一時コピーは削除します。",
        )
        self.assertIn('navigation.shortcuts', dictionary)
        self.assertIn('overview.searchPlaceholder', dictionary)
        self.assertIn('getAsFileSystemHandle', app)
        self.assertIn('webkitGetAsEntry', app)
        self.assertIn('event.preventDefault(); if (!state.applyRunning)', app)
        self.assertIn('paintMosaicPreview()', app)
        self.assertIn('saveTargets()', app)
        self.assertIn('lets-censoring.reviewed.v1:', app)
        self.assertIn('applyTargetsContainSessionImage()', app)
        self.assertIn('await api("/api/images")', app)
        self.assertIn("apply.tempSource", dictionary)
        self.assertIn('lets-censoring.navigation-shortcuts.v1', app)
        self.assertIn('function renderOverview(', app)
        self.assertIn('function markImagesUnreviewed(', app)
        self.assertIn('function handleNavigationKeydown(', app)
        self.assertIn('function finishDetectionJob(', app)
        self.assertIn('function renderCatalogViews()', app)
        self.assertNotIn('Math.sin(Date.now()', app)
        backend = (root / "server.py").read_text(encoding="utf-8")
        self.assertIn('path == "/api/import"', backend)
        self.assertIn('path == "/api/browser/list"', backend)
        self.assertIn('path == "/api/catalog/select"', backend)
        self.assertIn('payload.get("divisor")', backend)
        self.assertNotIn('payload.get("blockSize")', backend)
        self.assertIn('iou=0.85', backend)
        self.assertIn('path == "/api/masks/clear"', backend)
        self.assertIn('path == "/api/job/pause"', backend)

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
