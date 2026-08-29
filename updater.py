from __future__ import annotations

import json
import hashlib
import hmac
import msvcrt
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from contextlib import AbstractContextManager
from pathlib import Path, PurePosixPath
from typing import Any, Callable


APP_DIR = Path(__file__).resolve().parent
RELEASE_API = "https://api.github.com/repos/norqis/mozarie/releases/latest"
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_FILES = 10_000

_WINDOWS_RESERVED_NAMES = frozenset({
    "CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "COM¹", "COM²", "COM³",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    "LPT¹", "LPT²", "LPT³",
})

MANAGED_DIRECTORIES = ("mozarie", "static")
MANAGED_FILES = (
    ".gitattributes",
    ".gitignore",
    "LICENSE",
    "README.en.md",
    "README.md",
    "requirements.txt",
    "run.bat",
    "setup.bat",
    "setup_gpu_check.py",
    "server.py",
    "THIRD_PARTY_NOTICES.md",
    "VERSION",
    "updater.py",
    "update.bat",
    "config/defaults.json",
)

EXIT_CURRENT = 0
EXIT_ERROR = 1
EXIT_UPDATED = 10
EXIT_CANCELLED = 20

MESSAGES = {
    "ja": {
        "version_invalid": "バージョン表記が正しくありません: {value!r}",
        "version_read": "VERSIONファイルを読み込めません。",
        "release_fetch": "GitHubから更新情報を取得できませんでした。",
        "release_invalid": "GitHubの更新情報が正しくありません。",
        "download_url": "ダウンロード先が見つかりません。",
        "download_digest": "GitHub Releaseの更新ファイル検証情報が正しくありません。",
        "archive_digest": "ダウンロードした更新ファイルのSHA-256が一致しません。",
        "archive_too_large": "更新ファイルが大きすぎます。",
        "downloading_progress": "ダウンロード中: {megabytes} MB",
        "archive_download": "更新ファイルをダウンロードできませんでした。",
        "archive_invalid_path": "更新ZIPに不正なパスが含まれています。",
        "archive_symlink": "更新ZIPにシンボリックリンクが含まれています。",
        "archive_invalid_count": "更新ZIPのファイル数が正しくありません。",
        "archive_extracted_too_large": "展開後の更新ファイルが大きすぎます。",
        "archive_extract": "更新ZIPを展開できませんでした。",
        "archive_missing_app": "更新ZIPにMozarie本体が見つかりません。",
        "requirements_updating": "依存関係を更新しています...",
        "requirements_failed": "依存関係の更新に失敗しました。Mozarie本体は更新していません。setup.bat を実行して復旧してください。",
        "runtime_profile_invalid": "既存の実行環境を安全に判定できません。Mozarie本体と依存関係は更新していません。setup.bat を実行して復旧してください。",
        "gpu_check_failed": "GPUの動作確認に失敗しました。setup.bat を実行して復旧してください。",
        "update_deps_changed": "更新は元に戻しましたが、依存関係は変更されています。setup.bat を実行してください。",
        "update_in_progress": "別の更新処理が実行中です。完了してからもう一度実行してください。",
        "update_missing_version": "更新ZIPにVERSIONファイルがありません。",
        "update_backup_failed": "更新前のバックアップを作成できなかったため、本体は変更していません。",
        "update_rollback": "更新に失敗したため、元のファイルへ戻しました。",
        "update_rollback_incomplete": "更新の取り消しが不完全です。次の項目を手動で復元してください: {paths}。バックアップ: {backup}",
        "current": "現在最新バージョンです ({version})。",
        "version_change": "{current} → {latest}",
        "running": "新しいバージョンがあります。先にMozarieを閉じて、もう一度 update.bat を実行してください。",
        "confirm": "アップデートしますか？ [y/N]: ",
        "cancelled": "アップデートをキャンセルしました。",
        "downloading": "更新ファイルをダウンロードしています...",
        "verifying": "更新ファイルを確認しています...",
        "archive_version_mismatch": "更新ZIPのバージョンがGitHub Releaseと一致しません。",
        "updating": "Mozarieを更新しています...",
        "updated": "{current} から {latest} へアップデートしました。",
        "restart": "Mozarieを起動し直してください。",
        "error": "エラー: {message}",
        "unexpected": "予期しないエラー: {message}",
    },
    "en": {
        "version_invalid": "Invalid version format: {value!r}",
        "version_read": "Could not read the VERSION file.",
        "release_fetch": "Could not retrieve update information from GitHub.",
        "release_invalid": "GitHub returned invalid update information.",
        "download_url": "No download URL was found.",
        "download_digest": "The GitHub Release update verification information is invalid.",
        "archive_digest": "The downloaded update archive SHA-256 does not match.",
        "archive_too_large": "The update archive is too large.",
        "downloading_progress": "Downloading: {megabytes} MB",
        "archive_download": "Could not download the update archive.",
        "archive_invalid_path": "The update archive contains an invalid path.",
        "archive_symlink": "The update archive contains a symbolic link.",
        "archive_invalid_count": "The update archive has an invalid file count.",
        "archive_extracted_too_large": "The extracted update is too large.",
        "archive_extract": "Could not extract the update archive.",
        "archive_missing_app": "The update archive does not contain Mozarie.",
        "requirements_updating": "Updating dependencies...",
        "requirements_failed": "Could not update dependencies. Mozarie was not changed. Run setup.bat to repair the installation.",
        "runtime_profile_invalid": "The existing runtime could not be identified safely. Mozarie and its dependencies were not updated. Run setup.bat to repair the installation.",
        "gpu_check_failed": "The GPU check failed. Run setup.bat to repair the installation.",
        "update_deps_changed": "The app was restored, but dependencies changed. Run setup.bat to repair the installation.",
        "update_in_progress": "Another update is already running. Wait for it to finish, then try again.",
        "update_missing_version": "The update archive does not contain a VERSION file.",
        "update_backup_failed": "Could not create a backup before updating. Mozarie was not changed.",
        "update_rollback": "The update failed, so the original files were restored.",
        "update_rollback_incomplete": "Rollback was incomplete. Restore these paths manually: {paths}. Backup: {backup}",
        "current": "Mozarie is already up to date ({version}).",
        "version_change": "{current} → {latest}",
        "running": "A new version is available. Close Mozarie, then run update.bat again.",
        "confirm": "Update Mozarie? [y/N]: ",
        "cancelled": "Update cancelled.",
        "downloading": "Downloading update files...",
        "verifying": "Verifying update files...",
        "archive_version_mismatch": "The update archive version does not match the GitHub release.",
        "updating": "Updating Mozarie...",
        "updated": "Updated from {current} to {latest}.",
        "restart": "Please restart Mozarie.",
        "error": "Error: {message}",
        "unexpected": "Unexpected error: {message}",
    },
}
_language = "ja"


