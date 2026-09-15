"""Regression coverage for loading the HTTP request handler module."""

import ast
import contextlib
import importlib
import shutil
import tempfile
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from PIL import Image

from mozarie import catalog as catalog_module
from mozarie import http as http_module
from mozarie import state as state_module
from mozarie.core import ClientError
from mozarie.http import MosaicHandler
from mozarie.state import StudioState


class HttpImportRegressionTests(unittest.TestCase):
    def test_http_module_parses_and_imports(self) -> None:
        source = (Path(__file__).parents[1] / "mozarie" / "http.py").read_text(encoding="utf-8")
        ast.parse(source)
        importlib.import_module("mozarie.http")

    def test_import_and_thumbnail_paths_do_not_add_fixed_global_gates(self) -> None:
        root = Path(__file__).parents[1]
        sources = {
            "core": (root / "mozarie" / "core.py").read_text(encoding="utf-8"),
            "state": (root / "mozarie" / "state.py").read_text(encoding="utf-8"),
            "http": (root / "mozarie" / "http.py").read_text(encoding="utf-8"),
        }
        for gate in ("import_staging_gate", "thumbnail_gate", "THUMBNAIL_WORKERS", "thumbnail_generation_lock"):
            self.assertFalse(any(gate in source for source in sources.values()), gate)
        self.assertIn("with STATE.image_io_lock(image_id):", sources["http"])
        self.assertEqual(sources["http"].count("if not thumbnail_path.is_file():"), 1)


class FolderLoadLoggingContractTests(unittest.TestCase):
    """Keep the user-visible CMD summary and HTTP operation log bounded."""

    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary_directory.name)
        self.app_dir = self.root / "app"
        shutil.copytree(Path(__file__).parents[1] / "config", self.app_dir / "config")
        self.states: list[StudioState] = []

    def tearDown(self) -> None:
        for state in self.states:
            state.shutdown()
        self._temporary_directory.cleanup()

    def new_state(self) -> StudioState:
        with patch.object(state_module, "APP_DIR", self.app_dir):
            state = StudioState(self.root / "cache", self.root / "sessions")
        self.states.append(state)
        return state

    @staticmethod
    def write_png(path: Path, color: str = "white") -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (8, 8), color).save(path)

    def test_folder_scan_aggregates_corrupt_and_changed_files_without_per_file_logs(self) -> None:
        folder = self.root / "mixed"
        folder.mkdir()
        self.write_png(folder / "valid.png")
        (folder / "corrupt.png").write_bytes(b"not an image")
        self.write_png(folder / "changed.png")
        state = self.new_state()
        state.settings["importing"]["parallelism"] = 1
        inspect = catalog_module.inspect_import_image

        def change_after_inspection(path: Path, suffix: str) -> tuple[int, int]:
            dimensions = inspect(path, suffix)
            if path.name == "changed.png":
                self.write_png(path, "black")
            return dimensions

        with patch.object(catalog_module, "inspect_import_image", side_effect=change_after_inspection), \
                self.assertLogs("mozarie.core", "INFO") as captured:
            images = state.set_root(str(folder))

        self.assertEqual([image["relativePath"] for image in images], ["valid.png"])
        log = "\n".join(captured.output)
        self.assertIn("フォルダー走査を開始", log)
        self.assertIn("候補=3件 読込=1件", log)
        self.assertIn("image_read_failed=1件（例: corrupt.png）", log)
        self.assertIn("scan_changed=1件（例: changed.png）", log)
        self.assertEqual(log.count("フォルダー走査を"), 2)

    def test_empty_and_unreadable_folders_keep_the_previous_catalog(self) -> None:
        previous = self.root / "previous"
        previous.mkdir()
        self.write_png(previous / "kept.png")
        state = self.new_state()
        state.set_root(str(previous))
        before = state.catalog_snapshot()
        before_images = state.list_images()

        empty = self.root / "empty"
        empty.mkdir()
        with self.assertLogs("mozarie.core", "INFO") as empty_logs:
            with self.assertRaisesRegex(ClientError, "対応画像がありません") as raised:
                state.set_root(str(empty))
        self.assertEqual(raised.exception.error_code, "image_read_failed")
        self.assertIn("候補=0件 読込=0件 スキップ=なし", "\n".join(empty_logs.output))
        self.assertEqual(state.catalog_snapshot(), before)
        self.assertEqual(state.list_images(), before_images)

        unreadable = self.root / "unreadable"
        unreadable.mkdir()
        (unreadable / "broken.png").write_bytes(b"not an image")
        with self.assertLogs("mozarie.core", "INFO") as unreadable_logs:
            with self.assertRaisesRegex(ClientError, "読み込めません") as raised:
                state.set_root(str(unreadable))
        self.assertEqual(raised.exception.error_code, "image_read_failed")
        self.assertIn("候補=1件 読込=0件 スキップ=image_read_failed=1件（例: broken.png）", "\n".join(unreadable_logs.output))
        self.assertEqual(state.catalog_snapshot(), before)
        self.assertEqual(state.list_images(), before_images)

    def test_handler_logs_normalized_routes_without_request_secrets(self) -> None:
        secret_id = "image-id-secret"
        secret_body = "body-secret"
        secret_header = "header-secret"
        payload = {"imageIds": [secret_id], "note": secret_body}
        state = Mock()
        state.catalog_request.return_value = contextlib.nullcontext()
        state.set_image_flags.return_value = {"hidden": True}
        state.recover_gpu_oom_for_request.return_value = None

        def request() -> MosaicHandler:
            handler = object.__new__(MosaicHandler)
            handler.path = f"/api/workspace/image/{secret_id}"
            handler.headers = {"X-Mozarie-Token": secret_header, "Authorization": secret_header}
            handler._require_json_request = lambda: None
            handler._read_json_body = lambda: payload
            handler._catalog_expectation = lambda _payload: (None, 0)
            handler._json = Mock()
            handler._client_error = Mock()
            return handler

        completed = request()
        with patch.object(http_module, "STATE", state), self.assertLogs("mozarie.core", "INFO") as completed_logs:
            completed.do_POST()
        completed._json.assert_called_once_with({"hidden": True})
        success_log = "\n".join(completed_logs.output)
        self.assertIn("操作開始: 画像状態変更 [/api/workspace/image]", success_log)
        self.assertIn("操作対象: 画像状態変更 [/api/workspace/image] 対象=1件", success_log)
        self.assertIn("操作完了: 画像状態変更 [/api/workspace/image] status=200 所要=", success_log)

        state.set_image_flags.side_effect = ClientError("bad request", "input_invalid")
        failed = request()
        with patch.object(http_module, "STATE", state), self.assertLogs("mozarie.core", "WARNING") as failed_logs:
            failed.do_POST()
        failure_log = "\n".join(failed_logs.output)
        self.assertIn("操作失敗: 画像状態変更 [/api/workspace/image] status=400 error_code=input_invalid 所要=", failure_log)
        for secret in (secret_id, secret_body, secret_header):
            self.assertNotIn(secret, success_log)
            self.assertNotIn(secret, failure_log)
