from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import string
import tempfile
import unittest
import zipfile
from pathlib import Path, PurePosixPath
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import updater


def make_release(tag: str = "v1.2.0", url: str = "https://example.test/release.zip") -> dict:
    return {"tag_name": tag, "immutable": True, "assets": [{
        "name": "mozarie.zip", "state": "uploaded", "browser_download_url": url,
        "digest": "sha256:" + "0" * 64, "size": 1,
    }]}


def make_source(root: Path, version: str = "1.2.0") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "VERSION").write_text(version, encoding="utf-8")
    (root / "server.py").write_text("new server", encoding="utf-8")
    (root / "run.bat").write_text("new run", encoding="utf-8")
    (root / "requirements.txt").write_text("Pillow\n", encoding="utf-8")
    (root / "README.md").write_text("new Japanese readme", encoding="utf-8")
    (root / "README.en.md").write_text("new English readme", encoding="utf-8")
    (root / "mozarie").mkdir()
    (root / "mozarie" / "core.py").write_text("new core", encoding="utf-8")
    (root / "static").mkdir()
    (root / "static" / "app.js").write_text("new app", encoding="utf-8")
    (root / "config").mkdir()
    (root / "config" / "defaults.json").write_text("{}", encoding="utf-8")
    (root / "update.bat").write_text("new updater entry", encoding="utf-8")
    (root / "setup.bat").write_text("new setup", encoding="utf-8")
    (root / ".gitattributes").write_text("* text=auto\n", encoding="utf-8")
    (root / ".gitignore").write_text("output/\n", encoding="utf-8")
    (root / "LICENSE").write_text("MIT", encoding="utf-8")
    (root / "THIRD_PARTY_NOTICES.md").write_text("notices", encoding="utf-8")
    for relative in updater.MANAGED_FILES:
        path = root / relative
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"new {relative}", encoding="utf-8")
    return root


def make_install(root: Path, version: str = "1.1.0") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "VERSION").write_text(version, encoding="utf-8")
    (root / "server.py").write_text("old server", encoding="utf-8")
    (root / "run.bat").write_text("old run", encoding="utf-8")
    (root / "requirements.txt").write_text("Pillow\n", encoding="utf-8")
    (root / "README.md").write_text("old Japanese readme", encoding="utf-8")
    (root / "README.en.md").write_text("old English readme", encoding="utf-8")
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


UPDATE_ARCHIVE_CONTENTS = {
    **{f"wrapper/{relative}": "file" for relative in updater.MANAGED_FILES},
    "wrapper/server.py": "server",
    "wrapper/run.bat": "run",
    "wrapper/VERSION": "1.2.0",
    "wrapper/mozarie/core.py": "core",
    "wrapper/static/app.js": "app",
}