def tr(key: str, **values: Any) -> str:
    return MESSAGES[_language][key].format(**values)


def read_language(app_dir: Path = APP_DIR) -> str:
    for relative in ("config/local.json", "config/defaults.json"):
        try:
            config = json.loads((app_dir / relative).read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        general = config.get("general") if isinstance(config, dict) else None
        language = general.get("language") if isinstance(general, dict) else None
        if isinstance(language, str) and language in MESSAGES:
            return language
    return "ja"


class UpdateError(RuntimeError):
    pass


class MaintenanceLock(AbstractContextManager["MaintenanceLock"]):
    """Keep setup, update, and the running application mutually exclusive."""

    def __init__(self, app_dir: Path) -> None:
        self.path = app_dir / ".mozarie-cache" / ".maintenance.lock"
        self.handle: Any | None = None

    def __enter__(self) -> "MaintenanceLock":
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.handle = self.path.open("a+b")
            self.handle.seek(0)
            if not self.handle.read(1):
                self.handle.seek(0)
                self.handle.write(b"0")
                self.handle.flush()
            self.handle.seek(0)
            msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            self.close()
            raise UpdateError(tr("update_in_progress")) from exc
        return self

    def close(self) -> None:
        if self.handle is None:
            return
        try:
            self.handle.seek(0)
            msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        self.handle.close()
        self.handle = None

    def __exit__(self, *_args: Any) -> None:
        self.close()


def parse_version(value: str) -> tuple[int, int, int]:
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", value.strip())
    if not match:
        raise UpdateError(tr("version_invalid", value=value))
    return tuple(int(part) for part in match.groups())


def display_version(value: str) -> str:
    major, minor, patch = parse_version(value)
    return f"v{major}.{minor}.{patch}"


def read_local_version(app_dir: Path = APP_DIR) -> str:
    path = app_dir / "VERSION"
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise UpdateError(tr("version_read")) from exc


def fetch_latest_release(opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    request = urllib.request.Request(
        RELEASE_API,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "Mozarie-Updater",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with opener(request, timeout=30) as response:
            payload = json.load(response)
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        raise UpdateError(tr("release_fetch")) from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("tag_name"), str):
        raise UpdateError(tr("release_invalid"))
    parse_version(payload["tag_name"])
    return payload


def release_archive(release: dict[str, Any]) -> tuple[str, str, int]:
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise UpdateError(tr("download_url"))
    matches = [asset for asset in assets if isinstance(asset, dict) and asset.get("name") == "mozarie.zip"]
    if len(matches) != 1:
        raise UpdateError(tr("download_url"))
    asset = matches[0]
    url, digest, size = asset.get("browser_download_url"), asset.get("digest"), asset.get("size")
    if release.get("immutable") is not True or asset.get("state") != "uploaded" or not isinstance(url, str) or not url.startswith("https://"):
        raise UpdateError(tr("download_url"))
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise UpdateError(tr("download_digest"))
    if not isinstance(size, int) or size < 1 or size > MAX_ARCHIVE_BYTES:
        raise UpdateError(tr("archive_too_large"))
    return url, digest.removeprefix("sha256:"), size


def download_archive(url: str, destination: Path, expected_digest: str, expected_size: int,
                     opener: Callable[..., Any] = urllib.request.urlopen) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozarie-Updater"})
    try:
        with opener(request, timeout=60) as response, destination.open("wb") as output:
            total = 0
            digest = hashlib.sha256()
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_ARCHIVE_BYTES:
                    raise UpdateError(tr("archive_too_large"))
                output.write(chunk)
                digest.update(chunk)
                print(f"\r{tr('downloading_progress', megabytes=total // 1024 // 1024)}", end="", flush=True)
    except UpdateError:
        raise
    except (OSError, urllib.error.URLError) as exc:
        raise UpdateError(tr("archive_download")) from exc
    if total != expected_size:
        raise UpdateError(tr("archive_download"))
    if not hmac.compare_digest(digest.hexdigest(), expected_digest):
        raise UpdateError(tr("archive_digest"))
    print()


def _safe_member_path(info: zipfile.ZipInfo) -> PurePosixPath:
    name = info.filename
    if not name or "\x00" in name or "\\" in name:
        raise UpdateError(tr("archive_invalid_path"))
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in {"", ".", ".."} or ":" in part for part in path.parts):
        raise UpdateError(tr("archive_invalid_path"))
    for part in path.parts:
        if any(ord(char) < 32 or char in '<>:"|?*' for char in part):
            raise UpdateError(tr("archive_invalid_path"))
        basename = part.split(".", maxsplit=1)[0].rstrip(" .")
        if part.endswith((" ", ".")) or basename.upper() in _WINDOWS_RESERVED_NAMES:
            raise UpdateError(tr("archive_invalid_path"))
    mode = info.external_attr >> 16
    if stat.S_ISLNK(mode):
        raise UpdateError(tr("archive_symlink"))
    return path


def extract_archive(archive: Path, destination: Path) -> Path:
    try:
        destination_root = destination.resolve()
        with zipfile.ZipFile(archive) as bundle:
            infos = bundle.infolist()
            if not infos or len(infos) > MAX_ARCHIVE_FILES:
                raise UpdateError(tr("archive_invalid_count"))
            if sum(info.file_size for info in infos) > MAX_ARCHIVE_BYTES:
                raise UpdateError(tr("archive_extracted_too_large"))
            for info in infos:
                relative = _safe_member_path(info)
                target = destination_root.joinpath(*relative.parts).resolve()
                if not target.is_relative_to(destination_root):
                    raise UpdateError(tr("archive_invalid_path"))
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(info) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
    except UpdateError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        raise UpdateError(tr("archive_extract")) from exc

    children = list(destination_root.iterdir())
    if len(children) != 1 or not children[0].is_dir():
        raise UpdateError(tr("archive_missing_app"))
    source_root = children[0]
    required_files = tuple(source_root / relative for relative in MANAGED_FILES)
    required_directories = tuple(source_root / relative for relative in MANAGED_DIRECTORIES)
    if not all(path.is_file() for path in required_files) or not all(path.is_dir() for path in required_directories):
        raise UpdateError(tr("archive_missing_app"))
    return source_root


def is_mozarie_running(app_dir: Path = APP_DIR) -> bool:
    cache_root = app_dir / ".mozarie-cache"
    if not cache_root.is_dir():
        return False
    for process_dir in cache_root.glob("process-*"):
        lock_path = process_dir / ".active.lock"
        if not lock_path.is_file():
            continue
        try:
            with lock_path.open("a+b") as handle:
                handle.seek(0)
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                except OSError:
                    return True
                else:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            return True
    return False


def install_requirements(source_root: Path, app_dir: Path = APP_DIR) -> bool:
    if not any((source_root / name).is_file() for name in ("requirements.txt", "mozarie/requirements-directml.txt", "mozarie/requirements-cpu.txt")):
        return False
    profile = _installed_runtime_profile(app_dir)
    relative = {
        "directml": "mozarie/requirements-directml.txt",
        "cpu": "mozarie/requirements-cpu.txt",
    }.get(profile, "requirements.txt")
    incoming = source_root / relative
    current = app_dir / relative
    if not incoming.is_file():
        return False
    if current.is_file() and incoming.read_bytes() == current.read_bytes():
        return False
    python = app_dir / ".venv" / "Scripts" / "python.exe"
    validator = source_root / "mozarie" / "runtime_profile.py"
    _verify_installed_runtime_profile(app_dir, python, validator, profile)
    print(tr("requirements_updating"))
    (app_dir / ".venv" / ".mozarie-ready").unlink(missing_ok=True)
    result = subprocess.run(
        [str(python), "-m", "pip", "install", "--disable-pip-version-check", "--progress-bar", "on", "-r", str(incoming)],
        cwd=str(app_dir),
        check=False,
    )
    if result.returncode != 0:
        raise UpdateError(tr("requirements_failed"))
    result = subprocess.run(
        [str(python), "-m", "pip", "check"],
        cwd=str(app_dir),
        check=False,
    )
    if result.returncode != 0:
        raise UpdateError(tr("requirements_failed"))
    result = subprocess.run(
        [str(python), str(validator), "validate", profile, "--venv", str(app_dir / ".venv")],
        cwd=str(app_dir),
        check=False,
    )
    if result.returncode != 0:
        raise UpdateError(tr("requirements_failed"))
    return True


def run_gpu_smoke(app_dir: Path = APP_DIR) -> None:
    """Verify the just-installed runtime before marking an updated venv ready."""
    python = app_dir / ".venv" / "Scripts" / "python.exe"
    check = app_dir / "setup_gpu_check.py"
    if not python.is_file() or not check.is_file():
        raise UpdateError(tr("gpu_check_failed"))
    result = subprocess.run(
        [str(python), "-X", "utf8", str(check)],
        cwd=str(app_dir),
        check=False,
    )
    if result.returncode != 0:
        raise UpdateError(tr("gpu_check_failed"))


def _installed_runtime_profile(app_dir: Path) -> str:
    marker = app_dir / ".venv" / ".mozarie-runtime.json"
    if not marker.is_file():
        raise UpdateError(tr("runtime_profile_invalid"))
    try:
        value = json.loads(marker.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or value.get("schema") != 1:
            raise ValueError("unsupported runtime marker schema")
        profile = value.get("profile")
        if not isinstance(profile, str) or profile not in {"cuda", "directml", "cpu"}:
            raise ValueError("invalid runtime marker profile")
    except (OSError, ValueError, TypeError):
        raise UpdateError(tr("runtime_profile_invalid")) from None
    return profile


def _verify_installed_runtime_profile(app_dir: Path, python: Path, validator: Path, profile: str) -> None:
    """Reject an ambiguous or mismatched venv before pip can mutate it."""
    if not python.is_file() or not validator.is_file():
        raise UpdateError(tr("runtime_profile_invalid"))
    result = subprocess.run(
        [str(python), str(validator), "preflight", profile, "--venv", str(app_dir / ".venv")],
        cwd=str(app_dir),
        check=False,
    )
    if result.returncode != 0:
        raise UpdateError(tr("runtime_profile_invalid"))


def _remove_path(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def _copy_path(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, destination)
    else:
        shutil.copy2(source, destination)


def apply_update(source_root: Path, app_dir: Path = APP_DIR) -> None:
    managed = [*MANAGED_DIRECTORIES, *MANAGED_FILES]
    if any(not (source_root / relative).exists() for relative in managed):
        raise UpdateError(tr("archive_missing_app"))
    incoming = managed

    backup_root: Path | None = None
    backed_up: set[str] = set()
    try:
        backup_root = Path(tempfile.mkdtemp(prefix="mozarie-backup-", dir=app_dir.parent))
        for relative in incoming:
            current = app_dir / relative
            if current.exists():
                _copy_path(current, backup_root / relative)
                backed_up.add(relative)
    except Exception as exc:
        if backup_root is not None:
            try:
                shutil.rmtree(backup_root)
            except OSError:
                pass
        raise UpdateError(tr("update_backup_failed")) from exc

    assert backup_root is not None

    mutated: list[str] = []
    try:
        for relative in incoming:
            mutated.append(relative)
            current = app_dir / relative
            if current.exists():
                _remove_path(current)
            _copy_path(source_root / relative, current)
    except Exception as exc:
        rollback_failures: list[str] = []
        for relative in reversed(mutated):
            current = app_dir / relative
            if current.exists():
                try:
                    _remove_path(current)
                except Exception:
                    rollback_failures.append(relative)
            if relative in backed_up:
                try:
                    _copy_path(backup_root / relative, current)
                except Exception:
                    rollback_failures.append(relative)

        if rollback_failures:
            paths = ", ".join(dict.fromkeys(rollback_failures))
            raise UpdateError(
                tr("update_rollback_incomplete", paths=paths, backup=str(backup_root.resolve()))
            ) from exc

        try:
            shutil.rmtree(backup_root)
        except OSError:
            pass
        raise UpdateError(tr("update_rollback")) from exc

    try:
        shutil.rmtree(backup_root)
    except OSError:
        pass


def _perform_update(
    app_dir: Path = APP_DIR,
    *,
    opener: Callable[..., Any] = urllib.request.urlopen,
    input_fn: Callable[[str], str] = input,
) -> int:
    global _language
    _language = read_language(app_dir)
    current_raw = read_local_version(app_dir)
    release = fetch_latest_release(opener)
    latest_raw = release["tag_name"]
    current = display_version(current_raw)
    latest = display_version(latest_raw)

    if parse_version(latest_raw) <= parse_version(current_raw):
        print(tr("current", version=current))
        return EXIT_CURRENT

    if is_mozarie_running(app_dir):
        raise UpdateError(tr("running"))

    print(tr("version_change", current=current, latest=latest))
    answer = input_fn(tr("confirm")).strip().lower()
    if answer not in {"y", "yes"}:
        print(tr("cancelled"))
        return EXIT_CANCELLED

    with tempfile.TemporaryDirectory(prefix="mozarie-update-") as temporary:
        workspace = Path(temporary)
        archive = workspace / "release.zip"
        extracted = workspace / "extracted"
        extracted.mkdir()
        print(tr("downloading"))
        url, digest, size = release_archive(release)
        download_archive(url, archive, digest, size, opener)
        print(tr("verifying"))
        source_root = extract_archive(archive, extracted)
        archive_version = read_local_version(source_root)
        if parse_version(archive_version) != parse_version(latest_raw):
            raise UpdateError(tr("archive_version_mismatch"))
        requirements_updated = install_requirements(source_root, app_dir)
        print(tr("updating"))
        try:
            apply_update(source_root, app_dir)
        except UpdateError as exc:
            if requirements_updated:
                raise UpdateError(tr("update_deps_changed")) from exc
            raise
        if requirements_updated is True:
            run_gpu_smoke(app_dir)
            ready_marker = app_dir / ".venv" / ".mozarie-ready"
            if ready_marker.parent.is_dir():
                ready_marker.write_text("ready\n", encoding="utf-8")

    print(tr("version_change", current=current, latest=latest))
    print(tr("updated", current=current, latest=latest))
    print(tr("restart"))
    return EXIT_UPDATED


def perform_update(
    app_dir: Path = APP_DIR,
    *,
    opener: Callable[..., Any] = urllib.request.urlopen,
    input_fn: Callable[[str], str] = input,
) -> int:
    global _language
    _language = read_language(app_dir)
    with MaintenanceLock(app_dir):
        return _perform_update(app_dir, opener=opener, input_fn=input_fn)


def main() -> int:
    if sys.argv[1:] == ["--run-setup-locked"]:
        try:
            with MaintenanceLock(APP_DIR):
                return subprocess.run(["cmd", "/d", "/c", str(APP_DIR / "setup.bat"), "--locked"], cwd=str(APP_DIR), check=False).returncode
        except UpdateError as exc:
            print(tr("error", message=exc), file=sys.stderr)
            return EXIT_ERROR
    if sys.argv[1:] == ["--check-running"]:
        return 30 if is_mozarie_running(APP_DIR) else 0
    try:
        return perform_update()
    except KeyboardInterrupt:
        print(f"\n{tr('cancelled')}")
        return EXIT_CANCELLED
    except UpdateError as exc:
        print(tr("error", message=exc), file=sys.stderr)
        return EXIT_ERROR
    except Exception as exc:
        print(tr("unexpected", message=exc), file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
