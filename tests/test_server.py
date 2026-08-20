import http.client
import base64
import copy
import hashlib
import io
import json
import logging
import math
import os
import re
import subprocess
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import numpy as np
import cv2
from PIL import Image, ImageOps, PngImagePlugin

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server as server_module  # noqa: E402
import mozarie.http as http_module  # noqa: E402
import mozarie.image_io as image_io_module  # noqa: E402
import mozarie.state as state_module  # noqa: E402
import mozarie.catalog as catalog_module  # noqa: E402
import mozarie.detection as detection_module  # noqa: E402
import mozarie.jobs as jobs_module  # noqa: E402
import mozarie.saving as saving_module  # noqa: E402
from server import (  # noqa: E402
    Candidate,
    ClientError,
    DEFAULT_DETECTION_CONFIDENCE,
    DetectionModels,
    ImageRecord,
    JOB_LABELS,
    MosaicHandler,
    StudioState,
    TARGET_CLASSES,
    accepted_hand_sam_mask,
    arbitrate_segment_sources,
    assert_onnx_cuda_available,
    calculate_block_size,
    clip_mask_to_roi,
    confidence_for_source,
    detection_tiles,
    jpeg_metadata_manifest,
    mask_iou,
    merge_segment,
    png_ancillary_manifest,
    restore_tile_mask,
    read_boundary_request,
    read_detection_confidence,
    padded_hand_box,
    refine_mask_with_hand,
    _read_mosaic_divisor,
    save_with_mask,
    select_best_sam_mask,
    webp_metadata_manifest,
    white_fluid_mask,
    LOG_DATE_FORMAT,
    LOG_FORMAT,
    _open_browser,
    _schedule_browser_open,
)

SYNTHETIC_DIGEST = hashlib.sha256(b"mozarie-test-record").hexdigest()