def write_archive(archive: Path, contents: dict[str, str]) -> None:
    with zipfile.ZipFile(archive, "w") as bundle:
        for path, data in contents.items():
            bundle.writestr(path, data)


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        updater._language = "ja"

    def test_version_parsing_and_display(self):
        self.assertEqual(updater.parse_version("v1.2.3"), (1, 2, 3))
        self.assertEqual(updater.display_version("1.2.3"), "v1.2.3")
        with self.assertRaises(updater.UpdateError):
            updater.parse_version("1.2")

    def test_release_asset_must_be_the_immutable_mozarie_asset(self):
        release = make_release()
        release["assets"][0]["browser_download_url"] = "https://example.test/asset.zip"
        self.assertEqual(updater.release_archive(release)[0], "https://example.test/asset.zip")
        release["assets"][0]["name"] = "other.zip"
        with self.assertRaises(updater.UpdateError):
            updater.release_archive(release)

    def test_download_rejects_a_digest_or_size_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "release.zip"
            body = b"archive"
            digest = __import__("hashlib").sha256(body).hexdigest()
            updater.download_archive("https://example.test/release.zip", destination, digest, len(body), lambda *_args, **_kwargs: Response(body))
            with self.assertRaises(updater.UpdateError):
                updater.download_archive("https://example.test/release.zip", destination, "0" * 64, len(body), lambda *_args, **_kwargs: Response(body))
            with self.assertRaises(updater.UpdateError):
                updater.download_archive("https://example.test/release.zip", destination, digest, len(body) + 1, lambda *_args, **_kwargs: Response(body))

    def test_requirements_install_uses_the_app_venv_not_the_updater_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = make_source(root / "source")
            app = make_install(root / "app")
            python = app / ".venv" / "Scripts" / "python.exe"
            python.parent.mkdir(parents=True)
            python.touch()
            (source / "requirements.txt").write_text("new-dependency\n", encoding="utf-8")
            with patch("updater.subprocess.run") as run:
                run.return_value.returncode = 0
                updater.install_requirements(source, app)
            self.assertEqual(run.call_args.args[0][:3], [str(python), "-m", "pip"])

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
                for name, data in UPDATE_ARCHIVE_CONTENTS.items():
                    name = name.replace("wrapper/", "norqis-mozarie/", 1)
                    bundle.writestr(name, data)
            source = updater.extract_archive(archive, root / "out")
            self.assertEqual(source.name, "norqis-mozarie")

    def test_safe_extract_rejects_required_file_directories(self):
        for name in ("server.py", "run.bat", "VERSION"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / "release.zip"
                contents = UPDATE_ARCHIVE_CONTENTS.copy()
                contents.pop(f"wrapper/{name}")
                contents[f"wrapper/{name}/child"] = "not a required file"
                write_archive(archive, contents)
                with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("archive_missing_app"))):
                    updater.extract_archive(archive, root / "out")

    def test_safe_extract_rejects_required_directory_files(self):
        for name, content_path in (("mozarie", "mozarie/core.py"), ("static", "static/app.js")):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / "release.zip"
                contents = UPDATE_ARCHIVE_CONTENTS.copy()
                contents.pop(f"wrapper/{content_path}")
                contents[f"wrapper/{name}"] = "not a required directory"
                write_archive(archive, contents)
                with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("archive_missing_app"))):
                    updater.extract_archive(archive, root / "out")

    def test_safe_extract_rejects_missing_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "release.zip"
            contents = UPDATE_ARCHIVE_CONTENTS.copy()
            contents.pop("wrapper/VERSION")
            write_archive(archive, contents)
            with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("archive_missing_app"))):
                updater.extract_archive(archive, root / "out")

    def test_safe_extract_rejects_invalid_paths_without_writing_outside_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in (
                "G:escaped.txt",
                "C:/absolute",
                r"C:\absolute",
                "../outside.txt",
                r"..\outside.txt",
                "root/file:stream",
                "/absolute",
                "//server/share",
            ):
                with self.subTest(name=name):
                    archive = root / "invalid.zip"
                    with zipfile.ZipFile(archive, "w") as bundle:
                        bundle.writestr(name, "bad")
                    with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("archive_invalid_path"))):
                        updater.extract_archive(archive, root / "out")
                    self.assertFalse((root / "outside.txt").exists())
                    self.assertEqual(list(root.iterdir()), [archive])
                    archive.unlink()

    def test_safe_member_path_rejects_windows_reserved_names(self):
        for name in (
            "CON",
            "con.txt",
            "AUX.tar.gz",
            "nul ",
            "PRN.",
            "clock$.txt",
            "CONIN$",
            "conout$.log",
            "COM1",
            "com².txt",
            "LPT9",
            "lpt³.tar.gz",
            "COM1 .txt",
            "LPT9. ",
        ):
            with self.subTest(name=name):
                with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("archive_invalid_path"))):
                    updater._safe_member_path(zipfile.ZipInfo(f"root/{name}"))

    def test_safe_member_path_rejects_windows_forbidden_characters_and_controls(self):
        for name in ("less<than", "greater>than", 'quote"name', "pipe|name", "question?name", "star*name", "tab\tname", "control\x1fname"):
            with self.subTest(name=name):
                with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("archive_invalid_path"))):
                    updater._safe_member_path(zipfile.ZipInfo(f"root/{name}"))

    def test_safe_member_path_accepts_non_reserved_windows_names(self):
        for name in ("COM0", "COM10", "LPT0", "LPT10", "COM4work", ".config"):
            with self.subTest(name=name):
                self.assertEqual(updater._safe_member_path(zipfile.ZipInfo(f"root/{name}")), PurePosixPath(f"root/{name}"))

    def test_safe_extract_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            symlink = root / "symlink.zip"
            info = zipfile.ZipInfo("root/link")
            info.external_attr = (0o120777 << 16)
            with zipfile.ZipFile(symlink, "w") as bundle:
                bundle.writestr(info, "target")
            with self.assertRaises(updater.UpdateError):
                updater.extract_archive(symlink, root / "out")

    def test_safe_extract_rejects_precreated_directory_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "out"
            outside = root / "outside"
            output.mkdir()
            outside.mkdir()
            try:
                (output / "root").symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest("directory symlinks are unavailable")

            archive = root / "release.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("root/escaped.txt", "bad")
            with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("archive_invalid_path"))):
                updater.extract_archive(archive, output)
            self.assertFalse((outside / "escaped.txt").exists())

    def test_apply_updates_code_and_preserves_user_data_and_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install = make_install(root / "install")
            source = make_source(root / "source")
            backup = root / "backup"
            with patch("updater.tempfile.mkdtemp", return_value=str(backup)):
                updater.apply_update(source, install)
            self.assertEqual((install / "server.py").read_text(encoding="utf-8"), "new server")
            self.assertEqual((install / "README.md").read_text(encoding="utf-8"), "new Japanese readme")
            self.assertEqual((install / "README.en.md").read_text(encoding="utf-8"), "new English readme")
            self.assertEqual((install / "config/defaults.json").read_text(encoding="utf-8"), "{}")
            self.assertEqual((install / "config/local.json").read_text(encoding="utf-8"), '{"mine": true}')
            self.assertEqual((install / "models/model.onnx").read_bytes(), b"model")
            self.assertEqual((install / ".mozarie-cache/draft.bin").read_bytes(), b"draft")
            self.assertEqual((install / ".git/HEAD").read_text(encoding="utf-8"), "main")
            self.assertEqual((install / "update.bat").read_text(encoding="utf-8"), "new updater entry")
            self.assertFalse(backup.exists())

    def test_apply_backup_failure_leaves_install_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install = make_install(root / "install")
            source = make_source(root / "source")
            original_copy = updater._copy_path

            def fail_backing_up_server(source_path: Path, destination: Path):
                if source_path == install / "server.py":
                    raise OSError("simulated backup failure")
                original_copy(source_path, destination)

            backup = root / "backup"
            with patch("updater.tempfile.mkdtemp", return_value=str(backup)), \
                    patch("updater._copy_path", side_effect=fail_backing_up_server):
                with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("update_backup_failed"))):
                    updater.apply_update(source, install)
            self.assertEqual((install / "server.py").read_text(encoding="utf-8"), "old server")
            self.assertEqual((install / "mozarie/core.py").read_text(encoding="utf-8"), "old core")
            self.assertEqual((install / "static/app.js").read_text(encoding="utf-8"), "old app")
            self.assertFalse(backup.exists())

    def test_apply_rolls_back_only_mutated_files_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install = make_install(root / "install")
            source = make_source(root / "source")
            (install / "updater.py").write_text("old updater", encoding="utf-8")
            (source / "updater.py").write_text("new updater", encoding="utf-8")
            (source / "README.md").write_text("new readme", encoding="utf-8")
            original_copy = updater._copy_path

            def fail_on_static(source_path: Path, destination: Path):
                if source_path == source / "static":
                    raise OSError("simulated failure")
                original_copy(source_path, destination)

            backup = root / "backup"
            with patch("updater.tempfile.mkdtemp", return_value=str(backup)), \
                    patch("updater._copy_path", side_effect=fail_on_static):
                with self.assertRaises(updater.UpdateError):
                    updater.apply_update(source, install)
            self.assertEqual((install / "server.py").read_text(encoding="utf-8"), "old server")
            self.assertEqual((install / "mozarie/core.py").read_text(encoding="utf-8"), "old core")
            self.assertEqual((install / "static/app.js").read_text(encoding="utf-8"), "old app")
            self.assertEqual((install / "updater.py").read_text(encoding="utf-8"), "old updater")
            self.assertEqual((install / "README.md").read_text(encoding="utf-8"), "old Japanese readme")
            self.assertEqual((install / "README.en.md").read_text(encoding="utf-8"), "old English readme")
            self.assertFalse(backup.exists())

    def test_apply_preserves_backup_when_rollback_is_incomplete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install = make_install(root / "install")
            source = make_source(root / "source")
            backup = root / "backup"
            original_copy = updater._copy_path
            original_remove = updater._remove_path
            static_removals = 0

            def fail_during_update_and_restore(source_path: Path, destination: Path):
                if source_path == source / "static":
                    original_copy(source_path, destination)
                    raise OSError("simulated update failure")
                if source_path == backup / "static":
                    raise OSError("simulated restore-copy failure")
                original_copy(source_path, destination)

            def lock_static_on_rollback(path: Path):
                nonlocal static_removals
                if path == install / "static":
                    static_removals += 1
                    if static_removals == 2:
                        raise OSError("simulated locked file")
                original_remove(path)

            with patch("updater.tempfile.mkdtemp", return_value=str(backup)), \
                    patch("updater._copy_path", side_effect=fail_during_update_and_restore), \
                    patch("updater._remove_path", side_effect=lock_static_on_rollback):
                with self.assertRaisesRegex(
                    updater.UpdateError,
                    re.escape(updater.tr(
                        "update_rollback_incomplete", paths="static", backup=str(backup.resolve())
                    )),
                ):
                    updater.apply_update(source, install)

            self.assertEqual((install / "mozarie/core.py").read_text(encoding="utf-8"), "old core")
            self.assertEqual((install / "static/app.js").read_text(encoding="utf-8"), "new app")
            self.assertTrue(backup.is_dir())

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

    def test_read_language_prefers_valid_local_config_and_falls_back_safely(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            config = app / "config"
            config.mkdir()
            defaults = config / "defaults.json"
            local = config / "local.json"
            defaults.write_text('{"general": {"language": "en"}}', encoding="utf-8")
            local.write_text('{"general": {"language": "ja"}}', encoding="utf-8")
            self.assertEqual(updater.read_language(app), "ja")

            local.write_text('{"general": {"language": "invalid"}}', encoding="utf-8")
            self.assertEqual(updater.read_language(app), "en")

            for invalid_language in ([], {}):
                with self.subTest(invalid_language=invalid_language):
                    local.write_text(
                        json.dumps({"general": {"language": invalid_language}}), encoding="utf-8"
                    )
                    self.assertEqual(updater.read_language(app), "en")

            local.write_bytes(b"\xff")
            self.assertEqual(updater.read_language(app), "en")

            local.write_text("{", encoding="utf-8")
            defaults.write_text('{"general": []}', encoding="utf-8")
            self.assertEqual(updater.read_language(app), "ja")

            local.write_text('{"general": {"language": {}}}', encoding="utf-8")
            defaults.write_text('{"general": {"language": []}}', encoding="utf-8")
            self.assertEqual(updater.read_language(app), "ja")

    def test_i18n_message_keys_and_placeholders_match(self):
        self.assertEqual(set(updater.MESSAGES["ja"]), set(updater.MESSAGES["en"]))
        formatter = string.Formatter()
        for key in updater.MESSAGES["ja"]:
            ja_fields = {field for _, field, _, _ in formatter.parse(updater.MESSAGES["ja"][key]) if field}
            en_fields = {field for _, field, _, _ in formatter.parse(updater.MESSAGES["en"][key]) if field}
            self.assertEqual(ja_fields, en_fields, key)
            self.assertNotRegex(updater.MESSAGES["en"][key], r"[ぁ-んァ-ン一-龯]", key)

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

    def test_update_messages_use_the_configured_language(self):
        cases = {
            "ja": {
                "current": "現在最新バージョンです",
                "cancelled": "アップデートをキャンセルしました。",
                "confirm": "アップデートしますか？",
                "updated": "アップデートしました。",
                "running": "新しいバージョンがあります。",
                "error": "エラー: details",
                "opposite": (
                    "Mozarie is already up to date",
                    "Update cancelled.",
                    "Update Mozarie?",
                    "Updated from",
                    "A new version is available.",
                    "Error: details",
                ),
            },
            "en": {
                "current": "Mozarie is already up to date",
                "cancelled": "Update cancelled.",
                "confirm": "Update Mozarie?",
                "updated": "Updated from",
                "running": "A new version is available.",
                "error": "Error: details",
                "opposite": (
                    "現在最新バージョンです",
                    "アップデートをキャンセルしました。",
                    "アップデートしますか？",
                    "アップデートしました。",
                    "新しいバージョンがあります。",
                    "エラー: details",
                ),
            },
        }
        for language, expected in cases.items():
            with self.subTest(language=language), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                app = make_install(root / "install")
                (app / "config/local.json").write_text(
                    json.dumps({"general": {"language": language}}), encoding="utf-8"
                )

                def assert_no_opposite_language(messages: list[str]):
                    combined = "\n".join(messages)
                    for phrase in expected["opposite"]:
                        self.assertNotIn(phrase, combined)

                with patch("updater.fetch_latest_release", return_value=make_release("v1.1.0")), \
                        patch("builtins.print") as output:
                    self.assertEqual(updater.perform_update(app), updater.EXIT_CURRENT)
                current_messages = [call.args[0] for call in output.call_args_list if call.args]
                self.assertTrue(any(expected["current"] in message for message in current_messages))
                assert_no_opposite_language(current_messages)

                prompts: list[str] = []
                with patch("updater.fetch_latest_release", return_value=make_release()), \
                        patch("builtins.print") as output:
                    self.assertEqual(
                        updater.perform_update(app, input_fn=lambda prompt: prompts.append(prompt) or "n"),
                        updater.EXIT_CANCELLED,
                    )
                cancelled_messages = [call.args[0] for call in output.call_args_list if call.args]
                self.assertIn(expected["cancelled"], cancelled_messages)
                self.assertTrue(any(expected["confirm"] in prompt for prompt in prompts))
                assert_no_opposite_language(cancelled_messages + prompts)

                source = make_source(root / "source")
                with patch("updater.fetch_latest_release", return_value=make_release()), \
                        patch("updater.download_archive"), \
                        patch("updater.extract_archive", return_value=source), \
                        patch("updater.install_requirements"), \
                        patch("updater.apply_update"), \
                        patch("builtins.print") as output:
                    self.assertEqual(updater.perform_update(app, input_fn=lambda _prompt: "y"), updater.EXIT_UPDATED)
                success_messages = [call.args[0] for call in output.call_args_list if call.args]
                self.assertTrue(any(expected["updated"] in message for message in success_messages))
                assert_no_opposite_language(success_messages)

                with patch("updater.fetch_latest_release", return_value=make_release()), \
                        patch("updater.is_mozarie_running", return_value=True), \
                        self.assertRaisesRegex(updater.UpdateError, re.escape(expected["running"])) as raised:
                    updater.perform_update(app)
                assert_no_opposite_language([str(raised.exception)])

                updater._language = language
                with patch("updater.perform_update", side_effect=updater.UpdateError("details")), \
                        patch("builtins.print") as output:
                    self.assertEqual(updater.main(), updater.EXIT_ERROR)
                error_messages = [call.args[0] for call in output.call_args_list if call.args]
                self.assertIn(expected["error"], error_messages)
                assert_no_opposite_language(error_messages)

    def test_success_prints_plain_version_arrow(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = make_install(root / "install")
            (app / ".venv").mkdir()
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
            self.assertEqual((app / ".venv" / ".mozarie-ready").read_text(encoding="utf-8"), "ready\n")
            messages = [call.args[0] for call in output.call_args_list if call.args]
            self.assertIn("v1.1.0 → v1.2.0", messages)
            self.assertIn("v1.1.0 から v1.2.0 へアップデートしました。", messages)
            self.assertEqual(messages.count("Mozarieを起動し直してください。"), 1)

    def test_update_batch_delegates_status_to_updater_and_never_starts_mozarie(self):
        batch_path = Path(__file__).parents[1] / "update.bat"
        raw = batch_path.read_bytes()
        batch = raw.decode("utf-8")
        self.assertEqual(batch.count('"%PYTHON%" -X utf8 "%APP_DIR%updater.py"'), 1)
        self.assertIn(
            '"%PYTHON%" -X utf8 "%APP_DIR%updater.py"\r\n'
            'set "EXIT_CODE=%ERRORLEVEL%"\r\n'
            "goto :finish",
            batch,
        )
        self.assertIn("exit /b %EXIT_CODE%", batch)
        self.assertNotIn('"%EXIT_CODE%"==', batch)
        self.assertEqual(batch.lower().count("pause"), 1)
        self.assertRegex(batch, r"(?m)^pause\r?$")
        self.assertNotIn("pause >nul", batch)
        self.assertIn("MOZARIE_PYTHON is invalid. / MOZARIE_PYTHON が正しくありません。", batch)
        self.assertIn(
            "Python 3.11 or newer was not found. Run setup.bat, or set MOZARIE_PYTHON. / "
            "Python 3.11 以上が見つかりません。setup.batを実行するかMOZARIE_PYTHONを設定してください。",
            batch,
        )
        self.assertEqual(len(re.findall(r"(?mi)^echo (?!off$)", batch)), 2)
        self.assertNotIn("run.bat", batch.lower())
        self.assertIn("update.bat", updater.MANAGED_FILES)
        self.assertIn(b"\r\n", raw)
        self.assertNotIn(b"\n", raw.replace(b"\r\n", b""))

    def test_setup_checks_the_created_venv_python_version_before_pip(self):
        batch = (Path(__file__).parents[1] / "setup.bat").read_text(encoding="utf-8")
        version_check = '"%PYTHON%" -c "import struct, sys; raise SystemExit(0 if (3, 11) <= sys.version_info < (3, 15) and struct.calcsize(\'P\') == 8 else 1)"'
        self.assertIn(version_check, batch)
        install_index = batch.index('"%PYTHON%" -m pip install --disable-pip-version-check --progress-bar off --quiet --upgrade pip')
        self.assertLess(batch.index("call :validate_python"), install_index)

    def test_requirements_pin_the_official_cuda_runtime_without_replacing_pypi(self):
        requirements = (Path(__file__).parents[1] / "requirements.txt").read_text(encoding="utf-8").splitlines()
        self.assertIn("--extra-index-url https://download.pytorch.org/whl/cu130", requirements)
        self.assertIn("torch==2.13.0+cu130", requirements)
        self.assertIn("torchvision==0.28.0+cu130", requirements)
        self.assertIn("onnxruntime-gpu==1.27.0", requirements)
        self.assertNotIn("--index-url https://download.pytorch.org/whl/cu130", requirements)

    def test_setup_and_run_select_only_supported_64_bit_launchers(self):
        expected_loop = "for %%V in (3.14-64 3.13-64 3.12-64 3.11-64) do ("
        setup = (Path(__file__).parents[1] / "setup.bat").read_text(encoding="utf-8")
        run = (Path(__file__).parents[1] / "run.bat").read_text(encoding="utf-8")
        self.assertIn(expected_loop, setup)
        self.assertEqual(setup.count("py -%%V -m venv"), 1)
        self.assertIn('set "PYTHON=%APP_DIR%.venv\\Scripts\\python.exe"', setup)
        self.assertNotIn("python -m venv", setup)
        self.assertNotIn("MOZARIE_PYTHON", setup)
        self.assertIn('set "PYTHON=%APP_DIR%.venv\\Scripts\\python.exe"', run)
        self.assertIn('if defined MOZARIE_PYTHON goto :python_selected', run)
        self.assertNotIn("pip install", run)

    @unittest.skipUnless(os.name == "nt", "Windows batch behavior")
    def test_run_honors_explicit_mozarie_python_without_creating_a_venv(self):
        root_batch = Path(__file__).parents[1] / "run.bat"
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "app"
            app.mkdir()
            shutil.copy2(root_batch, app / "run.bat")
            marker = app / "server-ran.txt"
            (app / "server.py").write_text(
                f"from pathlib import Path; Path({str(marker)!r}).write_text('ok', encoding='utf-8')",
                encoding="utf-8",
            )
            environment = os.environ | {"MOZARIE_PYTHON": sys.executable}
            result = subprocess.run(["cmd.exe", "/d", "/c", str(app / "run.bat")], cwd=app, env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(marker.read_text(encoding="utf-8"), "ok")
            self.assertFalse((app / ".venv").exists())

    @unittest.skipUnless(os.name == "nt", "Windows batch behavior")
    def test_run_ready_environment_starts_without_setup_or_pip(self):
        root_batch = Path(__file__).parents[1] / "run.bat"
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "app"; app.mkdir()
            shutil.copy2(root_batch, app / "run.bat")
            python = app / ".venv" / "Scripts" / "python.exe"; python.parent.mkdir(parents=True)
            shutil.copy2(sys.executable, python)
            shutil.copy2(Path(sys.executable).parent.parent / "pyvenv.cfg", app / ".venv" / "pyvenv.cfg")
            (app / ".venv" / ".mozarie-ready").write_text("ready\n", encoding="utf-8")
            marker = app / "server-ran.txt"
            (app / "server.py").write_text(
                f"from pathlib import Path; Path({str(marker)!r}).write_text('ok', encoding='utf-8')",
                encoding="utf-8",
            )
            result = subprocess.run(["cmd.exe", "/d", "/c", str(app / "run.bat")], cwd=app, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(marker.read_text(encoding="utf-8"), "ok")
            self.assertNotIn("pip", result.stdout.lower())


if __name__ == "__main__":
    unittest.main()
