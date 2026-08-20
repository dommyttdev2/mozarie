from __future__ import annotations

import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import updater


def make_release(tag: str = "v1.2.0", url: str = "https://example.test/release.zip") -> dict:
    return {"tag_name": tag, "assets": [], "zipball_url": url}


def make_source(root: Path, version: str = "1.2.0") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "VERSION").write_text(version, encoding="utf-8")
    (root / "server.py").write_text("new server", encoding="utf-8")
    (root / "run.bat").write_text("new run", encoding="utf-8")
    (root / "requirements.txt").write_text("Pillow\n", encoding="utf-8")
    (root / "mozarie").mkdir()
    (root / "mozarie" / "core.py").write_text("new core", encoding="utf-8")
    (root / "static").mkdir()
    (root / "static" / "app.js").write_text("new app", encoding="utf-8")
    (root / "config").mkdir()
    (root / "config" / "defaults.json").write_text("{}", encoding="utf-8")
    return root


def make_install(root: Path, version: str = "1.1.0") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "VERSION").write_text(version, encoding="utf-8")
    (root / "server.py").write_text("old server", encoding="utf-8")
    (root / "run.bat").write_text("old run", encoding="utf-8")
    (root / "requirements.txt").write_text("Pillow\n", encoding="utf-8")
    (root / "mozarie").mkdir()
    (root / "mozarie" / "core.py").write_text("old core", encoding="utf-8")
    (root / "static").mkdir()
    (root / "static" / "app.js").write_text("old app", encoding="utf-8")
    (root / "config").mkdir()
    (root / "config" / "defaults.json").write_text('{"old": true}', encoding="utf-8")
    (root / "config" / "local.json").write_text('{"mine": true}', encoding="utf-8")
    (root / "models").mkdir()
    (root / "models" / "model.onnx").write_bytes(b"model")
    (root / ".mozarie-cache").mkdir()
    (root / ".mozarie-cache" / "draft.bin").write_bytes(b"draft")
    (root / ".git").mkdir()
    (root / ".git" / "HEAD").write_text("main", encoding="utf-8")
    (root / "update.bat").write_text("stable entry", encoding="utf-8")
    return root


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class UpdaterTests(unittest.TestCase):
    def test_version_parsing_and_display(self):
        self.assertEqual(updater.parse_version("v1.2.3"), (1, 2, 3))
        self.assertEqual(updater.display_version("1.2.3"), "v1.2.3")
        with self.assertRaises(updater.UpdateError):
            updater.parse_version("1.2")

    def test_release_asset_is_preferred_over_zipball(self):
        release = make_release()
        release["assets"] = [{"name": "mozarie-windows.zip", "browser_download_url": "https://example.test/asset.zip"}]
        self.assertEqual(updater.release_download_url(release), "https://example.test/asset.zip")

    def test_fetch_latest_release_validates_payload(self):
        payload = json.dumps(make_release()).encode()
        self.assertEqual(updater.fetch_latest_release(lambda *_args, **_kwargs: Response(payload))["tag_name"], "v1.2.0")
        with self.assertRaises(updater.UpdateError):
            updater.fetch_latest_release(lambda *_args, **_kwargs: Response(b"{}"))

    def test_safe_extract_accepts_github_wrapper_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "release.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                for name, data in {
                    "norqis-mozarie/server.py": "server",
                    "norqis-mozarie/run.bat": "run",
                    "norqis-mozarie/mozarie/core.py": "core",
                    "norqis-mozarie/static/app.js": "app",
                }.items():
                    bundle.writestr(name, data)
            source = updater.extract_archive(archive, root / "out")
            self.assertEqual(source.name, "norqis-mozarie")

    def test_safe_extract_rejects_traversal_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            traversal = root / "traversal.zip"
            with zipfile.ZipFile(traversal, "w") as bundle:
                bundle.writestr("../outside.txt", "bad")
            with self.assertRaises(updater.UpdateError):
                updater.extract_archive(traversal, root / "out1")

            symlink = root / "symlink.zip"
            info = zipfile.ZipInfo("root/link")
            info.external_attr = (0o120777 << 16)
            with zipfile.ZipFile(symlink, "w") as bundle:
                bundle.writestr(info, "target")
            with self.assertRaises(updater.UpdateError):
                updater.extract_archive(symlink, root / "out2")

    def test_apply_updates_code_and_preserves_user_data_and_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install = make_install(root / "install")
            source = make_source(root / "source")
            updater.apply_update(source, install)
            self.assertEqual((install / "server.py").read_text(encoding="utf-8"), "new server")
            self.assertEqual((install / "config/defaults.json").read_text(encoding="utf-8"), "{}")
            self.assertEqual((install / "config/local.json").read_text(encoding="utf-8"), '{"mine": true}')
            self.assertEqual((install / "models/model.onnx").read_bytes(), b"model")
            self.assertEqual((install / ".mozarie-cache/draft.bin").read_bytes(), b"draft")
            self.assertEqual((install / ".git/HEAD").read_text(encoding="utf-8"), "main")
            self.assertEqual((install / "update.bat").read_text(encoding="utf-8"), "stable entry")

    def test_apply_rolls_back_all_managed_files_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install = make_install(root / "install")
            source = make_source(root / "source")
            original_copy = updater._copy_path

            def fail_on_static(source_path: Path, destination: Path):
                if source_path == source / "static":
                    raise OSError("simulated failure")
                original_copy(source_path, destination)

            with patch("updater._copy_path", side_effect=fail_on_static):
                with self.assertRaises(updater.UpdateError):
                    updater.apply_update(source, install)
            self.assertEqual((install / "server.py").read_text(encoding="utf-8"), "old server")
            self.assertEqual((install / "mozarie/core.py").read_text(encoding="utf-8"), "old core")
            self.assertEqual((install / "static/app.js").read_text(encoding="utf-8"), "old app")

    def test_running_lock_is_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            process = app / ".mozarie-cache/process-test"
            process.mkdir(parents=True)
            lock_path = process / ".active.lock"
            with lock_path.open("w+b") as handle:
                handle.write(b"1")
                handle.flush()
                handle.seek(0)
                updater.msvcrt.locking(handle.fileno(), updater.msvcrt.LK_NBLCK, 1)
                try:
                    self.assertTrue(updater.is_mozarie_running(app))
                finally:
                    handle.seek(0)
                    updater.msvcrt.locking(handle.fileno(), updater.msvcrt.LK_UNLCK, 1)
            self.assertFalse(updater.is_mozarie_running(app))

    def test_current_and_cancelled_do_not_download_or_modify(self):
        with tempfile.TemporaryDirectory() as directory:
            app = make_install(Path(directory) / "install", "1.2.0")
            with patch("updater.fetch_latest_release", return_value=make_release("v1.2.0")), patch("updater.download_archive") as download:
                self.assertEqual(updater.perform_update(app), updater.EXIT_CURRENT)
                download.assert_not_called()

            (app / "VERSION").write_text("1.1.0", encoding="utf-8")
            with patch("updater.fetch_latest_release", return_value=make_release()), patch("updater.download_archive") as download:
                self.assertEqual(updater.perform_update(app, input_fn=lambda _prompt: "n"), updater.EXIT_CANCELLED)
                download.assert_not_called()

    def test_success_prints_plain_version_arrow(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = make_install(root / "install")
            source = make_source(root / "source")
            with patch("updater.fetch_latest_release", return_value=make_release()), \
                    patch("updater.download_archive"), \
                    patch("updater.extract_archive", return_value=source), \
                    patch("updater.install_requirements"), \
                    patch("updater.apply_update") as apply, \
                    patch("builtins.print") as output:
                result = updater.perform_update(app, input_fn=lambda _prompt: "y")
            self.assertEqual(result, updater.EXIT_UPDATED)
            apply.assert_called_once_with(source, app)
            messages = [call.args[0] for call in output.call_args_list if call.args]
            self.assertIn("v1.1.0 → v1.2.0", messages)
            self.assertIn("v1.1.0 から v1.2.0 へアップデートしました。", messages)
            self.assertEqual(messages.count("Mozarieを起動し直してください。"), 1)

    def test_update_batch_delegates_status_to_updater_and_never_starts_mozarie(self):
        batch_path = Path(__file__).parents[1] / "update.bat"
        raw = batch_path.read_bytes()
        batch = raw.decode("utf-8")
        self.assertIn("何かキーを押すと閉じます...", batch)
        self.assertIn("pause >nul", batch)
        self.assertEqual(batch.count('"%PYTHON%" %PYTHON_ARGS% "%APP_DIR%updater.py"'), 1)
        self.assertIn(
            '"%PYTHON%" %PYTHON_ARGS% "%APP_DIR%updater.py"\r\n'
            'set "EXIT_CODE=%ERRORLEVEL%"\r\n'
            "goto :finish",
            batch,
        )
        self.assertIn("exit /b %EXIT_CODE%", batch)
        self.assertNotIn('"%EXIT_CODE%"==', batch)
        self.assertEqual(batch.lower().count("pause"), 1)
        self.assertNotIn("アップデート", batch)
        self.assertNotIn("起動し直して", batch)
        self.assertNotIn("失敗しました", batch)
        self.assertNotIn("run.bat", batch.lower())
        self.assertIn(b"\r\n", raw)
        self.assertNotIn(b"\n", raw.replace(b"\r\n", b""))


if __name__ == "__main__":
    unittest.main()