class MozarieTests(unittest.TestCase):
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
        return ImageRecord(
            image_id="test", path=path, relative_path=path.name, width=width, height=height,
            mtime_ns=path.stat().st_mtime_ns, size_bytes=path.stat().st_size,
            content_digest=hashlib.sha256(path.read_bytes()).hexdigest(),
        )

    @staticmethod
    def _mask(width: int, height: int) -> np.ndarray:
        mask = np.zeros((height, width), dtype=np.uint8)
        mask[4:12, 4:12] = 255
        return mask

    @staticmethod
    def _write_same_size_png_pair(path: Path) -> bytes:
        source = np.full((16, 16, 3), 255, dtype=np.uint8)
        replacement = np.zeros((16, 16, 3), dtype=np.uint8)
        replacement[..., 2] = 255
        encoded: list[bytes] = []
        for pixels in (source, replacement):
            output = io.BytesIO()
            Image.fromarray(pixels).save(output, format="PNG", compress_level=0)
            encoded.append(output.getvalue())
        assert len(encoded[0]) == len(encoded[1])
        path.write_bytes(encoded[0])
        return encoded[1]

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

        decoded = server_module._decode_mask(self._png_data_url(Image.fromarray(rgba)), 8, 8)

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
            Image.fromarray(rgba), np.full((2, 2), 255, dtype=np.uint8), 2,
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

    def test_main_uses_saved_port_and_respects_open_browser_setting(self):
        fake_server = Mock(); fake_server.serve_forever.side_effect = KeyboardInterrupt
        original_settings = server_module.STATE.settings
        server_module.STATE.settings = {**original_settings, "general": {**original_settings["general"], "port": 9123, "open_browser": False}}
        try:
            with patch("server.ThreadingHTTPServer", return_value=fake_server) as server_class, \
                   patch("server._schedule_browser_open") as schedule_browser, \
                   patch.object(server_module.STATE, "shutdown"), \
                   patch.object(server_module.STATE, "cache_dir", self.cache_dir), \
                   patch.object(sys, "argv", ["server.py"]):
                server_module.main()
            server_class.assert_called_once_with(("127.0.0.1", 9123), MosaicHandler)
            schedule_browser.assert_not_called()
        finally:
            server_module.STATE.settings = original_settings

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
        record = ImageRecord(image_id="test", path=Path(__file__), relative_path="test.png", width=1, height=1, mtime_ns=0, content_digest=SYNTHETIC_DIGEST)
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
            with self.assertLogs(jobs_module.LOGGER, "ERROR") as logs:
                state._fail_job(exc)
        self.assertIn("バックグラウンド処理に失敗", "\n".join(logs.output))

    def test_main_logs_bind_failure_and_exits(self):
        with patch("server.logging.basicConfig"), \
              patch("server.ThreadingHTTPServer", side_effect=OSError("port in use")), \
              patch.object(server_module.STATE, "shutdown") as shutdown, \
              patch.object(server_module.STATE, "cache_dir", self.cache_dir), \
              patch.object(sys, "argv", ["server.py", "--port", "9876"]):
            with self.assertLogs(jobs_module.LOGGER, "ERROR") as logs:
                with self.assertRaises(SystemExit) as raised:
                    server_module.main()
        self.assertEqual(raised.exception.code, 1)
        shutdown.assert_called_once_with()
        self.assertIn("サーバーを起動できません", "\n".join(logs.output))

    def test_server_imports_from_an_isolated_unrelated_working_directory(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            command = (
                "import os, runpy; "
                f"os.chdir({directory!r}); "
                f"runpy.run_path({str(root / 'server.py')!r}, run_name='mozarie_startup_probe')"
            )
            environment = os.environ.copy()
            environment.pop("PYTHONPATH", None)
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-c", command],
                cwd=directory,
                env=environment,
                capture_output=True,
                text=True,
                timeout=30,
            )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_png_ancillary_metadata_is_byte_identical_after_save(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            pixels = np.zeros((16, 16, 3), dtype=np.uint8)
            pixels[:, :, 0] = np.arange(16, dtype=np.uint8)[None, :] * 15
            pixels[:, :, 1] = np.arange(16, dtype=np.uint8)[:, None] * 15
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("prompt", '{"seed": 123}')
            metadata.add_itxt("workflow", '{"nodes": []}', lang="ja", tkey="workflow")
            Image.fromarray(pixels).save(path, format="PNG", pnginfo=metadata)
            original = path.read_bytes()
            original_manifest = png_ancillary_manifest(original)
            original_mtime_ns = path.stat().st_mtime_ns

            record = ImageRecord(image_id="test", path=path, relative_path="source.png", width=16, height=16, mtime_ns=original_mtime_ns, content_digest=hashlib.sha256(path.read_bytes()).hexdigest())
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
            exif[0x010E] = "Mozarie test"
            Image.new("RGB", (16, 16), "#6688aa").save(
                path,
                format="JPEG",
                exif=exif.tobytes(),
                icc_profile=b"Mozarie ICC profile",
            )
            original = path.read_bytes()
            xmp = b"http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta>Mozarie</x:xmpmeta>"
            original = b"\xff\xd8" + self._jpeg_segment(0xE1, xmp) + self._jpeg_segment(0xFE, b"Mozarie comment") + original[2:]
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
            exif[0x010E] = "Mozarie test"
            Image.new("RGB", (16, 16), "#6688aa").save(
                path,
                format="WEBP",
                exif=exif.tobytes(),
                icc_profile=b"Mozarie ICC profile",
                xmp=b"<x:xmpmeta>Mozarie</x:xmpmeta>",
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
            record = self._record(path, 20, 40)
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
            record = self._record(path, 20, 40)
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
            with patch("mozarie.image_io.jpeg_metadata_manifest", side_effect=[[], ["mismatch"]]):
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
            self.assertFalse((root / ".mozarie_imports").exists())

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
            Image.fromarray(self._mask(16, 16)).save(mask_path)
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
            Image.fromarray(self._mask(16, 16)).save(mask_path)
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
            Image.fromarray(self._mask(16, 16)).save(mask_path)
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
            image_id = state.order[0]
            state.image_io_lock(image_id)

            state.clear_catalog()

            self.assertEqual(state.list_images(), [])
            self.assertEqual(state._image_io_locks, {})
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
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            state._touch_candidates(image_id)

            self.assertEqual(state.remove_image_from_catalog(image_id), [])

            self.assertEqual(path.read_bytes(), original)
            self.assertNotIn(image_id, state.images)
            self.assertNotIn(image_id, state.order)
            self.assertNotIn(image_id, state.candidates)
            self.assertNotIn(image_id, state.candidate_revisions)
            self.assertFalse((state.cache_dir / image_id).exists())

    def test_remove_saved_images_from_catalog_keeps_all_source_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.png"
            second = root / "second.png"
            Image.new("RGB", (16, 16), "white").save(first)
            Image.new("RGB", (16, 16), "black").save(second)
            originals = {first: first.read_bytes(), second: second.read_bytes()}
            state = self.new_state()
            images = state.set_root(directory)
            first_id, second_id = (image["id"] for image in images)

            result = state.remove_images_from_catalog([first_id, second_id, first_id])

            self.assertEqual(result["images"], [])
            self.assertEqual(result["removedImageIds"], [first_id, second_id])
            self.assertEqual(state.list_images(), [])
            self.assertEqual({path: path.read_bytes() for path in originals}, originals)

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
        Image.fromarray(self._mask(16, 16)).save(mask_path)
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
        self.assertFalse(record.path.parent.exists())

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
        self.assertEqual(state.job.state, "paused")
        state.resume_job()
        self.assertEqual(state.job.state, "running")
        self.assertFalse(state.job_control.pause_requested.is_set())

        state.request_cancel()
        self.assertTrue(state.job_control.cancel_requested.is_set())
        self.assertFalse(state.job_control.pause_requested.is_set())

        state.job.state = "paused"
        state.request_cancel()
        self.assertEqual(state.job.state, "cancelled")

    def test_cancel_before_claim_never_starts_another_record(self):
        state = self.new_state()
        control = server_module.JobControl()
        state.job = server_module.Job(kind="detect", state="running", total=1)
        state.job_control = control
        processed = []

        state.request_cancel()
        state._run_fixed_workers(
            [ImageRecord(image_id="record", path=Path(__file__), relative_path="record.png", width=1, height=1, mtime_ns=0, content_digest=SYNTHETIC_DIGEST)], 1,
            lambda _index, record: processed.append(record.image_id), control, None, None,
        )

        self.assertEqual(processed, [])

    def test_detection_can_pause_and_resume(self):
        state = self.new_state()
        state.job = server_module.Job(kind="detect", state="running", total=2)
        state.job_control = server_module.JobControl()

        state.request_pause()
        self.assertTrue(state.job_control.pause_requested.is_set())
        self.assertEqual(state.job.state, "paused")
        state.resume_job()

        self.assertEqual(state.job.state, "running")
        self.assertFalse(state.job_control.pause_requested.is_set())

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

            def detect_image(_models, record, _confidence, _mode="standard", _targets=None):
                mask_path = state.cache_dir / record.image_id / "candidate.png"
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(self._mask(16, 16)).save(mask_path)
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
            Image.fromarray(self._mask(16, 16)).save(old_mask_path)
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
                Image.fromarray(self._mask(16, 16)).save(new_mask_path)
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

    def test_same_stat_change_during_detection_does_not_publish_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            replacement = self._write_same_size_png_pair(source)
            original_stat = source.stat()
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            record = state.image_for_id(image_id)
            state.job = server_module.Job(kind="detect", state="running", total=1, image_ids=(image_id,))
            old_path = state.cache_dir / image_id / "old.png"
            old_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(old_path)
            old_candidate = Candidate("old", "boundary", 0.9, old_path, origin="boundary")
            state.candidates[image_id] = [old_candidate]
            entered = threading.Event()
            release = threading.Event()

            def detect_image(*_args):
                pending = state.cache_dir / image_id / ".mozarie-pending-new.tmp"
                Image.fromarray(self._mask(16, 16)).save(pending, format="PNG")
                entered.set()
                self.assertTrue(release.wait(2))
                return [Candidate("new", "penis", 0.9, pending)]

            worker = threading.Thread(target=lambda: state._detect_worker([record], DEFAULT_DETECTION_CONFIDENCE, 1))
            with patch.object(state, "_ensure_models", return_value=[]), patch.object(state, "_detect_image", side_effect=detect_image):
                worker.start()
                self.assertTrue(entered.wait(2))
                source.write_bytes(replacement)
                self.assertEqual(source.stat().st_size, original_stat.st_size)
                os.utime(source, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
                release.set()
                worker.join(3)

            self.assertFalse(worker.is_alive())
            self.assertEqual(state.candidates[image_id], [old_candidate])
            self.assertTrue(old_path.is_file())
            self.assertFalse((state.cache_dir / image_id / ".mozarie-pending-new.tmp").exists())

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

            def detect_image(models, record, _confidence, _mode="standard", _targets=None):
                seen_models.append(id(models))
                mask_path = state.cache_dir / record.image_id / "candidate.png"
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(self._mask(16, 16)).save(mask_path)
                return [Candidate(record.image_id, "penis", 0.9, mask_path)]

            with patch.object(state, "_ensure_models", return_value=base_models), patch.object(state, "_load_detection_models", return_value=second_models), patch.object(state, "_detect_image", side_effect=detect_image):
                state._detect_worker(records, DEFAULT_DETECTION_CONFIDENCE, 2)

            self.assertEqual(set(seen_models), {id(base_models), id(second_models)})
            self.assertEqual(state.job.state, "complete")
            self.assertEqual(state.job.completed, 2)
            self.assertEqual(set(state.job.completed_image_ids), {record.image_id for record in records})
            self.assertTrue(all(state._candidate_revision(record.image_id) == 1 for record in records))

    def test_detection_cancel_stops_loading_additional_model_slots(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("first.png", "second.png", "third.png"):
                Image.new("RGB", (16, 16), "white").save(root / name)
            state = self.new_state()
            records = [state.image_for_id(item["id"]) for item in state.set_root(str(root))]
            control = server_module.JobControl()
            state.job = server_module.Job(kind="detect", state="running", total=3, image_ids=tuple(record.image_id for record in records))

            def load_first_slot():
                control.cancel_requested.set()
                return object()

            with patch.object(state, "_ensure_models", side_effect=load_first_slot), \
                 patch.object(state, "_load_detection_models") as load_more, \
                 patch.object(state, "_detect_image") as detect_image:
                state._detect_worker(records, DEFAULT_DETECTION_CONFIDENCE, 3, control=control)

            load_more.assert_not_called()
            detect_image.assert_not_called()
            self.assertEqual(state.job.state, "cancelled")

    def test_detection_pause_defers_the_next_model_slot_until_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("first.png", "second.png"):
                Image.new("RGB", (16, 16), "white").save(root / name)
            state = self.new_state()
            records = [state.image_for_id(item["id"]) for item in state.set_root(str(root))]
            control = server_module.JobControl()
            state.job = server_module.Job(kind="detect", state="running", total=2, image_ids=tuple(record.image_id for record in records))
            first_loaded = threading.Event()

            def load_first_slot():
                control.pause_requested.set()
                first_loaded.set()
                return object()

            worker = threading.Thread(target=state._detect_worker, args=(records, DEFAULT_DETECTION_CONFIDENCE, 2), kwargs={"control": control})
            with patch.object(state, "_ensure_models", side_effect=load_first_slot), \
                 patch.object(state, "_load_detection_models", return_value=object()) as load_more, \
                 patch.object(state, "_detect_image", return_value=[]):
                worker.start()
                self.assertTrue(first_loaded.wait(2))
                self.assertFalse(load_more.called)
                control.pause_requested.clear()
                worker.join(2)

            self.assertFalse(worker.is_alive())
            load_more.assert_called_once()
            self.assertEqual(state.job.state, "complete")

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

            def detect_image(_models, record, _confidence, _mode="standard", _targets=None):
                if record is records[0]:
                    self.assertTrue(second_started.wait(2))
                mask_path = state.cache_dir / record.image_id / "candidate.png"
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(self._mask(16, 16)).save(mask_path)
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

            def detect_image(_models, record, _confidence, _mode="standard", _targets=None):
                mask_path = state.cache_dir / record.image_id / "candidate.png"
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(self._mask(16, 16)).save(mask_path)
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
            original_save = saving_module.save_with_mask

            def save_then_cancel(*args, **kwargs):
                result = original_save(*args, **kwargs)
                control.cancel_requested.set()
                return result

            with patch.object(saving_module, "save_with_mask", side_effect=save_then_cancel):
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
                return original_save(*args, **kwargs)

            with patch.object(saving_module, "save_with_mask", side_effect=save_then_fail):
                state._apply_worker(records, 100, masks)
            self.assertEqual(state.job.state, "error")
            self.assertEqual(state.job.completed_image_ids, (first_id,))

    def test_apply_worker_serializes_the_same_image_but_overlaps_distinct_images(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "first.png")
            Image.new("RGB", (16, 16), "black").save(root / "second.png")
            state = self.new_state()
            first_id, second_id = (image["id"] for image in state.set_root(str(root)))
            first, second = (state.image_for_id(image_id) for image_id in (first_id, second_id))
            masks = {first_id: self._mask(16, 16), second_id: self._mask(16, 16)}
            state.job = server_module.Job(kind="apply", state="running", total=3, image_ids=(first_id, first_id, second_id))
            first_entered = threading.Event()
            second_entered = threading.Event()
            release = threading.Event()
            started: list[str] = []
            started_lock = threading.Lock()

            def delayed_save(record, _mask, _block_size):
                with started_lock:
                    started.append(record.image_id)
                    if record.image_id == first_id and started.count(first_id) == 1:
                        first_entered.set()
                    if record.image_id == second_id:
                        second_entered.set()
                self.assertTrue(release.wait(2))

            worker = threading.Thread(
                target=state._apply_worker,
                args=([first, first, second], 100, masks),
                kwargs={"saving_parallelism": 3},
            )
            with patch.object(saving_module, "save_with_mask", side_effect=delayed_save):
                worker.start()
                self.assertTrue(first_entered.wait(2))
                self.assertTrue(second_entered.wait(2))
                with started_lock:
                    self.assertEqual(started.count(first_id), 1)
                release.set()
                worker.join(3)

            self.assertFalse(worker.is_alive())
            self.assertEqual(started.count(first_id), 2)

    def test_parallel_apply_starts_two_workers_and_publishes_results_in_input_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index in range(4):
                Image.new("RGB", (16, 16), f"#{index}{index}{index}{index}{index}{index}").save(root / f"image-{index}.png")
            state = self.new_state()
            image_ids = tuple(image["id"] for image in state.set_root(str(root)))
            records = [state.image_for_id(image_id) for image_id in image_ids]
            masks = {image_id: self._mask(16, 16) for image_id in image_ids}
            state.job = server_module.Job(kind="apply", state="running", total=4, image_ids=image_ids)
            rendezvous = threading.Barrier(2)
            two_workers_started = threading.Event()
            release = threading.Event()
            non_first_finished = threading.Event()
            started: list[int] = []
            completion_order: list[int] = []
            started_lock = threading.Lock()
            completion_lock = threading.Lock()
            record_indexes = {record.image_id: index for index, record in enumerate(records)}
            output_paths = {record.image_id: root / "copies" / f"{index}.png" for index, record in enumerate(records)}
            written_paths: list[Path] = []

            def render_in_inverse_order(record, _mask, _block_size):
                index = record_indexes[record.image_id]
                with started_lock:
                    started.append(index)
                    if len(started) == 2:
                        two_workers_started.set()
                if index in (0, 1):
                    rendezvous.wait(timeout=2)
                    if not release.wait(2):
                        raise RuntimeError("test did not release both workers")
                if index == 0:
                    if not non_first_finished.wait(2):
                        raise RuntimeError("later records did not finish")
                else:
                    with completion_lock:
                        completion_order.append(index)
                        if len(completion_order) == 3:
                            non_first_finished.set()
                if index == 0:
                    with completion_lock:
                        completion_order.append(index)
                return f"rendered-{index}".encode("ascii")

            def capture_copy(destination, _output):
                written_paths.append(destination)

            def output_destination(record, _suffix, _reserved):
                return output_paths[record.image_id]

            thread = threading.Thread(
                target=state._apply_worker,
                args=(records, 100, masks),
                kwargs={"copy_to_default": True, "saving_parallelism": 2},
            )
            with patch.object(saving_module, "_default_output_destination", side_effect=output_destination), \
                 patch.object(saving_module, "render_with_mask", side_effect=render_in_inverse_order), \
                 patch.object(saving_module, "write_rendered_copy", side_effect=capture_copy):
                thread.start()
                self.assertTrue(two_workers_started.wait(2))
                self.assertEqual(set(started), {0, 1})
                self.assertEqual(state.job.completed_image_ids, ())
                self.assertEqual(state.job.outputs, [])
                release.set()
                thread.join(2)

            self.assertFalse(thread.is_alive())
            self.assertEqual(completion_order, [1, 2, 3, 0])
            self.assertEqual(state.job.state, "complete")
            self.assertEqual(state.job.completed_image_ids, image_ids)
            self.assertEqual(state.job.outputs, [str(output_paths[record.image_id]) for record in records])
            self.assertEqual(set(written_paths), set(output_paths.values()))

    def test_parallel_apply_failure_stops_workers_from_claiming_more_records(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index in range(4):
                Image.new("RGB", (16, 16), f"#{index}{index}{index}{index}{index}{index}").save(root / f"image-{index}.png")
            state = self.new_state()
            image_ids = tuple(image["id"] for image in state.set_root(str(root)))
            records = [state.image_for_id(image_id) for image_id in image_ids]
            masks = {image_id: self._mask(16, 16) for image_id in image_ids}
            state.job = server_module.Job(kind="apply", state="running", total=4, image_ids=image_ids)
            second_started = threading.Event()
            first_failed = threading.Event()
            release_second = threading.Event()
            claimed: list[int] = []
            claimed_lock = threading.Lock()
            record_indexes = {record.image_id: index for index, record in enumerate(records)}
            output_paths = {record.image_id: root / "copies" / f"{index}.png" for index, record in enumerate(records)}

            def fail_first_render(record, _mask, _block_size):
                index = record_indexes[record.image_id]
                with claimed_lock:
                    claimed.append(index)
                if index == 0:
                    if not second_started.wait(2):
                        raise RuntimeError("second worker did not start")
                    first_failed.set()
                    raise RuntimeError("first record failed")
                if index != 1:
                    raise RuntimeError(f"unexpected record claimed after failure: {index}")
                second_started.set()
                if not release_second.wait(2):
                    raise RuntimeError("test did not release the second worker")
                return b"rendered-second"

            def output_destination(record, _suffix, _reserved):
                return output_paths[record.image_id]

            thread = threading.Thread(
                target=state._apply_worker,
                args=(records, 100, masks),
                kwargs={"copy_to_default": True, "saving_parallelism": 2},
            )
            with patch.object(saving_module, "_default_output_destination", side_effect=output_destination), \
                 patch.object(saving_module, "render_with_mask", side_effect=fail_first_render), \
                 patch.object(saving_module, "write_rendered_copy"):
                thread.start()
                self.assertTrue(second_started.wait(2))
                self.assertTrue(first_failed.wait(2))
                release_second.set()
                thread.join(2)

            self.assertFalse(thread.is_alive())
            self.assertEqual(set(claimed), {0, 1})
            self.assertEqual(state.job.state, "error")
            self.assertEqual(state.job.completed_image_ids, (image_ids[1],))

    def test_pause_waits_for_all_claimed_records_before_becoming_paused(self):
        state = self.new_state()
        records = [ImageRecord(image_id=str(index), path=Path(f"image-{index}.png"), relative_path=f"image-{index}.png", width=1, height=1, mtime_ns=0, content_digest=SYNTHETIC_DIGEST) for index in range(3)]
        control = server_module.JobControl()
        state.job = server_module.Job(kind="apply", state="running", total=3, image_ids=tuple(record.image_id for record in records))
        state.job_control = control
        claimed: list[int] = []
        claimed_lock = threading.Lock()
        started = threading.Barrier(3)
        release_first = threading.Event()
        release_second = threading.Event()
        release_third = threading.Event()
        first_settled = threading.Event()
        paused = threading.Event()
        third_started = threading.Event()
        original_finish = state._finish_claimed_task

        def finish_claimed(*args):
            active_count = original_finish(*args)
            if active_count == 1:
                first_settled.set()
            if state.job.state == "paused":
                paused.set()
            return active_count

        def process(index, _record):
            with claimed_lock:
                claimed.append(index)
            if index < 2:
                started.wait(timeout=2)
                release = release_first if index == 0 else release_second
                if not release.wait(2):
                    raise RuntimeError("test did not release an in-flight record")
            else:
                third_started.set()
                if not release_third.wait(2):
                    raise RuntimeError("test did not release the resumed record")

        thread = threading.Thread(
            target=state._run_fixed_workers,
            args=(records, 2, process, control, None, None),
        )
        with patch.object(state, "_finish_claimed_task", side_effect=finish_claimed):
            thread.start()
            started.wait(timeout=2)
            self.assertEqual(state.job.active_count, 2)
            state.request_pause()
            self.assertEqual(state.job.state, "pausing")
            self.assertEqual(set(claimed), {0, 1})

            release_first.set()
            self.assertTrue(first_settled.wait(2))
            self.assertEqual(state.job.state, "pausing")
            self.assertEqual(state.job.active_count, 1)
            self.assertEqual(set(claimed), {0, 1})

            release_second.set()
            self.assertTrue(paused.wait(2))
            self.assertEqual(state.job.active_count, 0)
            self.assertEqual(set(claimed), {0, 1})

            state.resume_job()
            self.assertEqual(state.job.state, "running")
            self.assertTrue(third_started.wait(2))
            release_third.set()
            thread.join(2)

        self.assertFalse(thread.is_alive())
        self.assertEqual(state.job.active_count, 0)

    def test_inference_gate_reports_locks_held_by_another_thread(self):
        gate = server_module.InferenceGate()
        entered = threading.Event()
        release = threading.Event()

        def hold_gate():
            with gate:
                entered.set()
                self.assertTrue(release.wait(2))

        thread = threading.Thread(target=hold_gate)
        thread.start()
        self.assertTrue(entered.wait(2))
        self.assertTrue(gate.locked())
        release.set()
        thread.join(2)

        self.assertFalse(thread.is_alive())
        self.assertFalse(gate.locked())

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
        merge_segment(segments, "penis", 0.4, first, "ntd11")
        merge_segment(segments, "penis", 0.9, duplicate, "ntd11")
        merge_segment(segments, "penis", 0.7, separate)
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["confidence"], 0.9)
        self.assertTrue(np.array_equal(segments[0]["mask"], duplicate))

    def test_ntd11_segment_wins_over_sensitive_duplicate(self):
        first = np.zeros((12, 12), dtype=np.uint8)
        first[2:8, 2:8] = 255
        secondary = np.zeros((12, 12), dtype=np.uint8)
        secondary[2:8, 2:8] = 255
        segments = []
        merge_segment(segments, "penis", 0.62, first, "ntd11")
        merge_segment(segments, "penis", 0.91, secondary, "sensitive")
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["source"], "ntd11")
        self.assertTrue(np.array_equal(segments[0]["mask"], first))

    def test_detection_confidence_validation_and_auxiliary_floor(self):
        self.assertEqual(DEFAULT_DETECTION_CONFIDENCE, 0.50)
        self.assertEqual(read_detection_confidence("0.10"), 0.10)
        self.assertEqual(read_detection_confidence("1.00"), 1.00)
        self.assertAlmostEqual(confidence_for_source("ntd11", 0.60), 0.45)
        self.assertEqual(confidence_for_source("sensitive", 0.10), 0.50)
        self.assertEqual(confidence_for_source("sensitive", 0.85), 0.85)
        with self.assertRaises(ClientError):
            read_detection_confidence(0.09)
        with self.assertRaisesRegex(ClientError, "0.10から1.00"):
            read_detection_confidence(1.01)

    def test_target_source_replaces_only_overlapping_auxiliary_segments(self):
        precise = np.zeros((40, 40), dtype=np.uint8)
        precise[5:15, 5:15] = 255
        overlapping_legacy = np.zeros((40, 40), dtype=np.uint8)
        overlapping_legacy[4:18, 4:18] = 255
        unmatched_legacy = np.zeros((40, 40), dtype=np.uint8)
        unmatched_legacy[24:34, 24:34] = 255
        result = arbitrate_segment_sources([
            {"class_name": "penis", "confidence": 0.55, "mask": unmatched_legacy, "source": "ntd11"},
            {"class_name": "penis", "confidence": 0.80, "mask": overlapping_legacy, "source": "ntd11"},
            {"class_name": "penis", "confidence": 0.20, "mask": precise, "source": "target"},
        ])
        self.assertEqual(len(result), 2)
        self.assertEqual([segment["source"] for segment in result], ["target", "ntd11"])
        self.assertTrue(any(np.array_equal(segment["mask"], unmatched_legacy) for segment in result))

    def test_precise_arbitration_does_not_merge_nearby_organs(self):
        left = np.zeros((40, 40), dtype=np.uint8)
        left[5:13, 5:13] = 255
        right = np.zeros((40, 40), dtype=np.uint8)
        right[15:23, 15:23] = 255
        result = arbitrate_segment_sources([
            {"class_name": "pussy", "confidence": 0.5, "mask": left, "source": "target"},
            {"class_name": "pussy", "confidence": 0.5, "mask": right, "source": "target"},
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
        fluid = white_fluid_mask(Image.fromarray(rgb), penis)
        self.assertEqual(np.count_nonzero(fluid), 16)

    def test_white_fluid_mask_rejects_large_high_saturation_and_noise_components(self):
        rgb = np.zeros((24, 24, 3), dtype=np.uint8)
        penis = np.zeros((24, 24), dtype=np.uint8)
        penis[2:22, 2:22] = 255
        rgb[3:13, 3:13] = 255
        rgb[15:19, 3:7] = (255, 40, 40)
        rgb[20, 20] = 255
        fluid = white_fluid_mask(Image.fromarray(rgb), penis)
        self.assertFalse(np.any(fluid))

    def test_white_fluid_mask_rejects_pale_skin_connected_to_white_seeds(self):
        rgb = np.zeros((24, 24, 3), dtype=np.uint8)
        penis = np.zeros((24, 24), dtype=np.uint8)
        penis[2:22, 2:22] = 255
        rgb[6:11, 6:14] = (245, 230, 215)
        rgb[(6, 6, 10, 10), (6, 10, 6, 10)] = 255
        fluid = white_fluid_mask(Image.fromarray(rgb), penis)
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
            fluid = white_fluid_mask(Image.fromarray(rgb), penis)
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

    def test_onnx_provider_preflight_rejects_cpu_only_runtime(self):
        with patch("onnxruntime.get_available_providers", return_value=["CPUExecutionProvider"]):
            with self.assertRaisesRegex(ClientError, "CUDAExecutionProvider"):
                assert_onnx_cuda_available()

    def test_sam_cpu_setting_never_selects_cuda(self):
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"; Image.new("RGB", (8, 8), "white").save(image_path)
            checkpoint = Path(directory) / "sam.pth"; checkpoint.write_bytes(b"checkpoint")
            record = self._record(image_path, 8, 8)
            state = self.new_state()
            state.root = Path(directory); state.images = {record.image_id: record}; state.order = [record.image_id]
            state.settings["models"].update({"sam_checkpoint": str(checkpoint), "sam_model_type": "vit_l", "provider": "cpu"})
            model = Mock(); predictor = Mock()
            fake_segment_anything = types.SimpleNamespace(
                SamPredictor=Mock(return_value=predictor), sam_model_registry={"vit_l": Mock(return_value=model)}
            )
            with patch.dict(sys.modules, {"segment_anything": fake_segment_anything}):
                state._sam_predictor_for(record)
            model.to.assert_called_once_with(device="cpu")
            fake_segment_anything.sam_model_registry["vit_l"].assert_called_once_with(checkpoint=str(checkpoint))

    def test_model_verification_occurs_once_for_a_loaded_model_set(self):
        state = self.new_state()
        state.settings["models"].update({"ntd11_enabled": False, "sensitive_enabled": False})
        precise = Mock()
        with patch.object(state, "_configured_model_path", return_value=Path("target.onnx")), patch.object(
            detection_module, "assert_onnx_cuda_available"
        ), patch.object(detection_module, "TargetSegmenter", return_value=precise) as segmenter:
            first = state._ensure_models()
            second = state._ensure_models()
        self.assertIs(first, second)
        self.assertEqual(segmenter.call_count, 1)

    def test_auxiliary_setting_change_keeps_sam_cache(self):
        state = self.new_state()
        next_settings = copy.deepcopy(state.settings)
        next_settings["models"]["ntd11_enabled"] = not next_settings["models"]["ntd11_enabled"]
        state.models = object()
        predictor = object()
        state.sam_predictor = predictor
        state.sam_image_id = "image"
        with patch.object(state.settings_store, "save", return_value=next_settings):
            state.update_settings(next_settings)
        self.assertIsNone(state.models)
        self.assertIs(state.sam_predictor, predictor)
        self.assertEqual(state.sam_image_id, "image")

    def test_sam_setting_change_keeps_detection_model_cache(self):
        state = self.new_state()
        next_settings = copy.deepcopy(state.settings)
        next_settings["models"]["sam_model_type"] = "vit_l"
        models = object()
        state.models = models
        state.sam_predictor = object()
        state.sam_image_id = "image"
        with patch.object(state.settings_store, "save", return_value=next_settings):
            state.update_settings(next_settings)
        self.assertIs(state.models, models)
        self.assertIsNone(state.sam_predictor)
        self.assertIsNone(state.sam_image_id)

    def test_disabled_auxiliary_models_are_not_loaded(self):
        state = self.new_state()
        state.settings["models"].update({"ntd11_enabled": False, "sensitive_enabled": False})
        with patch.object(state, "_configured_model_path", return_value=Path("target.onnx")), patch.object(
            detection_module, "assert_onnx_cuda_available"
        ), patch.object(detection_module, "TargetSegmenter", return_value=Mock()) as segmenter:
            models = state._ensure_models()
        self.assertEqual(models.auxiliaries, [])
        self.assertEqual(segmenter.call_count, 1)

    def test_enabled_auxiliaries_load_in_priority_order(self):
        state = self.new_state()
        state.settings["models"].update({"ntd11_enabled": True, "sensitive_enabled": True})
        paths = iter((Path("target.onnx"), Path("ntd11.onnx"), Path("sensitive.onnx")))
        with patch.object(state, "_configured_model_path", side_effect=lambda *_args: next(paths)), patch.object(
            detection_module, "assert_onnx_cuda_available"
        ), patch.object(detection_module, "TargetSegmenter", return_value=Mock()), patch.object(
            detection_module, "GenericYoloSegmenter", side_effect=[Mock(), Mock()]
        ):
            models = state._load_detection_models()
        self.assertEqual([source for source, _model in models.auxiliaries], ["ntd11", "sensitive"])

    def test_disabled_optional_models_skip_status_validation(self):
        state = self.new_state()
        state.settings["models"].update({
            "ntd11": "missing-ntd11.onnx", "ntd11_enabled": False,
            "sensitive": "missing-sensitive.onnx", "sensitive_enabled": False,
            "hand_detection": "missing-hand.onnx", "hand_detection_enabled": False,
        })
        with patch.object(server_module, "validate_generic_yolo_segment_profile") as generic_validator, patch.object(
            server_module, "validate_hand_profile"
        ) as hand_validator:
            status = state.settings_status()["models"]
        generic_validator.assert_not_called()
        hand_validator.assert_not_called()
        self.assertFalse(status["ntd11"]["enabled"])
        self.assertFalse(status["sensitive"]["enabled"])
        self.assertFalse(status["hand_detection"]["enabled"])

    def test_target_and_auxiliary_segments_are_arbitrated_once(self):
        state = self.new_state()
        state.settings["models"]["provider"] = "cpu"
        mask = np.zeros((10, 10), dtype=np.uint8); mask[2:8, 2:8] = 255
        target = Mock(); target.detect.return_value = [{"class_name": "penis", "confidence": 0.6, "mask": mask, "source": "target"}]
        auxiliary = Mock()
        auxiliary.detect.side_effect = lambda tile, _confidence, source: [{
            "class_name": "penis", "confidence": 0.9, "mask": np.full(tile.shape[:2], 255, dtype=np.uint8), "source": source,
        }]
        models = DetectionModels(target=target, auxiliaries=[("ntd11", auxiliary)])
        segments = state._detect_arbitrated_segments(models, Image.new("RGB", (10, 10), "white"), 0.5)
        self.assertEqual([segment["source"] for segment in segments], ["target"])
        self.assertEqual(auxiliary.detect.call_count, len(detection_tiles(10, 10)))

    def test_hand_model_verification_occurs_once_after_first_load(self):
        state = self.new_state()
        models = DetectionModels(Mock())
        hand = Mock()
        with patch.object(state, "_configured_model_path", return_value=Path("hand.onnx")), patch.object(
            detection_module, "assert_onnx_cuda_available"
        ), patch.object(detection_module, "HandDetector", return_value=hand) as detector:
            first = state._ensure_hand_model(models)
            second = state._ensure_hand_model(models)
        self.assertIs(first, second)
        self.assertEqual(detector.call_count, 1)

    def test_precise_segments_receive_hand_refinement(self):
        state = self.new_state()
        precise_mask = np.zeros((16, 16), dtype=np.uint8)
        precise_mask[4:12, 4:12] = 255
        record = ImageRecord(image_id="image", path=Path(__file__), relative_path="image.png", width=16, height=16, mtime_ns=0, content_digest=SYNTHETIC_DIGEST)
        sam_mask = np.zeros((1, 16, 16), dtype=bool)
        sam_mask[0, 4:8, 4:8] = True
        predictor = Mock()
        predictor.predict.return_value = sam_mask, np.asarray([0.95]), None
        with patch.object(state, "_hand_boxes", return_value=[(4, 4, 12, 12)]), patch.object(
            state, "_sam_predictor_for", return_value=predictor
        ):
            result = state._refine_detected_segments(
                Mock(), record, Image.new("RGB", (16, 16), "white"),
                [{"class_name": "penis", "confidence": 0.8, "mask": precise_mask, "source": "target"}],
            )
        self.assertEqual(result[0]["refinement"], "hand")
        self.assertEqual(np.count_nonzero(result[0]["mask"]), 48)
        predictor.predict.assert_called_once()

    def test_hand_sam_runs_once_per_intersecting_hand_and_is_reused_by_all_segments(self):
        state = self.new_state()
        record = ImageRecord(image_id="image", path=Path(__file__), relative_path="image.png", width=16, height=16, mtime_ns=0, content_digest=SYNTHETIC_DIGEST)
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
            for source in ("target", "ntd11", "sensitive")
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
        record = ImageRecord(image_id="image", path=Path(__file__), relative_path="image.png", width=16, height=16, mtime_ns=0, content_digest=SYNTHETIC_DIGEST)
        with patch.object(state, "_hand_boxes", return_value=[]), patch.object(server_module, "white_fluid_mask") as fluid_mask:
            result = state._refine_detected_segments(
                Mock(), record, Image.new("RGB", (16, 16), "white"),
                [{"class_name": "pussy", "confidence": 0.8, "mask": pussy, "source": "target"}],
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
        record = ImageRecord(image_id="image", path=Path(__file__), relative_path="image.png", width=24, height=24, mtime_ns=0, content_digest=SYNTHETIC_DIGEST)
        with patch.object(state, "_hand_boxes", return_value=[(4, 4, 8, 8)]), patch.object(
            state, "_sam_predictor_for", return_value=predictor
        ):
            result = state._refine_detected_segments(
                Mock(), record, Image.fromarray(rgb),
                [{"class_name": "penis", "confidence": 0.8, "mask": penis, "source": "target"}],
            )
        self.assertEqual(result[0]["refinement"], "hand_fluid")
        self.assertEqual(server_module.REFINEMENT_LABELS[result[0]["refinement"]], "手の重なりと白い体液を除外")
        self.assertEqual(np.count_nonzero(result[0]["mask"]), 368)

    def test_fluid_exclusion_can_be_disabled_without_changing_hand_refinement(self):
        state = self.new_state()
        state.settings["detection"]["fluid_exclusion_enabled"] = False
        penis = np.zeros((16, 16), dtype=np.uint8)
        penis[2:14, 2:14] = 255
        record = ImageRecord(image_id="image", path=Path(__file__), relative_path="image.png", width=16, height=16, mtime_ns=0, content_digest=SYNTHETIC_DIGEST)
        with patch.object(state, "_hand_boxes", return_value=[]), patch.object(server_module, "white_fluid_mask") as fluid_mask:
            result = state._refine_detected_segments(
                Mock(), record, Image.new("RGB", (16, 16), "white"),
                [{"class_name": "penis", "confidence": 0.8, "mask": penis.copy(), "source": "target"}],
            )
        fluid_mask.assert_not_called()
        self.assertTrue(np.array_equal(result[0]["mask"], penis))
        self.assertEqual(result[0]["exclusions"], {})

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
        edge_roi, edge_point = read_boundary_request(
            {"roi": {"left": 2, "top": 3, "right": 20, "bottom": 20}, "point": {"x": 20, "y": 20}},
            20,
            20,
        )
        self.assertEqual(edge_roi, (2, 3, 20, 20))
        self.assertEqual(edge_point, (19, 19))
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
            with patch.object(state, "_sam_predictor_for", return_value=FakePredictor()), \
                 patch.object(state, "_refine_detected_segments", side_effect=lambda _models, _record, _rgb, segments: segments), \
                 patch.object(state, "_ensure_models", return_value=DetectionModels(target=object())):
                created = state.add_boundary_candidate(
                    record.image_id,
                    {"roi": {"left": 3, "top": 3, "right": 9, "bottom": 9}, "point": {"x": 5, "y": 5}},
                )

            self.assertEqual(created["candidates"][0]["source"], "boundary")
            self.assertEqual(created["candidates"][0]["className"], "境界")
            self.assertEqual(created["candidateRevision"], 1)
            self.assertEqual(state.list_candidates(record.image_id), created["candidates"])
            combined = state.combined_candidate_mask(record.image_id)
            self.assertTrue(np.any(combined[3:9, 3:9]))
            self.assertFalse(np.any(combined[:3]))
            self.assertFalse(np.any(combined[:, :3]))

    def test_boundary_second_mask_failure_leaves_no_partial_candidate(self):
        class FakePredictor:
            def predict(self, **_kwargs):
                masks = np.zeros((1, 12, 12), dtype=bool)
                masks[0, 2:10, 2:10] = True
                return masks, np.asarray([0.9]), None

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); Image.new("RGB", (12, 12), "white").save(root / "image.png")
            state = self.new_state(); image_id = state.set_root(str(root))[0]["id"]
            exclusion = np.zeros((12, 12), dtype=np.uint8); exclusion[3:9, 3:9] = 255
            original_fromarray = detection_module.Image.fromarray
            calls = 0

            def fail_second_mask(mask, *args, **kwargs):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("second mask failed")
                return original_fromarray(mask, *args, **kwargs)

            with patch.object(state, "_sam_predictor_for", return_value=FakePredictor()), \
                 patch.object(state, "_ensure_models", return_value=DetectionModels(target=object())), \
                 patch.object(state, "_refine_detected_segments", return_value=[{"exclusions": {"hand": exclusion}}]), \
                 patch.object(detection_module.Image, "fromarray", side_effect=fail_second_mask):
                with self.assertRaisesRegex(OSError, "second mask"):
                    state.add_boundary_candidate(image_id, {"roi": {"left": 2, "top": 2, "right": 10, "bottom": 10}, "point": {"x": 5, "y": 5}})

            self.assertEqual(state.candidates.get(image_id, []), [])
            self.assertEqual(list((state.cache_dir / image_id).glob("*.png")), [])
            self.assertEqual(list((state.cache_dir / image_id).glob("*.tmp")), [])

    def test_boundary_candidate_keeps_hand_fluid_as_an_independent_exclusion(self):
        class FakePredictor:
            def predict(self, **_kwargs):
                masks = np.zeros((1, 12, 12), dtype=bool)
                masks[0, 2:10, 2:10] = True
                return masks, np.asarray([0.9]), None

        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"
            Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            state = self.new_state(); state.root = Path(directory); state.images = {record.image_id: record}; state.order = [record.image_id]

            def refine(_models, _record, _rgb, segments):
                hand = np.zeros((12, 12), dtype=np.uint8); hand[4:6, 4:8] = 255
                fluid = np.zeros((12, 12), dtype=np.uint8); fluid[6:8, 4:8] = 255
                segments[0]["mask"][4:8, 4:8] = 0
                segments[0]["exclusions"] = {"hand": hand, "fluid": fluid}
                segments[0]["refinement"] = "hand_fluid"
                return segments

            with patch.object(state, "_sam_predictor_for", return_value=FakePredictor()), \
                 patch.object(state, "_refine_detected_segments", side_effect=refine), \
                 patch.object(state, "_ensure_models", return_value=DetectionModels(target=object())):
                state.add_boundary_candidate(record.image_id, {"roi": {"left": 2, "top": 2, "right": 10, "bottom": 10}, "point": {"x": 5, "y": 5}})

            candidates = state.list_candidates(record.image_id)
            self.assertEqual([candidate["role"] for candidate in candidates], ["apply", "exclude", "exclude"])
            self.assertEqual([candidate["source"] for candidate in candidates[1:]], ["hand_exclusion", "fluid_exclusion"])
            self.assertTrue(all(candidate["origin"] == "boundary" for candidate in candidates))
            self.assertFalse(np.any(state.combined_candidate_mask(record.image_id)[4:8, 4:8]))

    def test_high_precision_refinement_keeps_detector_mask_when_sam_is_incompatible(self):
        class FakePredictor:
            def predict(self, **_kwargs):
                masks = np.zeros((1, 12, 12), dtype=bool)
                masks[0, 0:2, 0:2] = True
                return masks, np.asarray([0.99]), None

        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"; Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            state = self.new_state()
            mask = np.zeros((12, 12), dtype=np.uint8); mask[3:9, 3:9] = 255
            segment = {"class_name": "penis", "mask": mask.copy(), "confidence": 0.8, "source": "target"}
            with patch.object(state, "_sam_predictor_for", return_value=FakePredictor()):
                refined = state._high_precision_segments(DetectionModels(target=object()), record, [segment])[0]
            self.assertTrue(np.array_equal(refined["mask"], mask))
            self.assertEqual(refined["refinement"], "sam_fallback")

    def test_redetection_preserves_boundary_candidates_and_replaces_auto_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image_path = root / "image.png"
            Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            cache = root / "cache"
            cache.mkdir()
            boundary_path = cache / "boundary.png"
            boundary_hand_path = cache / "boundary-hand.png"
            old_auto_path = cache / "old-auto.png"
            new_auto_path = cache / "new-auto.png"
            Image.fromarray(self._mask(12, 12)).save(boundary_path)
            Image.fromarray(self._mask(12, 12)).save(boundary_hand_path)
            Image.fromarray(self._mask(12, 12)).save(old_auto_path)
            Image.fromarray(self._mask(12, 12)).save(new_auto_path)
            boundary = Candidate("boundary", "境界", 0.9, boundary_path, source="boundary", origin="boundary")
            boundary_hand = Candidate("boundary-hand", "手を除外", None, boundary_hand_path, source="hand_exclusion", origin="boundary", role=server_module.CandidateRole.EXCLUDE)
            old_auto = Candidate("old-auto", "penis", 0.8, old_auto_path)
            new_auto = Candidate("new-auto", "penis", 0.7, new_auto_path)
            state = self.new_state()
            state.root = root
            state.images = {record.image_id: record}
            state.order = [record.image_id]
            state.candidates = {record.image_id: [boundary, boundary_hand, old_auto]}
            with patch.object(state, "_ensure_models", return_value=[]), patch.object(state, "_detect_image", return_value=[new_auto]):
                state._detect_worker([record], DEFAULT_DETECTION_CONFIDENCE)

            self.assertEqual(state.candidates[record.image_id], [boundary, boundary_hand, new_auto])
            self.assertTrue(boundary_path.is_file())
            self.assertTrue(boundary_hand_path.is_file())
            self.assertFalse(old_auto_path.exists())
            self.assertTrue(new_auto_path.is_file())

    def test_boundary_api_returns_the_created_candidate(self):
        from http.server import ThreadingHTTPServer

        expected = {"candidates": [{"id": "boundary", "className": "境界", "confidence": 0.87, "enabled": True, "color": "#ffffff", "source": "boundary", "role": "apply"}], "candidateRevision": 4}
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        try:
            with patch.object(server_module.STATE, "add_boundary_candidate", return_value=expected) as add_candidate:
                body = json.dumps({"imageId": "image", "roi": {"left": 1, "top": 2, "right": 3, "bottom": 4}, "point": {"x": 2, "y": 3}}).encode("utf-8")
                connection.request("POST", "/api/boundary", body, {
                    "Content-Type": "application/json",
                    "X-Mozarie-Token": server_module.STATE.session_token,
                    "Origin": f"http://127.0.0.1:{httpd.server_port}",
                })
                response = connection.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(payload, expected)
            self.assertEqual(add_candidate.call_args.args[0], "image")
        finally:
            connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_settings_status_query_skips_expensive_status_probe(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        try:
            with patch.object(http_module.STATE, "settings_status", return_value={"models": {"target": {"valid": True}}}) as settings_status:
                connection.request("GET", "/api/settings?status=0")
                response = connection.getresponse()
                lightweight = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertIn("settings", lightweight)
                self.assertNotIn("status", lightweight)
                settings_status.assert_not_called()

                connection.request("GET", "/api/settings")
                response = connection.getresponse()
                complete = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertEqual(complete["status"], {"models": {"target": {"valid": True}}})
                settings_status.assert_called_once()
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
                        "X-Mozarie-Token": server_module.STATE.session_token,
                        "Origin": f"http://127.0.0.1:{httpd.server_port}",
                    })
                    response = connection.getresponse()
                    payload = json.loads(response.read().decode("utf-8"))
                    self.assertEqual(response.status, 200)
                self.assertEqual(payload["deleted"], expected)
                self.assertIsInstance(payload["candidateRevision"], int)
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
                    "X-Mozarie-Token": server_module.STATE.session_token,
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

    def test_catalog_remove_api_uses_one_batch_without_deleting_sources(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        expected = {"images": [{"id": "other"}], "removedImageIds": ["first", "second"]}
        try:
            with patch.object(server_module.STATE, "remove_images_from_catalog", return_value=expected) as remove_images:
                connection.request("POST", "/api/catalog/remove", json.dumps({"imageIds": ["first", "second"]}).encode("utf-8"), {
                    "Content-Type": "application/json",
                    "X-Mozarie-Token": server_module.STATE.session_token,
                    "Origin": f"http://127.0.0.1:{httpd.server_port}",
                })
                response = connection.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(payload, expected)
            remove_images.assert_called_once_with(["first", "second"])
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
                "X-Mozarie-Token": server_module.STATE.session_token,
            }, 403),
            ({
                "Content-Type": "text/plain",
                "Origin": origin,
                "X-Mozarie-Token": server_module.STATE.session_token,
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

    def test_detection_mode_is_read_only_from_saved_settings(self):
        state = self.new_state()
        record = ImageRecord(image_id="test", path=Path(__file__), relative_path="test.png", width=1, height=1, mtime_ns=0, content_digest=SYNTHETIC_DIGEST)
        with patch.object(state, "_records_for_ids_with_catalog", return_value=([record], 7)), patch.object(state, "_start_job") as start:
            state.start_detection(["test"], 0.65)
        self.assertEqual(start.call_args.args[0], "detect")
        self.assertEqual(start.call_args.args[-2:], (0.65, 2))
        self.assertEqual(start.call_args.kwargs["expected_catalog_generation"], 7)
        for mode in ("standard", "high_precision"):
            state.settings["detection"]["mode"] = mode
            seen_modes: list[str] = []
            with patch.object(state, "_ensure_models", return_value=object()), \
                 patch.object(state, "_detect_image", side_effect=lambda _models, _record, _confidence, detected_mode, _targets: seen_modes.append(detected_mode) or []):
                state._detect_worker([record], DEFAULT_DETECTION_CONFIDENCE, 1)
            self.assertEqual(seen_modes, [mode])

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

    def test_same_root_reload_rejects_while_import_is_preparing(self):
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
            errors: list[Exception] = []
            original_inspect = catalog_module.inspect_import_image

            def blocked_inspect(path, suffix):
                result = original_inspect(path, suffix)
                entered.set()
                self.assertTrue(release.wait(2))
                return result

            def import_worker():
                try:
                    state.import_images([{"name": "imported.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii")}])
                except Exception as exc:  # pragma: no cover - asserted below
                    errors.append(exc)
                finally:
                    imported.set()

            with patch.object(catalog_module, "inspect_import_image", side_effect=blocked_inspect):
                importer = threading.Thread(target=import_worker)
                importer.start()
                self.assertTrue(entered.wait(2))
                with self.assertRaises(ClientError):
                    state.set_root(str(root))
                release.set()
                importer.join(2)

            self.assertEqual(errors, [])
            self.assertTrue(imported.is_set())
            self.assertEqual(
                [image["relativePath"] for image in state.list_images()],
                ["imported.png", "source.png"],
            )
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
            self.assertFalse((root / ".mozarie_imports").exists())
            self.assertEqual(len(state.list_images()), 2)

    def test_concurrent_imports_decode_outside_the_commit_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            raw = raw_buffer.getvalue()
            state = self.new_state()
            state.set_root(str(root))
            active = 0
            peak = 0
            active_lock = threading.Lock()
            overlap = threading.Event()
            release = threading.Event()
            original_inspect = catalog_module.inspect_import_image

            def blocked_inspect(path, suffix):
                nonlocal active, peak
                with active_lock:
                    active += 1
                    peak = max(peak, active)
                    if active >= 2:
                        overlap.set()
                try:
                    self.assertTrue(release.wait(2))
                    return original_inspect(path, suffix)
                finally:
                    with active_lock:
                        active -= 1

            errors = []
            def worker(name):
                try:
                    state.import_images([{"name": name, "data": base64.b64encode(raw).decode("ascii")}])
                except Exception as exc:  # pragma: no cover - asserted below
                    errors.append(exc)

            with patch.object(catalog_module, "inspect_import_image", side_effect=blocked_inspect):
                first = threading.Thread(target=worker, args=("first.png",))
                second = threading.Thread(target=worker, args=("second.png",))
                first.start(); second.start()
                self.assertTrue(overlap.wait(2), "image verification should overlap across import requests")
                release.set()
                first.join(2); second.join(2)

            self.assertEqual(errors, [])
            self.assertEqual(peak, 2)
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
            self.assertFalse((root / ".mozarie_imports").exists())
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
            self.assertFalse((root / ".mozarie_imports").exists())
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
            Image.fromarray(self._mask(16, 16)).save(mask_path)
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

            with patch.object(state_module, "CACHE_BASE_DIR", cache_base):
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
            original_inspect = catalog_module.inspect_import_image

            def blocked_inspect(path, suffix):
                result = original_inspect(path, suffix)
                entered.set()
                self.assertTrue(release.wait(2))
                return result

            def import_worker():
                try:
                    state.import_images([{"name": "imported.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii")}])
                except Exception as exc:  # pragma: no cover - asserted below
                    errors.append(exc)

            with patch.object(catalog_module, "inspect_import_image", side_effect=blocked_inspect):
                importer = threading.Thread(target=import_worker)
                importer.start()
                self.assertTrue(entered.wait(2))
                with self.assertRaises(ClientError):
                    state._start_job("detect", [record], lambda *_args, **_kwargs: None)
                release.set()
                importer.join(2)

            self.assertEqual(errors, [])
            self.assertFalse((root / ".mozarie_imports").exists())
            self.assertIsNotNone(state.session_imports_dir)

    def test_job_api_exposes_immutable_target_image_ids(self):
        state = self.new_state()
        records = [
            ImageRecord(image_id="first", path=Path(__file__), relative_path="first.png", width=1, height=1, mtime_ns=0, content_digest=SYNTHETIC_DIGEST),
            ImageRecord(image_id="second", path=Path(__file__), relative_path="second.png", width=1, height=1, mtime_ns=0, content_digest=SYNTHETIC_DIGEST),
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
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]

            opened = threading.Event()
            release = threading.Event()
            cleared = threading.Event()
            snapshot_done = threading.Event()
            original_open = server_module.Image.open

            def delayed_open(path, *args, **kwargs):
                if isinstance(path, io.BytesIO):
                    opened.set()
                    release.wait(2)
                return original_open(path, *args, **kwargs)

            with patch.object(server_module.Image, "open", side_effect=delayed_open):
                outcome = {}
                def read_mask():
                    try:
                        outcome["value"] = state.read_candidate_mask_png(image_id, "candidate")
                    except Exception as exc:
                        outcome["error"] = exc
                reader = threading.Thread(target=read_mask)
                clearer = threading.Thread(target=lambda: (state.clear_masks([image_id]), cleared.set()))
                reader.start()
                self.assertTrue(opened.wait(2))
                clearer.start()
                self.assertTrue(cleared.wait(2))
                snapshotter = threading.Thread(target=lambda: (state.catalog_snapshot(), snapshot_done.set()))
                snapshotter.start()
                self.assertTrue(snapshot_done.wait(2))
                release.set()
                reader.join(2)
                clearer.join(2)
                snapshotter.join(2)

            self.assertTrue(cleared.is_set())
            self.assertFalse(mask_path.exists())
            self.assertEqual(state.list_candidates(image_id), [])
            self.assertIsInstance(outcome.get("error"), server_module.StaleMaskError)

    def test_candidate_mask_read_rejects_expected_revision_before_decoding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            expected_revision = state._touch_candidates(image_id)
            state._touch_candidates(image_id)

            with patch.object(catalog_module.Image, "open") as image_open:
                with self.assertRaisesRegex(server_module.StaleMaskError, "更新"):
                    state.read_candidate_mask_png(image_id, "candidate", expected_revision=expected_revision)

            image_open.assert_not_called()

    def test_http_candidate_mask_snapshot_rejects_a_revision_changed_before_decode(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            original_read = state.read_candidate_mask_png
            snapshotted = threading.Event()
            release = threading.Event()

            def delayed_read(requested_id, candidate_id, *, expected_revision=None):
                snapshotted.set()
                self.assertTrue(release.wait(2))
                return original_read(requested_id, candidate_id, expected_revision=expected_revision)

            with patch.object(server_module, "STATE", state), patch.object(http_module, "STATE", state), \
                 patch.object(state, "read_candidate_mask_png", side_effect=delayed_read):
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                result = {}

                def request_mask():
                    connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                    try:
                        connection.request("GET", f"/api/mask/{image_id}/candidate")
                        response = connection.getresponse()
                        result["status"] = response.status
                        result["body"] = response.read()
                    finally:
                        connection.close()

                request = threading.Thread(target=request_mask)
                request.start()
                self.assertTrue(snapshotted.wait(2))
                state.set_candidate_state(image_id, "candidate", {"enabled": False})
                release.set()
                request.join(3)
                httpd.shutdown()
                httpd.server_close()

            self.assertEqual(result["status"], 404)
            self.assertNotEqual(result["body"], mask_path.read_bytes())

    def test_candidate_mask_gets_do_not_rehash_the_source_after_metadata(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            calls = 0
            original_hash = catalog_module.file_sha256

            def tracked_hash(path):
                nonlocal calls
                calls += 1
                return original_hash(path)

            with patch.object(catalog_module, "file_sha256", side_effect=tracked_hash), \
                 patch.object(server_module, "STATE", state), patch.object(http_module, "STATE", state):
                state.candidate_snapshot(image_id)
                self.assertEqual(calls, 1)
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                try:
                    for _ in range(4):
                        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                        connection.request("GET", f"/api/mask/{image_id}/candidate?v={revision}-candidate")
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        response.read()
                        connection.close()
                finally:
                    httpd.shutdown()
                    httpd.server_close()
            self.assertEqual(calls, 1)

    def test_candidate_compose_keeps_catalog_responsive_and_rejects_revision_race(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            state._touch_candidates(image_id)
            opened = threading.Event()
            release = threading.Event()
            catalog_done = threading.Event()
            job_done = threading.Event()
            outcome = {}
            original_open = jobs_module.Image.open

            def delayed_open(path, *args, **kwargs):
                if Path(path) == mask_path:
                    opened.set()
                    self.assertTrue(release.wait(2))
                return original_open(path, *args, **kwargs)

            def compose():
                try:
                    outcome["mask"] = state.combined_candidate_mask(image_id)
                except Exception as exc:
                    outcome["error"] = exc

            with patch.object(jobs_module.Image, "open", side_effect=delayed_open):
                worker = threading.Thread(target=compose)
                worker.start()
                self.assertTrue(opened.wait(2))
                catalog_thread = threading.Thread(target=lambda: (state.catalog_snapshot(), catalog_done.set()))
                job_thread = threading.Thread(target=lambda: (state.job.as_dict(), job_done.set()))
                catalog_thread.start(); job_thread.start()
                self.assertTrue(catalog_done.wait(2))
                self.assertTrue(job_done.wait(2))
                state.set_candidate_state(image_id, "candidate", {"enabled": False})
                release.set()
                worker.join(2); catalog_thread.join(2); job_thread.join(2)

            self.assertIsInstance(outcome.get("error"), ClientError)
            self.assertIn("候補が変更", str(outcome["error"]))

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

    def test_candidate_snapshot_keeps_candidates_and_revision_in_one_epoch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)

            snapshot = state.candidate_snapshot(image_id)

            self.assertEqual(snapshot["candidateRevision"], revision)
            self.assertEqual([item["id"] for item in snapshot["candidates"]], ["candidate"])

    def test_catalog_snapshot_is_self_consistent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            state.set_root(str(root))

            snapshot = state.catalog_snapshot()

            self.assertEqual(
                os.path.normcase(str(Path(snapshot["root"]).resolve())),
                os.path.normcase(str(root.resolve())),
            )
            self.assertEqual(snapshot["catalogGeneration"], state.catalog_generation)
            self.assertEqual(len(snapshot["images"]), 1)

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
            server_module.STATE = state; http_module.STATE = state
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
                server_module.STATE = previous_state; http_module.STATE = previous_state

    def test_missing_enabled_mask_fails_in_the_apply_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "#6688aa").save(source)
            original = source.read_bytes()
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            missing = state.cache_dir / image_id / "missing.png"
            state.candidates[image_id] = [Candidate("missing", "penis", 0.9, missing)]

            self.assertTrue(state.start_apply([image_id], 100, {}))
            assert state.worker_thread is not None
            state.worker_thread.join(2)

            self.assertEqual(state.job.state, "error")
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(len(state.candidates[image_id]), 1)

    def test_apply_skips_empty_masks_and_keeps_success_output_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.png"
            second = root / "second.png"
            Image.new("RGB", (16, 16), "#6688aa").save(first)
            Image.new("RGB", (16, 16), "#aa8866").save(second)
            original_second = second.read_bytes()
            state = self.new_state()
            first_id, second_id = (item["id"] for item in state.set_root(str(root)))
            first_record = state.image_for_id(first_id)
            second_record = state.image_for_id(second_id)
            mask_path = state.cache_dir / first_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[first_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            state.job = server_module.Job(kind="apply", state="running", total=2, image_ids=(first_id, second_id))

            state._apply_worker([first_record, second_record], 100, {})

            self.assertEqual(state.job.state, "complete")
            self.assertEqual(state.job.image_ids, (first_id,))
            self.assertEqual(state.job.outputs, [str(first)])
            self.assertEqual(state.candidates[first_id], [])
            self.assertEqual(second.read_bytes(), original_second)

    def test_apply_all_empty_masks_reports_a_job_error(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            original = source.read_bytes()
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            record = state.image_for_id(image_id)
            state.job = server_module.Job(kind="apply", state="running", total=1, image_ids=(image_id,))

            state._apply_worker([record], 100, {})

            self.assertEqual(state.job.state, "error")
            self.assertIn("保存するモザイク範囲", state.job.error)
            self.assertEqual(source.read_bytes(), original)

    def test_copy_save_empty_record_does_not_consume_a_later_output_name(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "empty.png")
            Image.new("RGB", (16, 16), "black").save(root / "masked.png")
            state = self.new_state()
            first_id, second_id = (item["id"] for item in state.set_root(str(root)))
            records = [state.image_for_id(image_id) for image_id in (first_id, second_id)]
            state.job = server_module.Job(kind="apply", state="running", total=2, image_ids=(first_id, second_id))
            output = root / "output.png"
            written: list[Path] = []

            def colliding_destination(_record, _suffix, reserved):
                return output if output not in reserved else root / "output_2.png"

            with patch.object(saving_module, "_default_output_destination", side_effect=colliding_destination), \
                 patch.object(saving_module, "write_rendered_copy", side_effect=lambda path, _data: written.append(path)):
                state._apply_worker(
                    records, 100, {first_id: np.zeros((16, 16), dtype=np.uint8), second_id: self._mask(16, 16)},
                    copy_to_default=True, saving_parallelism=2,
                )

            self.assertEqual(state.job.outputs, [str(output)])
            self.assertEqual(written, [output])

    def test_removed_image_lock_is_pruned_and_unknown_images_do_not_allocate_one(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            state.image_io_lock(image_id)
            self.assertIn(image_id, state._image_io_locks)

            state.remove_image_from_catalog(image_id)

            self.assertNotIn(image_id, state._image_io_locks)
            with self.assertRaises(ClientError):
                state.image_io_lock("missing")
            self.assertNotIn("missing", state._image_io_locks)

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
            Image.fromarray(self._mask(16, 16)).save(stale.mask_path)
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

        record = ImageRecord(image_id="test", path=Path(__file__), relative_path="test.png", width=1, height=1, mtime_ns=0, content_digest=SYNTHETIC_DIGEST)
        state._start_job("apply", [record], worker)
        self.assertTrue(entered.wait(2))
        state.request_cancel()
        with self.assertRaises(ClientError):
            state._start_job("detect", [record], lambda *_args, **_kwargs: None)
        release.set()
        assert state.worker_thread is not None
        state.worker_thread.join(2)
        state._start_job("detect", [record], lambda *_args, **_kwargs: None)
        assert state.worker_thread is not None
        state.worker_thread.join(2)

    def test_frontend_contract_has_safe_mouse_and_localized_controls(self):
        root = Path(__file__).resolve().parents[1]
        manifest = (root / "static" / "js" / "manifest.js").read_text(encoding="utf-8")
        app = "\n".join((root / "static" / "js" / name).read_text(encoding="utf-8") for name in re.findall(r'"([a-z-]+\.js)"', manifest))
        page = (root / "static" / "index.html").read_text(encoding="utf-8")
        styles = (root / "static" / "style.css").read_text(encoding="utf-8")
        dictionary = json.loads((root / "static" / "i18n" / "ja.json").read_text(encoding="utf-8"))
        self.assertIn('event.button !== 0', app)
        self.assertIn('event.buttons & 1', app)
        self.assertIn('event.shiftKey', app)
        self.assertIn('canvas.addEventListener("contextmenu"', app)
        self.assertIn('async function startDetectionFromDialog', app)
        self.assertIn('data-i18n-aria-label="editor.undo"', page)
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
        self.assertIn('data-i18n="folder.browse">画像を読み込む', page)
        self.assertNotIn('id="browseDialog"', page)
        self.assertNotIn('id="fileBrowserDialog"', page)
        self.assertNotIn('id="jobProgressText"', page)
        self.assertIn('id="processingProgressText"', page)
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
        self.assertNotIn('detectDialog.mode', page)
        self.assertNotIn('detectDialog.standard', dictionary)
        self.assertNotIn('detectDialog.highPrecision', dictionary)
        self.assertIn('id="saveButton"', page)
        self.assertIn('id="galleryFilter"', page)
        self.assertIn('id="saveAllButton"', page)

        self.assertIn('class="appbar"', page)
        self.assertNotIn('class="global-action-bar"', page)
        self.assertIn('class="canvas-tool-rail"', page)
        self.assertIn('id="canvasToolRail" class="canvas-tool-rail" role="toolbar" aria-orientation="vertical"', page)
        self.assertIn('class="canvas-settings-bar"', page)
        self.assertIn('class="canvas-navigation-bar"', page)
        self.assertNotIn('class="editor-context-bar"', page)
        self.assertIn('id="overviewPane"', page)
        self.assertIn('id="overviewGrid"', page)
        self.assertNotIn('id="navigationShortcutsEnabled"', page)
        self.assertIn('id="reviewAndNextButton"', page)
        self.assertIn('id="reviewStatus"', page)
        self.assertNotIn('id="reviewStatus" hidden', page)
        self.assertIn('gallery-review-badge', page)
        self.assertIn('id="previousImageButton"', page)
        self.assertIn('id="nextImageButton"', page)
        self.assertIn('id="divisor"', page)
        self.assertNotIn('id="selectAllButton"', page)
        self.assertNotIn('id="applyButton"', page)
        self.assertIn('id="boundaryTool"', page)
        self.assertIn('path == "/api/boundary"', (root / "mozarie" / "http.py").read_text(encoding="utf-8"))
        self.assertIn('drawBoundaryRoi()', app)
        self.assertIn('function boundaryRequests()', app)
        self.assertIn('function drawBoundaryScrim(shapes)', app)
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
        self.assertIn('id="collapseGalleryButton" class="pane-rail"', page)
        self.assertIn('id="collapseInspectorButton" class="pane-rail"', page)
        self.assertIn('id="applySuffixRow"', page)
        self.assertNotIn('id="applyOverwriteNote"', page)
        self.assertEqual(dictionary["folder.browse"], "画像を読み込む")
        self.assertEqual(dictionary["folder.load"], "読み込む")
        self.assertNotIn('$("#loadFolder")', app)
        self.assertIn('if (event.key === "Enter") loadFolder()', app)
        self.assertIn("batch.clear", dictionary)
        self.assertNotIn("batch.more", dictionary)
        self.assertIn('async function cancelDetection()', app)
        self.assertIn('"/api/job/cancel"', app)
        self.assertIn('control.cancel_requested.is_set()', (root / "mozarie" / "jobs.py").read_text(encoding="utf-8"))
        self.assertIn('settings.shortcuts', dictionary)
        self.assertIn('overview.searchPlaceholder', dictionary)
        self.assertIn('getAsFileSystemHandle', app)
        self.assertIn('webkitGetAsEntry', app)
        self.assertIn('event.preventDefault(); if (!state.applyRunning)', app)
        self.assertIn('paintMosaicPreview()', app)
        self.assertIn('saveTargets()', app)
        self.assertIn('mozarie.reviewed.v1:', app)
        self.assertIn('state.sourceAccess', app)
        self.assertIn('await api("/api/images")', app)
        self.assertIn("apply.handleSource", dictionary)
        self.assertIn("apply.removeAfterSave", dictionary)
        self.assertIn("apply.overwriteNote", dictionary)
        self.assertNotIn('mozarie.navigation-shortcuts.v1', app)
        self.assertIn('function clearBoundaryInteraction()', app)
        self.assertIn('state.polygonPoints = [];', app)
        self.assertNotIn('?t=${Date.now()}', app)
        self.assertIn('candidateRevision', app)
        self.assertIn('settingsOpenBrowser', page)
        self.assertIn('settingsSamType', page)
        self.assertIn('settingsResetButton', page)
        self.assertIn('settings.display', dictionary)
        self.assertEqual(dictionary['settings.display'], '表示・操作')
        self.assertIn('settings.toolPosition', dictionary)
        self.assertIn('settingsToolPosition', page)
        self.assertIn('function applyToolPosition(', app)
        self.assertIn('data-tool-position="top"', styles)
        self.assertIn('data-tool-position="bottom"', styles)
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
        self.assertIn('id="removeAfterSave"', page)
        self.assertIn('id="galleryPaneContent"', page)
        self.assertIn('id="candidatePaneContent"', page)
        self.assertIn('aria-controls="galleryPaneContent"', page)
        self.assertIn('aria-controls="candidatePaneContent"', page)
        self.assertNotIn('id="overviewDetectAllButton"', page)
        self.assertIn('gallery-empty-state', styles)
        self.assertIn('.appbar {', styles)
        self.assertIn('.studio-grid.overview-active > .overview-pane {', styles)
        self.assertEqual(dictionary["gallery.saveTargetCount"], "モザイクあり {count}件")
        self.assertEqual(dictionary["gallery.saveAll"], "モザイク画像を一括保存")
        self.assertEqual(dictionary["batch.clear"], "クリア")
        self.assertEqual(dictionary["batch.actions"], "全画像操作")
        self.assertNotIn("...", dictionary["gallery.saveAll"])
        self.assertNotIn("...", dictionary["gallery.clearAllMasks"])
        self.assertNotIn("...", dictionary["gallery.clearCatalog"])
        self.assertIn('outputDirectoryForSave()', app)
        self.assertIn('chooseOutputDirectoryButton', app)
        self.assertNotIn('data-i18n="batch.more"', page)
        self.assertIn('data-i18n="batch.actions"', page)
        self.assertIn('function positionCatalogContextMenu(', app)
        self.assertIn('menu.showPopover?.();\n  positionCatalogContextMenu(menu, event.clientX, event.clientY);', app)
        self.assertIn("confirm.removeImage.message", dictionary)
        self.assertNotIn('Math.sin(Date.now()', app)
        backend = "\n".join((root / "mozarie" / name).read_text(encoding="utf-8") for name in ("core.py", "state.py", "image_io.py", "http.py"))
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
        self.assertIn('TargetSegmenter', backend)
        self.assertIn('HandDetector', backend)
        self.assertNotIn('from ultralytics import YOLO', backend)
        self.assertIn('path == "/api/masks/clear"', backend)
        self.assertIn('path == "/api/job/pause"', backend)
        self.assertIn('inset: auto; left: anchor(left); top: anchor(bottom); margin-top: 6px;', styles)
        self.assertIn('body { margin: 0; min-width: 0;', styles)

        referenced_keys = set(re.findall(r'data-i18n(?:-title|-aria-label|-placeholder)?="([^"]+)"', page))
        referenced_keys.update(re.findall(r'\bt\("([^"]+)"', app))
        self.assertEqual(referenced_keys - dictionary.keys(), set())

    def test_run_batch_uses_only_python_311_or_newer_in_documented_fallback_order(self):
        root = Path(__file__).resolve().parents[1]
        launcher = (root / "run.bat").read_text(encoding="utf-8")
        self.assertIn('if defined MOZARIE_PYTHON', launcher)
        self.assertIn('%APP_DIR%.venv\\Scripts\\python.exe', launcher)
        self.assertIn('%APP_DIR%..\\ComfyUI_windows_portable\\python_embeded\\python.exe', launcher)
        self.assertIn('py -0p', launcher)
        self.assertIn('findstr /r /c:"-V:3\\.[0-9][0-9]*"', launcher)
        self.assertIn('where python', launcher)
        self.assertIn('sys.version_info >= (3, 11)', launcher)
        self.assertIn('Python 3.11 or newer was not found', launcher)
        self.assertIn('if "%EXIT_CODE%"=="0" exit /b 0\necho Mozarie stopped with exit code %EXIT_CODE%.\npause', launcher)
        self.assertIn(':missing_python\necho [Mozarie] Python 3.11 or newer was not found. Set MOZARIE_PYTHON or create .venv.\npause', launcher)
        self.assertEqual(launcher.count("pause"), 2)
        self.assertLess(launcher.index('MOZARIE_PYTHON'), launcher.index('.venv\\Scripts\\python.exe'))
        self.assertLess(launcher.index('.venv\\Scripts\\python.exe'), launcher.index('ComfyUI_windows_portable\\python_embeded\\python.exe'))
        self.assertLess(launcher.index('python_embeded\\python.exe'), launcher.index('py -0p'))
        self.assertLess(launcher.index('py -0p'), launcher.index('where python'))

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
                "X-Mozarie-Token": server_module.STATE.session_token,
                "Origin": f"http://127.0.0.1:{httpd.server_port}",
            })
            response = connection.getresponse()
            payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 400)
            self.assertEqual(payload["error"], "Windowsフォルダを入力してください。")
            self.assertEqual(payload["error_code"], "invalid_request")
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
            record = ImageRecord(image_id="image", path=Path("image.png"), relative_path="image.png", width=16, height=16, mtime_ns=1, content_digest=SYNTHETIC_DIGEST)
            with patch.object(server_module.STATE, "render_browser_save", return_value=(b"png", record, 3, "one-time-token")):
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                body = json.dumps({"imageId": "image", "candidateRevision": 3, "divisor": 100, "draft": None}).encode("utf-8")
                connection.request("POST", "/api/save/render", body, {
                    "Content-Type": "application/json",
                    "X-Mozarie-Token": server_module.STATE.session_token,
                    "Origin": f"http://127.0.0.1:{httpd.server_port}",
                })
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader("X-Mozarie-Save-Token"), "one-time-token")
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
                    "X-Mozarie-Token": server_module.STATE.session_token,
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
                    "X-Mozarie-Token": server_module.STATE.session_token,
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
                body = json.dumps({"imageIds": ["image-a"], "confidence": 0.65, "parallelism": 3, "mode": "high_precision"}).encode("utf-8")
                connection.request("POST", "/api/detect", body, {
                    "Content-Type": "application/json",
                    "X-Mozarie-Token": server_module.STATE.session_token,
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
            version = state.list_images()[0]["assetVersion"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            candidate_revision = state._touch_candidates(image_id)
            with patch.object(server_module, "STATE", state), patch.object(http_module, "STATE", state):
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
                    for endpoint in (
                        f"/api/image/{image_id}",
                        f"/api/thumbnail/{image_id}",
                        f"/api/mask/{image_id}/candidate",
                    ):
                        expected_version = f"{candidate_revision}-candidate" if "/mask/" in endpoint else version
                        connection.request("GET", f"{endpoint}?v={expected_version}")
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.getheader("Cache-Control"), "private, max-age=31536000, immutable")
                        self.assertTrue(response.read())
                        connection.request("GET", f"{endpoint}?v=stale")
                        stale = connection.getresponse()
                        self.assertEqual(stale.status, 404 if "/mask/" in endpoint else 400)
                        self.assertNotEqual(stale.read(), source.read_bytes())
                finally:
                    connection.close()
                    httpd.shutdown()
                    httpd.server_close()

    def test_binary_import_reader_uses_bounded_chunks_and_cleans_short_body(self):
        class RecordingReader(io.BytesIO):
            def __init__(self, value):
                super().__init__(value)
                self.requests = []

            def read(self, size=-1):
                self.requests.append(size)
                return super().read(size)

        state = self.new_state()
        handler = object.__new__(MosaicHandler)
        body = b"x" * (server_module.IO_CHUNK_BYTES + 7)
        reader = RecordingReader(body)
        handler.headers = {"Content-Length": str(len(body))}
        handler.rfile = reader
        with patch.object(http_module, "STATE", state):
            staged = handler._read_binary_body_to_file()
        try:
            self.assertEqual(staged.read_bytes(), body)
            self.assertTrue(all(0 < size <= server_module.IO_CHUNK_BYTES for size in reader.requests))
        finally:
            staged.unlink(missing_ok=True)

        handler.headers = {"Content-Length": "9"}
        handler.rfile = RecordingReader(b"short")
        with patch.object(http_module, "STATE", state), self.assertRaisesRegex(ClientError, "最後まで"):
            handler._read_binary_body_to_file()
        self.assertEqual(list((state.cache_dir / "import-staging").glob("*")), [])

    def test_thumbnail_requests_singleflight_the_same_image(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (32, 32), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            catalog_source = state.image_for_id(image_id).path
            version = state.list_images()[0]["assetVersion"]
            started = threading.Event()
            release = threading.Event()
            calls = 0
            calls_lock = threading.Lock()
            original_open = http_module.Image.open

            def delayed_open(path, *args, **kwargs):
                nonlocal calls
                if Path(path) == catalog_source:
                    with calls_lock:
                        calls += 1
                    started.set()
                    self.assertTrue(release.wait(2))
                return original_open(path, *args, **kwargs)

            with patch.object(server_module, "STATE", state), patch.object(http_module, "STATE", state), \
                 patch.object(http_module.Image, "open", side_effect=delayed_open):
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                results = []

                def request_thumbnail():
                    connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                    try:
                        connection.request("GET", f"/api/thumbnail/{image_id}?v={version}")
                        response = connection.getresponse()
                        results.append((response.status, response.read()))
                    finally:
                        connection.close()

                workers = [threading.Thread(target=request_thumbnail) for _ in range(8)]
                for worker in workers:
                    worker.start()
                self.assertTrue(started.wait(2))
                with calls_lock:
                    self.assertEqual(calls, 1)
                release.set()
                for worker in workers:
                    worker.join(3)
                httpd.shutdown()
                httpd.server_close()
            self.assertEqual(calls, 1)
            self.assertEqual([status for status, _body in results], [200] * 8)

    def test_exact_image_version_rejects_mutation_after_preflight_before_headers(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            version = state.list_images()[0]["assetVersion"]
            original_assert = state._assert_record_stat_matches

            def mutate_after_preflight(record):
                original_assert(record)
                stat = source.stat()
                os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))

            with patch.object(server_module, "STATE", state), patch.object(http_module, "STATE", state), \
                 patch.object(state, "_assert_record_stat_matches", side_effect=mutate_after_preflight):
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                try:
                    connection.request("GET", f"/api/image/{image_id}?v={version}")
                    response = connection.getresponse()
                    payload = json.loads(response.read().decode("utf-8"))
                    self.assertEqual(response.status, 400)
                    self.assertEqual(payload["error_code"], "stale_asset")
                finally:
                    connection.close()
                    httpd.shutdown()
                    httpd.server_close()

    def test_missing_full_image_after_preflight_returns_error_before_ok_headers(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            version = state.list_images()[0]["assetVersion"]
            validated = threading.Event()
            response_statuses = []
            original_assert = state._assert_record_stat_matches
            original_send_response = MosaicHandler.send_response

            def remove_after_preflight(record):
                original_assert(record)
                source.unlink()
                validated.set()

            def record_response(handler, status, *args, **kwargs):
                response_statuses.append(status)
                return original_send_response(handler, status, *args, **kwargs)

            with patch.object(server_module, "STATE", state), patch.object(http_module, "STATE", state), \
                 patch.object(state, "_assert_record_stat_matches", side_effect=remove_after_preflight), \
                 patch.object(MosaicHandler, "send_response", new=record_response):
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                try:
                    connection.request("GET", f"/api/image/{image_id}?v={version}")
                    response = connection.getresponse()
                    payload = json.loads(response.read().decode("utf-8"))
                    self.assertTrue(validated.is_set())
                    self.assertEqual(response.status, 400)
                    self.assertEqual(payload["error_code"], "invalid_request")
                    self.assertEqual(response_statuses, [400])
                finally:
                    connection.close()
                    httpd.shutdown()
                    httpd.server_close()

    def test_exact_image_stream_holds_image_lock_until_opened_handle_finishes(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            expected_body = source.read_bytes()
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            version = state.list_images()[0]["assetVersion"]
            started = threading.Event()
            release = threading.Event()
            writer_attempted = threading.Event()
            writer_done = threading.Event()
            result = {}
            original_stream = MosaicHandler._stream_file

            def delayed_stream(handler, handle, record, *args):
                if record is not None:
                    started.set()
                    self.assertTrue(release.wait(2))
                return original_stream(handler, handle, record, *args)

            def request_image(port):
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                try:
                    connection.request("GET", f"/api/image/{image_id}?v={version}")
                    response = connection.getresponse()
                    result["status"] = response.status
                    result["body"] = response.read()
                finally:
                    connection.close()

            def mutate_source():
                writer_attempted.set()
                with state.image_io_lock(image_id):
                    Image.new("RGB", (16, 16), "black").save(source)
                writer_done.set()

            with patch.object(server_module, "STATE", state), patch.object(http_module, "STATE", state), \
                 patch.object(MosaicHandler, "_stream_file", new=delayed_stream):
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
                server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                server_thread.start()
                reader = threading.Thread(target=request_image, args=(httpd.server_port,))
                reader.start()
                self.assertTrue(started.wait(2))
                writer = threading.Thread(target=mutate_source)
                writer.start()
                self.assertTrue(writer_attempted.wait(2))
                self.assertFalse(writer_done.is_set())
                release.set()
                reader.join(3)
                writer.join(3)
                httpd.shutdown()
                httpd.server_close()

            self.assertEqual(result, {"status": 200, "body": expected_body})
            self.assertTrue(writer_done.is_set())

    def test_thumbnail_generation_limits_distinct_images_to_four(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index in range(5):
                Image.new("RGB", (32, 32), "white").save(root / f"{index}.png")
            state = self.new_state()
            images = state.set_root(directory)
            versions = {item["id"]: item["assetVersion"] for item in state.list_images()}
            source_paths = {record.path for record in state.images.values()}
            first_four = threading.Event()
            release = threading.Event()
            entered: set[Path] = set()
            entered_lock = threading.Lock()
            original_open = http_module.Image.open

            def delayed_open(path, *args, **kwargs):
                path = Path(path)
                if path in source_paths:
                    with entered_lock:
                        entered.add(path)
                        if len(entered) == 4:
                            first_four.set()
                    self.assertTrue(release.wait(2))
                return original_open(path, *args, **kwargs)

            with patch.object(server_module, "STATE", state), patch.object(http_module, "STATE", state), \
                 patch.object(http_module.Image, "open", side_effect=delayed_open):
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
                server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                server_thread.start()
                statuses = []

                def request_thumbnail(image):
                    connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                    try:
                        connection.request("GET", f"/api/thumbnail/{image['id']}?v={versions[image['id']]}")
                        response = connection.getresponse()
                        statuses.append(response.status)
                        response.read()
                    finally:
                        connection.close()

                workers = [threading.Thread(target=request_thumbnail, args=(image,)) for image in images]
                for worker in workers:
                    worker.start()
                self.assertTrue(first_four.wait(2))
                with entered_lock:
                    self.assertEqual(len(entered), 4)
                release.set()
                for worker in workers:
                    worker.join(3)
                httpd.shutdown()
                httpd.server_close()
            self.assertEqual(sorted(statuses), [200] * 5)

    def test_browser_save_overwrite_updates_state_when_timestamp_restore_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            record = state.image_for_id(image_id)
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)

            with patch("server.os.utime", side_effect=OSError("denied")):
                committed = state.commit_browser_save(image_id, rendered_revision, token, "overwrite")

            self.assertTrue(committed["cleared"])
            self.assertEqual(source.read_bytes(), output)
            self.assertEqual(record.size_bytes, source.stat().st_size)
            self.assertEqual(record.content_digest, hashlib.sha256(source.read_bytes()).hexdigest())

    def test_browser_save_commit_acquires_import_lock_before_its_image_lock(self):
        class RecordingLock:
            def __init__(self, label, events):
                self.label = label
                self.events = events
                self.lock = threading.RLock()

            def __enter__(self):
                self.events.append(self.label)
                self.lock.acquire()
                return self

            def __exit__(self, *_args):
                self.lock.release()

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
            events = []
            original_import_lock = state.import_lock
            state.import_lock = RecordingLock("import", events)
            try:
                with patch.object(state, "image_io_lock", return_value=RecordingLock("image", events)):
                    state.commit_browser_save(image_id, rendered_revision, token, "keep")
            finally:
                state.import_lock = original_import_lock

            self.assertEqual(events[:2], ["import", "image"])

    def test_catalog_clear_waits_for_browser_commit_to_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
            fingerprint_started = threading.Event()
            release = threading.Event()
            clear_done = threading.Event()
            commit_result = {}
            original_fingerprint = state._source_fingerprint

            def delayed_fingerprint(record):
                fingerprint_started.set()
                self.assertTrue(release.wait(2))
                return original_fingerprint(record)

            with patch.object(state, "_source_fingerprint", side_effect=delayed_fingerprint):
                commit = threading.Thread(
                    target=lambda: commit_result.setdefault(
                        "value", state.commit_browser_save(image_id, rendered_revision, token, "keep")
                    )
                )
                commit.start()
                self.assertTrue(fingerprint_started.wait(2))
                clearer = threading.Thread(target=lambda: (state.clear_catalog(), clear_done.set()))
                clearer.start()
                self.assertFalse(clear_done.is_set())
                release.set()
                commit.join(3)
                clearer.join(3)

            self.assertFalse(commit.is_alive())
            self.assertTrue(commit_result["value"]["cleared"])
            self.assertTrue(clear_done.is_set())
            self.assertEqual(state.list_images(), [])

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
        Image.fromarray(self._mask(16, 16)).save(mask_path)
        state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
        revision = state._touch_candidates(image_id)
        state.image_io_lock(image_id)

        _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
        rendered_path = state.browser_save_tokens[token].rendered_path
        self.assertTrue(rendered_path.is_file())
        committed = state.commit_browser_save(image_id, rendered_revision, token, "overwrite")

        self.assertTrue(committed["cleared"])
        self.assertFalse(rendered_path.exists())
        self.assertEqual(Image.open(record.path).text["prompt"], '{"seed": 9}')
        self.assertEqual(state.candidates.get(image_id, []), [])
        self.assertEqual(record.content_digest, hashlib.sha256(record.path.read_bytes()).hexdigest())

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
        Image.fromarray(self._mask(16, 16)).save(mask_path)
        state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
        revision = state._touch_candidates(image_id)

        _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
        rendered_path = state.browser_save_tokens[token].rendered_path
        committed = state.commit_browser_save(image_id, rendered_revision, token, "deleted")

        self.assertTrue(committed["deleted"])
        self.assertNotIn(image_id, state.images)
        self.assertNotIn(image_id, state._image_io_locks)
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
            Image.fromarray(self._mask(16, 16)).save(mask_path)
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
            Image.fromarray(pixels).save(source, pnginfo=metadata)

            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            record = state.image_for_id(image_id)
            rgba_mask = np.full((height, width, 4), 255, dtype=np.uint8)
            rgba_mask[..., 3] = 0
            rgba_mask[600:616, 400:416, 3] = 255
            draft = {"add": self._png_data_url(Image.fromarray(rgba_mask))}
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
            Image.fromarray(self._mask(16, 16)).save(mask_path)
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
            Image.fromarray(self._mask(16, 16)).save(mask_path)
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
            Image.fromarray(self._mask(16, 16)).save(mask_path)
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
            Image.fromarray(self._mask(16, 16)).save(mask_path)
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

    def test_browser_save_claim_keeps_rendered_file_during_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / "source.png"; Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state(); image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"; mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
            rendered_path = state.browser_save_tokens[token].rendered_path
            claimed = threading.Event(); release = threading.Event(); outcome = {}
            original_fingerprint = state._source_fingerprint

            def block_after_claim(record):
                claimed.set(); self.assertTrue(release.wait(2)); return original_fingerprint(record)

            def commit():
                try:
                    outcome["value"] = state.commit_browser_save(image_id, rendered_revision, token, "keep")
                except Exception as exc:
                    outcome["error"] = exc

            with patch.object(state, "_source_fingerprint", side_effect=block_after_claim):
                thread = threading.Thread(target=commit); thread.start()
                self.assertTrue(claimed.wait(2))
                state.cleanup_expired_browser_save_tokens()
                self.assertTrue(rendered_path.exists())
                release.set(); thread.join(2)

            self.assertNotIn("error", outcome)
            self.assertTrue(outcome["value"]["cleared"])
            self.assertFalse(rendered_path.exists())

    def test_browser_save_catalog_mismatch_removes_rendered_file(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(source.parent))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
            rendered_path = state.browser_save_tokens[token].rendered_path
            state.catalog_generation += 1

            with self.assertRaisesRegex(ClientError, "画像一覧が変更"):
                state.commit_browser_save(image_id, rendered_revision, token, "keep")

            self.assertFalse(rendered_path.exists())
            self.assertNotIn(token, state.browser_save_tokens)

    def test_shutdown_discards_pending_browser_save_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
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
            Image.fromarray(self._mask(16, 16)).save(mask_path)
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
        Image.fromarray(self._mask(16, 16)).save(mask_path)
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
            Image.fromarray(pixels).save(source, compress_level=0)
            state = self.new_state()
            image_id = state.set_root(str(source.parent))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, save_token = state.render_browser_save(image_id, revision, 100, None)
            original_stat = source.stat()
            pixels[..., 0] = 200
            Image.fromarray(pixels).save(source, compress_level=0)
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
            Image.fromarray(self._mask(16, 16)).save(mask_path)
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
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, record, rendered_revision, save_token = state.render_browser_save(image_id, revision, 100, None)

            original_unlink = Path.unlink

            def fail_only_for_source(path: Path, *args, **kwargs):
                if path == record.path:
                    raise PermissionError("locked")
                return original_unlink(path, *args, **kwargs)

            with patch.object(type(record.path), "unlink", autospec=True, side_effect=fail_only_for_source):
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
            Image.fromarray(mask).save(mask_path)
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

            with patch.object(saving_module, "render_with_mask", side_effect=capture_snapshot):
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
            Image.fromarray(self._mask(16, 16)).save(mask_path)
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
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            Image.new("RGB", (16, 16), "black").save(source)
            with self.assertRaises(ClientError):
                state.prepare_browser_save([image_id], 100, "_censored", False)
            self.assertEqual(len(state.candidates[image_id]), 1)

    def test_browser_save_commit_rejects_same_stat_source_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            replacement = self._write_same_size_png_pair(source)
            original_stat = source.stat()
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
            source.write_bytes(replacement)
            self.assertEqual(source.stat().st_size, original_stat.st_size)
            os.utime(source, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))

            with self.assertRaisesRegex(ClientError, "外部で変更") as raised:
                state.commit_browser_save(image_id, rendered_revision, token, "overwrite")
            self.assertEqual(raised.exception.error_code, "stale_asset")
            self.assertEqual([candidate.candidate_id for candidate in state.candidates[image_id]], ["candidate"])
            self.assertEqual(Image.open(source).getpixel((0, 0)), (0, 0, 255))

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
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
            first = state.commit_browser_save(image_id, rendered_revision, token, "keep")
            retried = state.commit_browser_save(image_id, rendered_revision, token, "keep")
            self.assertFalse(mask_path.exists())
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

    def test_binary_import_can_skip_rebuilding_the_full_catalog(self):
        with tempfile.TemporaryDirectory():
            source = io.BytesIO()
            Image.new("RGB", (12, 8), "white").save(source, format="PNG")
            state = self.new_state()
            with patch.object(state, "list_images", wraps=state.list_images) as list_images:
                images, imported = state.import_image_bytes_for_api(
                    source.getvalue(),
                    name="first.png",
                    relative_path="nested/first.png",
                    client_key="client-1",
                    include_images=False,
                )
            self.assertEqual(images, [])
            self.assertEqual(len(imported), 1)
            list_images.assert_not_called()

    def test_update_stops_server_and_state_before_launching_batch(self):
        events = []
        http_server = Mock(); http_server.shutdown.side_effect = lambda: events.append("server")
        with patch.object(server_module.time, "sleep"), patch.object(server_module.STATE, "shutdown", side_effect=lambda: events.append("state")), patch.object(server_module.subprocess, "Popen", side_effect=lambda *args, **kwargs: events.append("batch")):
            server_module._start_update_after_response(http_server)
        self.assertEqual(events, ["server", "state", "batch"])

    def test_default_output_suffix_rejects_path_and_keeps_relative_folder(self):
        record = ImageRecord(image_id="id", path=Path("C:/source.png"), relative_path="nested/source.png", width=1, height=1, mtime_ns=0, size_bytes=0, content_digest=SYNTHETIC_DIGEST)
        destination = server_module._default_output_destination(record, "_mosaic")
        self.assertTrue(str(destination).endswith("output\\nested\\source_mosaic.png"))
        with self.assertRaises(ClientError): server_module._read_save_suffix("../bad")

    def test_same_stat_replacement_is_digest_gated_without_losing_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            replacement = self._write_same_size_png_pair(source)
            original_stat = source.stat()
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            source.write_bytes(replacement)
            self.assertEqual(source.stat().st_size, original_stat.st_size)
            os.utime(source, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))

            with self.assertRaisesRegex(ClientError, "外部で変更") as raised:
                state.candidate_snapshot(image_id)
            self.assertEqual(raised.exception.error_code, "stale_asset")
            self.assertEqual([candidate.candidate_id for candidate in state.candidates[image_id]], ["candidate"])
            self.assertTrue(mask_path.is_file())

    def test_folder_scan_is_bounded_to_two_hashers_and_sorted_deterministically(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("c.png", "B.png", "a.png", "nested/d.png"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                Image.new("RGB", (8, 8), "white").save(path)
            active = peak = 0
            active_lock = threading.Lock()
            original_hash = catalog_module.file_sha256

            def tracked_hash(path):
                nonlocal active, peak
                with active_lock:
                    active += 1
                    peak = max(peak, active)
                try:
                    time.sleep(0.01)
                    return original_hash(path)
                finally:
                    with active_lock:
                        active -= 1

            with patch.object(catalog_module, "file_sha256", side_effect=tracked_hash):
                records = self.new_state().set_root(directory)
            self.assertLessEqual(peak, 2)
            self.assertEqual([record["relativePath"] for record in records], ["a.png", "B.png", "c.png", "nested/d.png"])

    def test_session_imports_store_the_digest_streamed_while_staging(self):
        raw = io.BytesIO()
        Image.new("RGB", (8, 8), "#112233").save(raw, format="PNG")
        payload = raw.getvalue()
        expected = hashlib.sha256(payload).hexdigest()
        state = self.new_state()
        images, _imported = state.import_images_for_api([{
            "clientKey": "raw", "name": "raw.png", "data": base64.b64encode(payload).decode("ascii"),
        }])
        self.assertEqual(state.image_for_id(images[0]["id"]).content_digest, expected)
        with tempfile.TemporaryDirectory() as directory:
            staged = Path(directory) / "staged.png"
            staged.write_bytes(payload)
            _images, imported = state.import_image_file_for_api(
                staged, name="staged.png", relative_path="staged.png", client_key="staged",
            )
        self.assertEqual(state.image_for_id(imported[0]["imageId"]).content_digest, expected)

    def test_browser_render_reads_source_then_hashes_once_after_render(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            calls = 0
            original_hash = catalog_module.file_sha256

            def tracked_hash(path):
                nonlocal calls
                calls += 1
                return original_hash(path)

            with patch.object(catalog_module, "file_sha256", side_effect=tracked_hash):
                state.render_browser_save(image_id, revision, 100, None)
            self.assertEqual(calls, 1)

    def test_older_browser_overwrite_token_cannot_replace_a_newer_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.fromarray(np.tile(np.arange(16, dtype=np.uint8), (16, 1))).convert("RGB").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            output_a, _record, revision_a, token_a = state.render_browser_save(image_id, revision, 100, None)
            output_b, _record, revision_b, token_b = state.render_browser_save(image_id, revision, 1, None)
            self.assertNotEqual(output_a, output_b)
            state.commit_browser_save(image_id, revision_b, token_b, "overwrite")
            digest_b = state.image_for_id(image_id).content_digest

            with self.assertRaisesRegex(ClientError, "外部で変更") as raised:
                state.commit_browser_save(image_id, revision_a, token_a, "overwrite")
            self.assertEqual(raised.exception.error_code, "stale_asset")
            self.assertEqual(source.read_bytes(), output_b)
            self.assertEqual(state.image_for_id(image_id).content_digest, digest_b)

    def test_candidate_state_changes_do_not_hash_the_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            with patch.object(catalog_module, "file_sha256", side_effect=AssertionError("unexpected hash")):
                state.set_candidate_state(image_id, "candidate", {"enabled": False})

    def test_filesystem_save_rechecks_after_staging_before_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            original_stat = source.stat()
            state = self.new_state()
            record = state.image_for_id(state.set_root(directory)[0]["id"])
            original_verify = image_io_module._verify_decodable_image

            def mutate_after_staging(raw, **kwargs):
                result = original_verify(raw, **kwargs)
                Image.new("RGB", (16, 16), "blue").save(source)
                os.utime(source, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
                return result

            with patch.object(image_io_module, "_verify_decodable_image", side_effect=mutate_after_staging):
                with self.assertRaisesRegex(ClientError, "外部で変更"):
                    save_with_mask(record, self._mask(16, 16), 4)
            self.assertEqual(Image.open(source).getpixel((0, 0)), (0, 0, 255))
            self.assertNotEqual(record.content_digest, hashlib.sha256(source.read_bytes()).hexdigest())

    def test_copy_save_rechecks_after_render_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            original_stat = source.stat()
            state = self.new_state()
            record = state.image_for_id(state.set_root(directory)[0]["id"])
            original_render = saving_module.render_with_mask

            def render_then_mutate(*args):
                output = original_render(*args)
                Image.new("RGB", (16, 16), "blue").save(source)
                os.utime(source, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
                return output

            with patch.object(saving_module, "render_with_mask", side_effect=render_then_mutate), \
                 patch.object(saving_module, "write_rendered_copy") as write_copy:
                state._apply_worker([record], 100, {record.image_id: self._mask(16, 16)}, copy_to_default=True)
            write_copy.assert_not_called()
            self.assertEqual(Image.open(source).getpixel((0, 0)), (0, 0, 255))

    def test_capture_bytes_must_match_digest_even_if_source_is_restored_before_final_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            white = source.read_bytes()
            blue_path = Path(directory) / "blue.png"
            Image.new("RGB", (16, 16), "blue").save(blue_path)
            blue = blue_path.read_bytes()
            state = self.new_state()
            image_id = next(image["id"] for image in state.set_root(directory) if image["relativePath"] == "source.png")
            record = state.image_for_id(image_id)
            concrete_path_type = type(source)
            original_read = concrete_path_type.read_bytes
            source_resolved = source.resolve()

            def swapped_capture(path):
                if path.resolve() != source_resolved:
                    return original_read(path)
                source.write_bytes(blue)
                try:
                    return original_read(source)
                finally:
                    source.write_bytes(white)

            with patch.object(concrete_path_type, "read_bytes", autospec=True, side_effect=swapped_capture):
                with self.assertRaisesRegex(ClientError, "外部で変更"):
                    server_module.render_with_mask(record, self._mask(16, 16), 4)
            with patch.object(concrete_path_type, "read_bytes", autospec=True, side_effect=swapped_capture):
                with self.assertRaisesRegex(ClientError, "外部で変更"):
                    save_with_mask(record, self._mask(16, 16), 4)
            self.assertEqual(source.read_bytes(), white)

if __name__ == "__main__":
    unittest.main()
